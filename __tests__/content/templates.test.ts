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
 *
 * Each rule is a function that returns the list of violations it finds, so the
 * same rule runs over the real files and over hostile fixtures (the last
 * describe in this file): a rule that cannot fail would pass every template.
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
  // A folder that does not exist holds no templates: C-11 is not in the held-back folder until the
  // review has to hold it back. The "all nine exist" test fails if a template is in neither folder.
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.html'))
        .sort()
        .map((f) => path.join(dir, f))
    : [];
}

const TEMPLATES: Template[] = [...listHtml(SERVED_DIR), ...listHtml(HELD_DIR)].map((p) => ({
  file: path.basename(p),
  id: path.basename(p).slice(0, 4),
  html: readFileSync(p, 'utf8'),
}));

// ---------------------------------------------------------------- reading the markup

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '\u00ad',
  mdash: '\u2014',
  ndash: '\u2013',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  hellip: '\u2026',
  copy: '\u00a9',
  times: '\u00d7',
  middot: '\u00b7',
  rarr: '\u2192',
  ge: '\u2265',
  le: '\u2264',
};

/** Decodes the entities the templates may use; an entity it does not know is an error, not text. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    const decoded = NAMED_ENTITIES[e.toLowerCase()];
    if (decoded === undefined) throw new Error(`unknown HTML entity ${m}: add it to NAMED_ENTITIES`);
    return decoded;
  });
}

/** Tags that stay inside a line of text; every other tag ends a word. */
const INLINE_TAGS = 'a|abbr|b|cite|code|em|i|mark|q|s|small|span|strong|sub|sup|u';

