/**
 * Template rules (SRS 10.4.1, criteria TC-1 to TC-7) for the nine HTML templates.
 *
 * Content tests: no database, no server. They read the files with `fs` only
 * and never call `loadContent` (contract "Content bundle"; the tests name no
 * question id).
 *
 * The templates live in `public/templates` while they are served. A template
 * held back for review (C-11 until the research-ethics review passes) sits in
 * `docs/content/templates-review`; the rules below apply to both places so a
 * held-back file is still checked.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const SERVED_DIR = path.join(ROOT, 'public/templates');
const HELD_DIR = path.join(ROOT, 'docs/content/templates-review');

const TEMPLATE_IDS = ['C-01', 'C-02', 'C-07', 'C-11', 'C-17', 'C-19', 'C-25', 'C-26', 'C-28'];

/** SRS 10.4.1 TC-2, line 4514, verbatim. */
const NOTICE =
  "This is your team's own record. It is not an approval by MAK-AI or anyone else, and it is not legal advice.";

/** FR-PUB-01's phrase pattern, SRS line 1103, verbatim. */
const FR_PUB_01 =
  /\bcomplian(ce|t)\b|\baudit(-ready| ready|ed)\b|aligned (to|with)\b|\bcertif(y|ied|ication)\b|\baccredit|\bscores?\b|cannot see your records/i;

interface Template {
  /** File name, for example `C-01_alternatives-analysis.html`. */
  file: string;
  /** Control id, for example `C-01`. */
  id: string;
  html: string;
}

function listHtml(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.html'))
        .sort()
        .map((f) => path.join(dir, f))
    : [];
}

function loadTemplates(): Template[] {
  return [...listHtml(SERVED_DIR), ...listHtml(HELD_DIR)].map((p) => ({
    file: path.basename(p),
    id: path.basename(p).slice(0, 4),
    html: readFileSync(p, 'utf8'),
  }));
}

const TEMPLATES = loadTemplates();

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const BLOCK_TAGS = /<\/?(p|div|h[1-6]|li|ul|ol|td|th|tr|table|thead|tbody|option|label|textarea|select|section|br|button|body|head|title)\b[^>]*>/gi;

/** The file with style blocks and tags removed and entities decoded (what a reader sees). */
function visibleText(html: string): string {
  const noStyle = html.replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const noTags = noStyle.replace(BLOCK_TAGS, ' ').replace(/<[^>]+>/g, '');
  return decodeEntities(noTags).replace(/\s+/g, ' ').trim();
}

/** Text a reader or a screen reader meets in attributes: placeholder, title, aria-label, alt, value. */
function attributeText(html: string): string {
  const out: string[] = [];
  for (const m of html.matchAll(/\s(?:placeholder|title|aria-label|alt|value)="([^"]*)"/gi)) {
    out.push(decodeEntities(m[1]));
  }
  return out.join(' ');
}

/** Visible text plus attribute text: what the phrase, emoji and dash rules scan. */
function allText(html: string): string {
  return `${visibleText(html)} ${attributeText(html)}`;
}

function h2s(html: string): string[] {
  return [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) =>
    decodeEntities(m[1].replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\d+\.\s*/, ''),
  );
}

interface Control {
  tag: string;
  attrs: string;
  index: number;
}

const NON_TEXT_INPUTS = /type="(hidden|submit|button|reset|image)"/i;

function controls(html: string): Control[] {
  return [...html.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)]
    .map((m) => ({ tag: m[1].toLowerCase(), attrs: m[2], index: m.index ?? 0 }))
    .filter((c) => !(c.tag === 'input' && NON_TEXT_INPUTS.test(c.attrs)));
}

/** The first piece of `html` that matches, or undefined: keeps failure output short. */
function find(html: string, re: RegExp): string | undefined {
  return re.exec(html)?.[0];
}

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'i').exec(attrs)?.[1];
}

function idText(html: string, id: string): string {
  const m = new RegExp(`<([a-z0-9]+)\\b[^>]*\\sid="${id}"[^>]*>([\\s\\S]*?)</\\1>`, 'i').exec(html);
  return m ? visibleText(m[2]) : '';
}

/** Controls that have no accessible name by any of the three accepted routes. */
function unnamedControls(html: string): string[] {
  const labelFor = new Set<string>();
  for (const m of html.matchAll(/<label\b[^>]*\sfor="([^"]+)"[^>]*>([\s\S]*?)<\/label>/gi)) {
    if (visibleText(m[2]) !== '') labelFor.add(m[1]);
  }
  const wrapped: Array<[number, number]> = [];
  for (const m of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)) {
    if (visibleText(m[1]) !== '') wrapped.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  const bad: string[] = [];
  for (const c of controls(html)) {
    const id = attr(c.attrs, 'id');
    const labelledby = attr(c.attrs, 'aria-labelledby');
    const byFor = id !== undefined && labelFor.has(id);
    const byWrap = wrapped.some(([from, to]) => c.index > from && c.index < to);
    const byRef =
      labelledby !== undefined &&
      labelledby.split(/\s+/).filter(Boolean).length > 0 &&
      labelledby
        .split(/\s+/)
        .filter(Boolean)
        .every((ref) => idText(html, ref) !== '');
    if (!byFor && !byWrap && !byRef) bad.push(`<${c.tag}${c.attrs.slice(0, 60)}>`);
  }
  return bad;
}

