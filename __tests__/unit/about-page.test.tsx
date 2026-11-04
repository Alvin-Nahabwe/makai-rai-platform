import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { readCreditLine } from '@/lib/credit';
import { CLAIMS } from '@/lib/claims/pattern';

/**
 * The page and the credit line read their files with `readFileSync`. The mock
 * delegates to the real one, so every case but the hostile-address one reads
 * the committed files.
 */
const fsMock = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMock.readFileSync.mockImplementation(actual.readFileSync);
  return { ...actual, default: actual, readFileSync: fsMock.readFileSync };
});

import AboutPage, { metadata } from '@/app/(public)/about/page';

/**
 * S-28, the public About page (FR-PUB-01, FR-PUB-02, FR-PUB-04, FR-PUB-05, UX-03).
 *
 * `AboutPage` is a server component with no hooks, so it renders to static
 * markup under vitest's `environment: 'node'`. The axe and keyboard checks of
 * the same page need a browser and are in `e2e/about.spec.ts`.
 */

const html = renderToStaticMarkup(<AboutPage />);

/** Markup to plain text: tags dropped, the four entities React writes decoded. */
const plain = (s: string): string =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const text = plain(html);

/** The markup of one section: from the `<h2>` that carries the id to the next `<h2>`. */
function section(markup: string, id: string): string {
  const at = markup.search(new RegExp(`<h2[^>]*id="${id}"`));
  if (at === -1) throw new Error(`no <h2 id="${id}"> on the About page`);
  const rest = markup.slice(at + 1);
  const next = rest.search(/<h2[\s>]/);
  return next === -1 ? markup.slice(at) : markup.slice(at, at + 1 + next);
}

/** Drops every element that carries `data-claims-allowed`, balancing nested tags of the same name. */
function stripClaimsAllowed(markup: string): string {
  let out = markup;
  const open = /<([a-z][a-z0-9]*)\b[^>]*\sdata-claims-allowed="[^"]*"[^>]*>/i;
  for (;;) {
    const m = open.exec(out);
    if (!m) return out;
    const tag = m[1];
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    re.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = re.lastIndex;
    for (let t = re.exec(out); t && depth > 0; t = depth > 0 ? re.exec(out) : null) {
      depth += t[1] ? -1 : 1;
      end = re.lastIndex;
    }
    if (depth !== 0) throw new Error(`unbalanced <${tag}> inside a data-claims-allowed element`);
    out = out.slice(0, m.index) + out.slice(end);
  }
}

const helpContact = (): { email: string | null } =>
  JSON.parse(readFileSync('data/help-contact.json', 'utf8'));
const PENDING = 'The Help and contact address is published before the platform opens to teams.';
const helpEmailOrPendingText = (): string => {
  const { email } = helpContact();
  return email === null ? PENDING : email;
};

/** Renders the page as if the data file whose name ends in `suffix` held `content`. */
function renderWithFile(suffix: string, content: string): string {
  const real = fsMock.readFileSync.getMockImplementation()!;
  fsMock.readFileSync.mockImplementation(((path: unknown, ...rest: unknown[]) =>
    String(path).endsWith(suffix)
      ? content
      : (real as (...a: unknown[]) => unknown)(path, ...rest)) as typeof real);
  try {
    return renderToStaticMarkup(<AboutPage />);
  } finally {
    fsMock.readFileSync.mockImplementation(real);
  }
}

const renderWithHelpContact = (content: string): string => renderWithFile('help-contact.json', content);