/** What a reader meets in a fragment: tags removed, entities decoded, invisible characters dropped. */
function textOf(fragment: string): string {
  const spaced = fragment
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(new RegExp(`</?(?!(?:${INLINE_TAGS})\\b)[a-z][^>]*>`, 'gi'), ' ');
  return decodeEntities(spaced.replace(/<[^>]+>/g, ''))
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The file with style blocks, tags and comments removed (what a reader sees). */
function visibleText(html: string): string {
  return textOf(html.replace(/<style\b[\s\S]*?<\/style>/gi, ' '));
}

const ATTRIBUTE = /([a-z][a-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/** Attributes of one start tag, names lower-cased; the first of a repeated name wins. */
function attributes(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of attrs.matchAll(ATTRIBUTE)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = m[2] ?? m[3] ?? m[4];
  }
  return out;
}

/** Every start tag as its lower-cased name and attribute text. */
function startTags(html: string): Array<{ name: string; attrs: string; index: number }> {
  return [...html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)].map((m) => ({
    name: m[1].toLowerCase(),
    attrs: m[2],
    index: m.index ?? 0,
  }));
}

const TEXT_ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt', 'value', 'label'];

/** Text a reader or a screen reader meets in attributes. */
function attributeText(html: string): string {
  const out: string[] = [];
  for (const tag of startTags(html)) {
    const attrs = attributes(tag.attrs);
    for (const name of TEXT_ATTRIBUTES) if (name in attrs) out.push(decodeEntities(attrs[name]));
  }
  return out.join(' ');
}

/** Text a stylesheet can add to the page: the strings of `content:` in style blocks and style attributes. */
function cssContent(html: string): string {
  return [...html.matchAll(/content\s*:\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2]).join(' ');
}

/** Visible text, attribute text and generated text: what the phrase, emoji and dash rules scan. */
function allText(html: string): string {
  return `${visibleText(html)} ${attributeText(html)} ${cssContent(html)}`;
}

function h2s(html: string): string[] {
  return [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => textOf(m[1]).replace(/^\d+\.\s*/, ''));
}

/** The first piece of `text` that matches, or undefined: keeps failure output short. */
function find(text: string, re: RegExp): string | undefined {
  return re.exec(text)?.[0];
}

// ---------------------------------------------------------------- the rules

const NON_TEXT_INPUTS = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

function controls(html: string): Array<{ label: string; attrs: Record<string, string>; index: number }> {
  return startTags(html)
    .filter((t) => ['input', 'textarea', 'select'].includes(t.name))
    .map((t) => ({ label: `<${t.name}${t.attrs.slice(0, 70)}>`, attrs: attributes(t.attrs), index: t.index, name: t.name }))
    .filter((c) => !(c.name === 'input' && NON_TEXT_INPUTS.has((c.attrs.type ?? 'text').toLowerCase())));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The text of the element with this id, or '' when there is none. */
function idText(html: string, id: string): string {
  const m = new RegExp(`<([a-z0-9]+)\\b[^>]*\\sid="${escapeRegExp(id)}"[^>]*>([\\s\\S]*?)</\\1>`, 'i').exec(html);
  return m ? textOf(m[2]) : '';
}

/** A label's own words: the text of a select or textarea inside it is not a name for it. */
function labelWords(inner: string): string {
  return textOf(inner.replace(/<(select|textarea)\b[\s\S]*?<\/\1>/gi, ' '));
}

/** Controls with no accessible name by one of the three accepted routes (WCAG 1.3.1, 4.1.2). */
function unnamedControls(html: string): string[] {
  const labelFor = new Set<string>();
  const wrapping: Array<[number, number]> = [];
  for (const m of html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    if (labelWords(m[2]) === '') continue;
    const forId = attributes(m[1]).for;
    if (forId !== undefined) labelFor.add(forId);
    else wrapping.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  const bad: string[] = [];
  for (const c of controls(html)) {
    const id = c.attrs.id;
    const refs = (c.attrs['aria-labelledby'] ?? '').split(/\s+/).filter(Boolean);
    const byFor = id !== undefined && labelFor.has(id);
    const byWrap = wrapping.some(([from, to]) => c.index > from && c.index < to);
    const byRef = refs.length > 0 && refs.every((ref) => ref !== id && idText(html, ref) !== '');
    if (!byFor && !byWrap && !byRef) bad.push(c.label);
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
  return [...html.matchAll(/<label\b([^>]*)>/gi)]
    .map((m) => attributes(m[1]).for)
    .filter((f): f is string => f !== undefined && !ids.has(f));
}

/** NFR-SEC-11: anything that would run or post from the platform's origin. */
function activeContent(html: string): string[] {
  const rules: Array<[string, RegExp]> = [
    ['script', /<script/i],
    ['event handler', /[\s/"']on[a-z]+\s*=/i],
    ['script URL', /javascript:|vbscript:|data:text\/html/i],
    ['frame, plug-in, form, base, svg or math', /<(iframe|frame|frameset|object|embed|applet|portal|form|base|svg|math)\b/i],
    ['meta refresh or policy', /<meta\b[^>]*http-equiv/i],
    ['srcdoc or formaction', /\s(srcdoc|formaction)\s*=/i],
  ];
  return rules.flatMap(([name, re]) => (re.test(html) ? [`${name}: ${find(html, re)}`] : []));
}

const REMOTE = /^\s*([a-z][a-z0-9+.-]*:|\/\/)/i;
const URL_ATTRIBUTES = ['src', 'srcset', 'poster', 'data', 'background', 'ping', 'cite', 'action', 'manifest', 'longdesc', 'codebase', 'archive'];

function cssUnescape(s: string): string {
  return s.replace(/\\([0-9a-f]{1,6})\s?/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)));
}

/** NFR-PRIV-04: nothing loads from another host; outbound links are https only and never keep a handle to the page. */
function remoteLoads(html: string): string[] {
  const bad: string[] = [];
  for (const tag of startTags(html)) {
    const attrs = attributes(tag.attrs);
    for (const name of URL_ATTRIBUTES) {
      if (!(name in attrs)) continue;
      const candidates = name === 'srcset' ? attrs[name].split(',').map((c) => c.trim().split(/\s+/)[0]) : [attrs[name]];
      for (const c of candidates) if (REMOTE.test(c)) bad.push(`${tag.name} ${name}="${c}"`);
    }
    if (tag.name === 'link' && (attrs.href === undefined || REMOTE.test(attrs.href))) bad.push(`link href="${attrs.href}"`);
    if (tag.name === 'a' || tag.name === 'area') {
      if (attrs.href === undefined || !/^\s*(https:\/\/|#)/i.test(attrs.href)) bad.push(`${tag.name} href="${attrs.href}"`);
      if (attrs.target?.toLowerCase() === '_blank' && !/noopener/i.test(attrs.rel ?? '')) bad.push(`${tag.name} target=_blank without rel=noopener`);
    }
  }
  const css = cssUnescape(html);
  for (const re of [/@import/i, /url\(\s*["']?\s*([a-z][a-z0-9+.-]*:|\/\/)/i, /image-set\(\s*["']?\s*([a-z][a-z0-9+.-]*:|\/\/)/i]) {
    const hit = find(css, re);
    if (hit) bad.push(`css ${hit}`);
  }
  return bad;
}

/** TC-5: no emoji, dash or curly quote anywhere a reader can see it. */
function bannedCharacters(text: string): string[] {
  return [/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u, /[\u2010-\u2015\u2212\u2018-\u201f]/].flatMap((re) => {
    const hit = find(text, re);
    return hit ? [hit] : [];
  });
}

/** The heading and paragraph that carry the team-record notice, or an empty list when it is placed and shown. */
function noticeProblems(html: string): string[] {
  const m = /<h2\b[^>]*>([^<]*Team sign-off[^<]*)<\/h2>\s*<p\b([^>]*)>([\s\S]*?)<\/p>/i.exec(html);
  if (!m) return ['no Team sign-off heading directly followed by a paragraph'];
  const problems: string[] = [];
  if (textOf(m[3]) !== NOTICE) problems.push(`notice text differs: ${textOf(m[3])}`);
  if (m[2].trim() !== 'class="notice"') problems.push(`notice paragraph carries attributes that could hide it: ${m[2].trim()}`);
  return problems;
}

/** The template with this control id, as visible text, attribute text and generated text. */
function t(id: string): string {
  const found = TEMPLATES.find((x) => x.id === id);
  if (!found) throw new Error(`template ${id} not found in public/templates or docs/content/templates-review`);
  return allText(found.html);
}

// ---------------------------------------------------------------- tests

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
    expect(find(everything, /Review\s*&\s*(Approval|Sign-off)|Approval\s+status/i)).toBeUndefined();
    expect(find(everything, FR_PUB_01)).toBeUndefined();
  });

  it('TC-2: the notice sits directly under the Team sign-off heading and is shown', () => {
    expect(noticeProblems(html)).toEqual([]);
  });

  it('TC-5: no emoji, no dash, no curly quote, Local context label', () => {
    expect(bannedCharacters(everything)).toEqual([]);
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
    expect(activeContent(html)).toEqual([]);
  });

  it('TC-5 NFR-PRIV-04: templates load nothing from another host', () => {
    expect(remoteLoads(html)).toEqual([]);
  });
});

describe('the rules reject what they guard against', () => {
  it('TC-5 WCAG 1.3.1: a control named only by its own text, by a label elsewhere or by itself is unnamed', () => {
    expect(unnamedControls('<label><select><option>Yes</option></select></label>')).toHaveLength(1);
    expect(unnamedControls('<label><textarea>Notes</textarea></label>')).toHaveLength(1);
    expect(unnamedControls('<label for="other">Name</label><input id="a" type="text"><input id="other">')).toHaveLength(1);
    expect(unnamedControls('<label for="other">Name<input id="a" type="text"></label><span id="other">x</span>')).toHaveLength(1);
    expect(unnamedControls('<textarea id="n" aria-labelledby="n">text</textarea>')).toHaveLength(1);
    expect(unnamedControls('<input type="text">')).toHaveLength(1);
    expect(unnamedControls('<label for="a">Name</label><input id="a" type="text">')).toEqual([]);
    expect(unnamedControls('<label>Name <input type="text"></label>')).toEqual([]);
    expect(unnamedControls('<th id="c">Col</th><td id="r">Row</td><input aria-labelledby="r c">')).toEqual([]);
  });

  it('TC-5 NFR-SEC-11: scripts, handlers, frames and forms are found', () => {
    for (const bad of [
      '<script>x</script>',
      '<img src="a.png" onerror="x()">',
      '<img/onerror=x>',
      '<a href="javascript:x()">a</a>',
      '<iframe src="a.html"></iframe>',
      '<frameset></frameset>',
      '<form action="/x"></form>',
      '<base href="/x/">',
      '<meta http-equiv="refresh" content="0;url=/x">',
    ]) {
      expect(activeContent(bad), bad).not.toEqual([]);
    }
    expect(activeContent('<p>On the day, ask one question = done</p>')).toEqual([]);
  });

  it('TC-5 NFR-PRIV-04: loads from another host are found in every form they can take', () => {
    for (const bad of [
      '<img src="https://x.test/a.png">',
      '<img src=https://x.test/a.png>',
      '<img src=" https://x.test/a.png">',
      '<img srcset="a.png 1x, https://x.test/b.png 2x">',
      '<link rel="stylesheet" href=https://x.test/a.css>',
      '<body background="https://x.test/a.png">',
      '<a href="https://x.test/" ping="https://y.test/">x</a>',
      '<p style="background:url(https://x.test/a.png)">x</p>',
      '<style>.a { background: image-set("https://x.test/a.png" 1x); }</style>',
      '<style>.a { background: \\75rl(https://x.test/a.png); }</style>',
      '<style>@import "https://x.test/a.css";</style>',
      '<a href="http://x.test/">x</a>',
      '<a href="https://x.test/" target="_blank">x</a>',
      "<a href='https://x.test/' target=_blank>x</a>",
    ]) {
      expect(remoteLoads(bad), bad).not.toEqual([]);
    }
    expect(remoteLoads('<a href="https://x.test/" target="_blank" rel="noopener noreferrer">x</a><a href="#a">y</a>')).toEqual([]);
  });

  it('TC-2 TC-5 FR-PUB-01: entities, soft hyphens, generated text and unquoted attributes cannot hide a banned word', () => {
    expect(() => allText('<p>Team&bogus;owned</p>')).toThrow(/unknown HTML entity/);
    expect(bannedCharacters(allText('<p>Team&mdash;owned</p>'))).not.toEqual([]);
    expect(bannedCharacters(allText('<p>Team&#8212;owned</p>'))).not.toEqual([]);
    expect(bannedCharacters(allText('<style>p::before { content: "\u2014"; }</style><p>x</p>'))).not.toEqual([]);
    expect(bannedCharacters(allText('<p>\u{1F1FA}\u{1F1EC}</p>'))).not.toEqual([]);
    expect(find(allText('<p>com&shy;pliance</p>'), FR_PUB_01)).toBeDefined();
    expect(find(allText('<dl><dt>Score</dt><dd>3</dd></dl>'), FR_PUB_01)).toBeDefined();
    expect(find(allText("<input placeholder='Compliance notes'>"), FR_PUB_01)).toBeDefined();
    expect(find(allText('<input placeholder=Compliance>'), FR_PUB_01)).toBeDefined();
    expect(find(allText('<option label="Audited">x</option>'), FR_PUB_01)).toBeDefined();
    expect(bannedCharacters(allText('<p>Plain words, a colon: and a full stop.</p>'))).toEqual([]);
  });

  it('TC-2: a hidden or altered notice is a problem', () => {
    const ok = `<h2>4. Team sign-off</h2><p class="notice">${NOTICE}</p>`;
    expect(noticeProblems(ok)).toEqual([]);
    expect(noticeProblems(ok.replace('class="notice"', 'class="notice" hidden'))).not.toEqual([]);
    expect(noticeProblems(ok.replace('class="notice"', 'class="print-note"'))).not.toEqual([]);
    expect(noticeProblems(ok.replace('own record', 'record'))).not.toEqual([]);
    expect(noticeProblems(`<h2>4. Team sign-off</h2><div><p class="notice">${NOTICE}</p></div>`)).not.toEqual([]);
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

  it('TC-1 TC-2 C-07: the NIST AI RMF is guidance, not stakeholder requirements', () => {
    // re-check R1, SRS line 4564 (the framework is voluntary guidance)
    expect(t('C-07')).not.toMatch(/identification requirements/i);
    expect(t('C-07')).toContain('guidance on identifying stakeholders');
  });

  it('TC-4 C-11 C-19: the ethics field records committee, reference and date, and why and who decided if not required', () => {
    // re-check R5 and R2, CG-10 (SRS line 4268), the same wording in both templates
    for (const id of ['C-11', 'C-19']) {
      expect(t(id), id).toContain('Committee name, reference number and date. If not required, say why and who decided.');
    }
  });

  it('TC-4 C-17 C-19: the template says the platform fills many fields from the team record', () => {
    // re-check R1 and R3, SRS line 4516: no prompt asks for what a document takes from the record without saying so
    for (const id of ['C-17', 'C-19']) {
      expect(t(id), id).toContain('fills many of these fields from the decisions your team records there');
    }
  });

  // TC-4: C-19 and C-17 sections follow the data card and model card maps (SRS lines 4516, 4558).
  // It reads data/fieldmaps/data_card.json and model_card.json, which unit/c-map creates and
  // which have not merged into this branch's base. Replaced by the real test when they have.
  it.todo('TC-4: C-19 and C-17 sections follow the data card and model card maps (waits for unit/c-map)');
});