function duplicateIds(html: string): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const m of html.matchAll(/\sid="([^"]+)"/gi)) {
    if (seen.has(m[1])) dup.add(m[1]);
    seen.add(m[1]);
  }
  return [...dup];
}

function forTargetsMissing(html: string): string[] {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/gi)].map((m) => m[1]));
  return [...html.matchAll(/<label\b[^>]*\sfor="([^"]+)"/gi)].map((m) => m[1]).filter((f) => !ids.has(f));
}

/** The template with this control id, as visible plus attribute text. */
function t(id: string): string {
  const found = TEMPLATES.find((x) => x.id === id);
  if (!found) throw new Error(`template ${id} not found in public/templates or docs/content/templates-review`);
  return allText(found.html);
}

describe('templates present', () => {
  it('TC-7: all nine HTML templates exist, each in exactly one folder', () => {
    expect(TEMPLATES.map((x) => x.id).sort()).toEqual([...TEMPLATE_IDS].sort());
  });

  it('TC-7: no Markdown file in the templates folder', () => {
    const md = existsSync(SERVED_DIR) ? readdirSync(SERVED_DIR).filter((f) => f.endsWith('.md')) : [];
    expect(md).toEqual([]);
  });
});

describe.each(TEMPLATES)('$file', ({ html }) => {
  const text = visibleText(html);
  const everything = allText(html);

  it('TC-2 FR-PUB-01: team-record notice, no approval wording, no phrase match', () => {
    expect(text.includes(NOTICE), 'the team-record notice is in the text').toBe(true);
    expect(h2s(html)).toContain('Team sign-off');
    expect(find(html, /Review (&amp;|&) (Approval|Sign-off)|Approval status/)).toBeUndefined();
    expect(find(everything, FR_PUB_01)).toBeUndefined();
  });

  it('TC-2: the notice sits directly under the Team sign-off heading', () => {
    const m = /<h2\b[^>]*>[^<]*Team sign-off[^<]*<\/h2>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
    expect(m, 'the Team sign-off h2 is followed by a p').not.toBeNull();
    expect(visibleText(m?.[1] ?? '')).toBe(NOTICE);
  });

  it('TC-5: no emoji, no dash, no curly quote, Local context label', () => {
    expect(find(everything, /\p{Extended_Pictographic}/u)).toBeUndefined();
    expect(find(everything, /[\u2013\u2014\u2018\u2019\u201c\u201d]/)).toBeUndefined();
    expect(everything).not.toContain('Global South consideration');
    expect(text).toContain('Local context');
  });

  it('TC-5 WCAG 1.3.1: every input, textarea and select has an accessible name', () => {
    expect(controls(html).length).toBeGreaterThan(0);
    expect(unnamedControls(html)).toEqual([]);
    expect(duplicateIds(html)).toEqual([]);
    expect(forTargetsMissing(html)).toEqual([]);
  });

  it('TC-5 NFR-SEC-11: no template holds script, handlers, frames or forms', () => {
    expect(find(html, /<script/i)).toBeUndefined();
    expect(find(html, /\son[a-z]+\s*=/i)).toBeUndefined();
    expect(find(html, /javascript:|vbscript:|data:text\/html/i)).toBeUndefined();
    expect(find(html, /<(iframe|object|embed|form|base|svg|math)\b/i)).toBeUndefined();
    expect(find(html, /<meta\b[^>]*http-equiv/i)).toBeUndefined();
    expect(find(html, /\s(srcdoc|formaction)\s*=/i)).toBeUndefined();
  });

  it('TC-5 NFR-PRIV-04: templates load nothing from another host', () => {
    // No resource attribute may name another host or protocol-relative URL.
    for (const m of html.matchAll(/\s(src|srcset|poster|data)=["']([^"']*)["']/gi)) {
      expect(m[2], `${m[1]} attribute`).not.toMatch(/^(https?:)?\/\//i);
    }
    expect(find(html, /<link\b[^>]*href=["'](https?:)?\/\//i)).toBeUndefined();
    // CSS: no @import, no url() to another host.
    const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
    expect(find(css, /@import/i)).toBeUndefined();
    expect(find(css, /url\(\s*["']?(https?:)?\/\//i)).toBeUndefined();
    // Outbound links only, https only, and a new tab never keeps a handle to this page.
    for (const m of html.matchAll(/<a\b([^>]*)>/gi)) {
      const href = attr(m[1], 'href');
      expect(href, `anchor ${m[1].slice(0, 60)} has an href`).toBeDefined();
      expect(href, 'anchor href').toMatch(/^(https:\/\/|#)/);
      if (/target="_blank"/i.test(m[1])) expect(attr(m[1], 'rel') ?? '', 'rel of a new-tab link').toMatch(/noopener/);
    }
  });
});

/**
 * The first-pass findings of SRS 10.4.2, one assertion per finding. The line
 * numbers are into records/plans/2026-10-28-v1-srs.md. Values are verbatim
 * from the SRS line named.
 */
describe('review findings, SRS 10.4.2', () => {
  it('TC-1 C-01: draws on MAP 1.1, no proportionality claim, no impact-level claim', () => {
    // line 4544
    expect(t('C-01')).not.toMatch(/proportionality assessment|impact-level approach/i);
    expect(t('C-01')).toMatch(/draws on/i);
  });

  it('TC-2 TC-4 C-02: no approval verdict; environmental prompt; EU Article 27 as one model', () => {
    // line 4546
    expect(t('C-02')).not.toMatch(/Conditionally approved|Approval status/);
    expect(t('C-02')).toContain('Environmental cost: compute, energy and where it runs');
    expect(t('C-02')).not.toMatch(/Per EU AI Act Art\. 27/);
    expect(t('C-02')).toContain("The team's decision");
  });

  it('TC-2 TC-3 TC-4 C-11: no GDPR as governing law; rights by applicable law; DC-15 ethics states', () => {
    // lines 4550-4554
    expect(t('C-11')).not.toMatch(/Per GDPR Art/);
    expect(t('C-11')).toContain(
      "List the rights your participants have under the law that applies to you (for example Uganda's Data Protection and Privacy Act 2019) and under your ethics approval.",
    );
    for (const s of ['Approved', 'Submitted, awaiting decision', 'Not required']) expect(t('C-11')).toContain(s);
  });

  it('TC-2 TC-3 C-11: guidance says should with the reason, national steps are examples, ownership and storage are asked', () => {
    // lines 4550-4554
    expect(t('C-11')).not.toMatch(/must be clearly disclosed|participants must have the right/i);
    expect(t('C-11')).toMatch(/data-protection clearance/i);
    expect(t('C-11')).toMatch(/data ownership/i);
    expect(t('C-11')).toMatch(/where will the data be stored/i);
    // The unverified facts of SRS line 4578 are left out until the owner confirms them.
    expect(t('C-11')).not.toMatch(/Research Data Alliance|H3Africa/);
  });

  it('TC-2 TC-4 C-17: evaluation data, own threshold, no pass or fail, typed values', () => {
    // line 4556
    expect(t('C-17')).not.toMatch(/Pass\s*\/\s*Fail/i);
    expect(t('C-17')).toContain("the team's own threshold");
    expect(t('C-17')).toContain('Values are typed by the team; the platform does not compute them.');
    expect(t('C-17')).toMatch(/code, data and model versions/i); // CG-05, line 4263
    expect(t('C-17')).toContain('Evaluation data');
    expect(t('C-17')).toContain('Fairness metrics');
    expect(t('C-17')).toContain('Environmental note: compute and energy'); // MC-33, 10.3.3
  });

  it('TC-1 TC-3 TC-4 C-19: citation, ownership, storage, folded prompts, no C-12 template pointer', () => {
    // line 4558
    expect(t('C-19')).toContain('Gebru et al. (2021); first circulated 2018');
    for (const s of ['Data ownership and benefit-sharing', 'Where the data is stored']) expect(t('C-19')).toContain(s);
    expect(t('C-19')).not.toContain('C-12 Labeling QA');
    // The four prompts folded in from datasheet-template.md (line 4566) and DC-35 (10.3.2).
    for (const s of [
      'Relationships between instances',
      'Known errors',
      'Notification of data subjects',
      'Contact',
      'Personal or sensitive data, and de-identification',
    ]) {
      expect(t('C-19')).toContain(s);
    }
  });

  it('TC-1 TC-2 C-25: Articles 85 and 86 as models', () => {
    // line 4560
    expect(t('C-25')).not.toMatch(/\(per Art\. 86\)|must be able to request explanations/);
    expect(t('C-25')).toMatch(/as models|one model/i);
  });

  it('TC-1 C-26: the RACI method', () => {
    // line 4562
    expect(t('C-26')).not.toMatch(/PMI RACI methodology/);
    expect(t('C-26')).toContain('the RACI method');
    expect(t('C-26')).toContain('Roles, responsibilities and authorities');
  });

  it('TC-1 TC-2 C-28: guidance, review schedule, folded prompts', () => {
    // line 4564
    expect(t('C-28')).not.toContain('Audit and compliance schedule');
    expect(t('C-28')).toContain('Review schedule, and the rules that apply');
    expect(t('C-28')).not.toMatch(/deployment documentation requirements/i);
    // The four prompts folded in from codebook-template.md (line 4566).
    for (const s of ['Known failure modes', 'Retraining triggers', 'Version control', 'Tests before deployment']) {
      expect(t('C-28')).toContain(s);
    }
  });

  // TC-4: C-19 and C-17 sections follow the data card and model card maps (SRS lines 4516, 4558).
  // It reads data/fieldmaps/data_card.json and model_card.json, which unit/c-map creates and
  // which have not merged into this branch's base. Replaced by the real test when they have.
  it.todo('TC-4: C-19 and C-17 sections follow the data card and model card maps (waits for unit/c-map)');
});
