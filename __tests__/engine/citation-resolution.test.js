import { describe, it, expect } from 'vitest';
import areasData from '../../data/assessmentAreas.json' with { type: 'json' };

/**
 * Citation resolution.
 *
 * ROOT CAUSE this closes. The legacy plan that produced these citations
 * (`toolkit-process/docs/harvested-research/2026-05-23-phase2-research-references.md`,
 * Task 6) ran a pre-publication checker. It iterated `ref['url']` and never
 * `ref['doi']`, and it iterated `d['areas']` and never the controls. All
 * three defect classes found on 2026-08-18 walked through it untouched:
 *
 *   - PP-03's DOI named a different paper, but its PMLR URL resolved
 *   - IP-07's DOI was unregistered, but its NeurIPS URL resolved
 *   - the dead African Union link sat on C-20, a control, never examined
 *
 * The bar the plan stated was "must have a working URL". The obligation is
 * "the identifier names the work being cited".
 *
 * TWO THINGS THIS FILE IS CAREFUL ABOUT, both learned by getting them wrong
 * on the first attempt:
 *
 * 1. Existence is checked through `doi.org/doiRA`, which answers for EVERY
 *    registration agency. A Crossref-only check reports DataCite DOIs as
 *    nonexistent -- IP-04's LIPIcs DOI and all three arXiv DOIs are DataCite,
 *    and a Crossref lookup 404s on every one of them.
 * 2. An HTTP 403 or 429 is recorded as INCONCLUSIVE, never as broken. Every
 *    `doi.org` link here answers 403 to a scripted request, browser
 *    user-agent or not; calling those failures would fail the suite on
 *    perfectly good links. A check that cries wolf gets ignored, which is
 *    the failure mode this file exists to prevent.
 *
 * OPT-IN, because it needs the public internet:
 *
 *     CHECK_CITATIONS=1 npx vitest run __tests__/engine/citation-resolution.test.js
 */

const ENABLED = process.env.CHECK_CITATIONS === '1';
const TIMEOUT = 180_000;

/** Every reference in the bundle -- areas AND controls, the half Task 6 missed. */
function allReferences() {
  const out = [];
  for (const area of areasData.areas ?? []) {
    for (const ref of area.references ?? []) out.push({ owner: area.id, ...ref });
  }
  for (const control of areasData.controls ?? []) {
    for (const res of control.resources ?? []) {
      if (res && typeof res === 'object' && res.url) out.push({ owner: control.id, ...res });
    }
  }
  return out;
}

function titlesAgree(citation, title) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  const cited = new Set(norm(citation));
  const words = norm(title).filter((w) => w.length > 3);
  if (!words.length) return false;
  return words.filter((w) => cited.has(w)).length / words.length >= 0.6;
}

async function titleFor(doi) {
  for (const [url, pick] of [
    [`https://api.crossref.org/works/${doi}`, (j) => j?.message?.title?.[0]],
    [`https://api.datacite.org/dois/${encodeURIComponent(doi)}`, (j) => j?.data?.attributes?.titles?.[0]?.title],
  ]) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const title = pick(await res.json());
      if (title) return title;
    } catch { /* try the next agency */ }
  }
  return null;
}

/**
 * Always-on and offline: `doi` must hold a DOI. Three areas held values like
 * `arXiv:2103.14749`, which is an arXiv id, not a DOI. That never reached a
 * user -- ReferencesList gates its DOI badge on `startsWith('10.')` -- but it
 * silently exempted those three from every DOI check ever written, including
 * the one below.
 */
describe('the doi field holds DOIs', () => {
  it('has no reference whose doi is some other kind of identifier', () => {
    const wrong = allReferences()
      .filter((r) => r.doi && !r.doi.startsWith('10.'))
      .map((r) => `${r.owner}: doi = "${r.doi}"`);

    expect(wrong).toEqual([]);
  });
});

describe.skipIf(!ENABLED)('every DOI resolves to the work its citation names', () => {
  it('finds no unregistered DOI', async () => {
    const dois = allReferences().filter((r) => r.doi);
    expect(dois.length).toBeGreaterThan(0);

    const missing = [];
    for (const ref of dois) {
      const res = await fetch(`https://doi.org/doiRA/${ref.doi}`);
      const agency = (await res.json())?.[0];
      if (!agency?.RA) missing.push(`${ref.owner}: ${ref.doi} -- ${agency?.status ?? 'no agency'}`);
    }

    expect(missing).toEqual([]);
  }, TIMEOUT);

  it('finds no DOI whose registered title its citation does not name', async () => {
    const dois = allReferences().filter((r) => r.doi);
    const mismatched = [];
    const unverifiable = [];

    for (const ref of dois) {
      const title = await titleFor(ref.doi);
      if (!title) unverifiable.push(`${ref.owner}: ${ref.doi}`);
      else if (!titlesAgree(ref.citation ?? ref.title ?? '', title)) {
        mismatched.push(`${ref.owner}: ${ref.doi} is registered as "${title}"`);
      }
    }

    // Reported, not asserted: no metadata served is not evidence of a wrong paper.
    if (unverifiable.length) console.warn(`no metadata served for: ${unverifiable.join(', ')}`);
    expect(mismatched).toEqual([]);
  }, TIMEOUT);
});

describe.skipIf(!ENABLED)('every published link is reachable', () => {
  it('finds no dead reference URL, in an area OR a control', async () => {
    const urls = allReferences().filter((r) => r.url?.startsWith('http'));
    expect(urls.length).toBeGreaterThan(0);

    const dead = [];
    const blocked = [];

    for (const ref of urls) {
      let status = 0;
      for (const method of ['HEAD', 'GET']) {
        try {
          const res = await fetch(ref.url, { method, redirect: 'follow' });
          status = res.status;
          if (res.ok) break;
        } catch { status = 0; }
      }
      if (status === 403 || status === 429) blocked.push(`${ref.owner}: ${ref.url} -> ${status}`);
      else if (status === 0 || status >= 400) dead.push(`${ref.owner}: ${ref.url} -> ${status || 'unreachable'}`);
    }

    if (blocked.length) console.warn(`inconclusive (bot-blocked, not dead): ${blocked.length} link(s)`);
    expect(dead).toEqual([]);
  }, TIMEOUT);
});