describe('S-28 About page', () => {
  it('FR-PUB-05: the About page has the section "Why there is no score"', () => {
    expect(html).toMatch(/<h2[^>]*id="why-no-score"[^>]*>Why there is no score<\/h2>/);
  });

  it("FR-PUB-04: the About page says the platform never runs evaluations, models, notebooks or uploaded files and never computes metrics from a team's data", () => {
    const s = plain(section(html, 'never-runs'));
    for (const w of ['evaluations', 'models', 'notebooks', 'uploaded files', 'metrics']) {
      expect(s).toContain(w);
    }
    expect(s).toMatch(/never runs evaluations, models, notebooks or uploaded files/);
    expect(s).toMatch(/never computes metrics from your team's data/);
  });

  it('FR-PUB-01: the About page says who can see records, and never that MAK-AI cannot', () => {
    expect(text).toContain("MAK-AI's administrator has no access to records in the application");
    expect(text).toContain('the operator who runs the server has technical access to the database');
    expect(text).not.toMatch(/cannot see your records/i);
  });

  it('FR-PUB-02: the About page carries the credit line read from the file', () => {
    const credit = readCreditLine();
    const s = plain(section(html, 'credit'));
    expect(s).toContain(credit.text);
    expect(section(html, 'credit')).toContain(`href="${credit.href}"`);
  });

  it('UX-03 NFR-A11Y-04: Help and contact gives the address, asks for the support reference, and says never to send record text', () => {
    const s = plain(section(html, 'help-and-contact'));
    expect(s).toMatch(/support reference/i);
    expect(s).toMatch(/never send record text|do not send record text/i);
    expect(s).toContain(helpEmailOrPendingText());
  });

  it('FR-PUB-01 FR-PUB-05: every sentence that names a score sits inside a data-claims-allowed element', () => {
    expect(text).toMatch(/\bscores?\b/i);
    const outside = plain(stripClaimsAllowed(html));
    expect(outside).not.toMatch(/\bscores?\b/i);
    // The strip removed something, so the check above is not vacuous.
    expect(outside.length).toBeLessThan(text.length);
  });

  it('FR-PUB-05: the allowed elements are the section "Why there is no score" and the two sentences about a model\'s own scores', () => {
    const reasons = [...html.matchAll(/data-claims-allowed="([^"]*)"/g)].map((m) => m[1]);
    expect(reasons).toContain('why-no-score');
    expect(reasons.filter((r) => r === 'about-model-scores')).toHaveLength(2);
    expect(plain(html.match(/<[a-z0-9]+[^>]*data-claims-allowed="about-model-scores"[^>]*>[\s\S]*?<\/[a-z0-9]+>/)![0])).toMatch(
      /accuracy score|confidence score/,
    );
  });

  it('FR-PUB-05 FR-PUB-01: the marker covers the heading only; the explanation and "What you get instead" are checked like any other text', () => {
    const reasons = [...html.matchAll(/data-claims-allowed="([^"]*)"/g)].map((m) => m[1]);
    expect(reasons.filter((r) => r === 'why-no-score')).toHaveLength(1);
    const outside = plain(stripClaimsAllowed(html));
    expect(outside).toContain('What you get instead');
    expect(outside, 'the explanation holds no flagged word, so it needs no marker').toContain('Earlier versions of this tool');
    expect(outside, 'the heading names a score and is inside the marker').not.toContain('Why there is no score');
  });

  it('FR-PUB-01 FR-PUB-05: every marked element holds exactly one allow-listed sentence, and each sentence is marked once', () => {
    // SRS 7.5.3: "the only exceptions are these exact sentences". A marker may not shelter any other text.
    const marked: string[] = [];
    const open = /<([a-z][a-z0-9]*)\b[^>]*\sdata-claims-allowed="[^"]*"[^>]*>/gi;
    for (let m = open.exec(html); m; m = open.exec(html)) {
      const re = new RegExp(`<(/?)${m[1]}\\b[^>]*>`, 'gi');
      re.lastIndex = m.index + m[0].length;
      let depth = 1;
      let end = re.lastIndex;
      for (let t = re.exec(html); t && depth > 0; t = depth > 0 ? re.exec(html) : null) {
        depth += t[1] ? -1 : 1;
        end = t.index;
      }
      marked.push(plain(html.slice(m.index + m[0].length, end)));
    }
    expect(marked.sort()).toEqual(
      [
        'Why there is no score',
        'It is not an approval, audit, certification or compliance service, and nothing it produces is one.',
        'A healthcare algorithm that works well on average but works poorly for Black patients produces real harm, regardless of its overall accuracy score.',
        "A clinician who treats a model's 60% confidence score as certainty will make worse decisions than one who understands the margin of error.",
      ].sort(),
    );
  });

  it('FR-PUB-01: a model-score sentence holds no banned word besides "accuracy score" and "60% confidence score"', () => {
    for (const m of html.matchAll(/<span[^>]*data-claims-allowed="about-model-scores"[^>]*>([\s\S]*?)<\/span>/g)) {
      const rest = plain(m[1]).replace(/accuracy score|(60% )?confidence score/g, '');
      expect(rest, rest).not.toMatch(CLAIMS);
    }
  });

  it('FR-PUB-05: the platform states what it is not, in the exact allow-listed sentence', () => {
    expect(text).toContain(
      'It is not an approval, audit, certification or compliance service, and nothing it produces is one.',
    );
    const reasons = [...html.matchAll(/data-claims-allowed="([^"]*)"/g)].map((m) => m[1]);
    expect(reasons).toContain('not-an-approval-service');
  });

  it('FR-PUB-04 UX-03: the seal section says what a seal does not prove and keeps the exact timestamp sentence', () => {
    const s = plain(section(html, 'what-a-seal-proves'));
    expect(s).toContain('Sealed by the platform; not independently time-stamped.');
    expect(s).toMatch(/does not prove/);
  });

  it('UX-03: the free toolkits section links to the controls page', () => {
    expect(section(html, 'free-toolkits')).toContain('href="/explore/controls"');
  });

  it('FR-PUB-05: the principle sections keep the ids other pages link to', () => {
    for (const slug of [
      'fairness',
      'proportionality',
      'transparency',
      'accountability',
      'safety',
      'awareness',
      'collaboration',
      'sustainability',
    ]) {
      expect(html, slug).toContain(`id="principle-${slug}"`);
    }
  });

  it('NFR-SEC-11: markup in the Help and contact address is refused at read, so it never reaches the page', () => {
    expect(() => renderWithHelpContact(JSON.stringify({ email: '<b>x</b>@example.org' }))).toThrow(/help-contact/);
  });

  it('NFR-SEC-11 FR-PUB-02: the credit line on S-28 renders as text, not markup', () => {
    const hostile = renderWithFile(
      'credit.json',
      JSON.stringify({ text: '<b>x</b> GIZ', href: 'https://creativecommons.org/licenses/by-sa/4.0/', licence: 'CC BY-SA 4.0' }),
    );
    expect(section(hostile, 'credit')).toContain('&lt;b&gt;x&lt;/b&gt; GIZ');
    expect(hostile).not.toContain('<b>x</b>');
  });

  it('UX-03: a named address shows as "Write to <address>" with a mailto link, and the pending sentence is gone', () => {
    const named = section(renderWithHelpContact(JSON.stringify({ email: 'help@makrai.example' })), 'help-and-contact');
    expect(plain(named)).toContain('Write to help@makrai.example');
    expect(named).toContain('href="mailto:help@makrai.example"');
    expect(plain(named)).not.toContain(PENDING);
  });

  it('UX-03: only an explicit null shows the pending sentence; anything else that is not an address is refused', () => {
    expect(plain(section(renderWithHelpContact(JSON.stringify({ email: null })), 'help-and-contact'))).toContain(PENDING);
    for (const bad of [
      '{}',
      'null',
      '[]',
      '{"email":""}',
      '{"email":5}',
      '{"email":"TBD"}',
      '{"email":"null"}',
      '{"email":"mailto:help@makrai.example"}',
      '{"email":"help@makrai.example "}',
      '{"email":"help@makrai.example?subject=hello"}',
      '{"email":"help@makrai.example?body=paste%20your%20decisions"}',
      '{"email":"help@makrai.example#x"}',
      '{"email":"help@makrai.example/path"}',
      '{"email":null,"Email":"help@makrai.example"}',
      '{"email":null,"address":"somewhere"}',
      '{"email":',
    ]) {
      expect(() => renderWithHelpContact(bad), bad).toThrow(/help-contact/);
    }
  });

  // Shown as skipped, not passed, when RELEASE_CANDIDATE is not 1. The pending sentence promises an address
  // "before the platform opens to teams" (13.8 step 4d).
  it.runIf(process.env.RELEASE_CANDIDATE === '1')('UX-03: with RELEASE_CANDIDATE=1 the Help and contact address is named, not pending', () => {
    expect(helpContact().email).not.toBeNull();
  });

  it('UX-03 WCAG 2.4.2: the page title says which page it is', () => {
    expect(metadata.title).toBe('About - MAK-AI RAI Platform');
  });
});
