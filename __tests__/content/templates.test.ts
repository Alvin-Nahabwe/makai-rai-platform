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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCreditLine } from '../../lib/credit';
import { CLAIMS_CORE, isClaim } from '../../lib/claims/pattern';
import type { ResourcesFile } from '@/types/content';
import type { FieldMap } from '@/types/documents';

const ROOT = path.resolve(__dirname, '../..');
const SERVED_DIR = path.join(ROOT, 'public/templates');
const HELD_DIR = path.join(ROOT, 'docs/content/templates-review');

const TEMPLATE_IDS = ['C-01', 'C-02', 'C-07', 'C-11', 'C-17', 'C-19', 'C-25', 'C-26', 'C-28'];

/** SRS 10.4.1 TC-2, line 4514, verbatim. */
const NOTICE =
  "This is your team's own record. It is not an approval by MAK-AI or anyone else, and it is not legal advice.";

interface Template {
  /** File name, for example `C-01_alternatives-analysis.html`. */
  file: string;
  /** Control id, for example `C-01`. */
  id: string;
  html: string;
  /** True for a file in public/templates (served); false for one held back in docs/content/templates-review. */
  served: boolean;
}

function listHtml(dir: string): string[] {
  // A folder that does not exist holds no templates. The "all nine exist" test fails if a template is in neither folder.
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
  served: path.dirname(p) === SERVED_DIR,
}));

function templateById(id: string): Template {
  const found = TEMPLATES.find((x) => x.id === id);
  if (!found) throw new Error(`template ${id} not found in public/templates or docs/content/templates-review`);
  return found;
}

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
  colon: ':',
  sol: '/',
  bsol: '\\',
  tab: '\t',
  newline: '\n',
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

/** The inside of a tag after its name: a `>` in a quoted attribute value does not end it. */
const TAG_BODY = '(?:[^>"\']|"[^"]*"|\'[^\']*\')*';

/** Tags that stay inside a line of text; every other tag ends a word. */
const INLINE_TAGS = 'a|abbr|b|cite|code|em|i|mark|q|s|small|span|strong|sub|sup|u';

/** What a reader meets in a fragment: tags removed, entities decoded, invisible characters dropped. */
function textOf(fragment: string): string {
  const spaced = fragment
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(new RegExp(`</?(?!(?:${INLINE_TAGS})\\b)[a-z]${TAG_BODY}>`, 'gi'), ' ');
  return decodeEntities(spaced.replace(new RegExp(`</?[a-z]${TAG_BODY}>`, 'gi'), ''))
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
  return [...html.matchAll(new RegExp(`<([a-z][a-z0-9]*)\\b(${TAG_BODY})>`, 'gi'))].map((m) => ({
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

/** A URL attribute as the browser reads it: entities decoded, tab and line breaks dropped, a backslash read as a slash. */
function urlValue(raw: string): string {
  return decodeEntities(raw).replace(/[\t\r\n]/g, '').replace(/\\/g, '/');
}

/** NFR-PRIV-04: nothing loads from another host; outbound links are https only and never keep a handle to the page. */
function remoteLoads(html: string): string[] {
  const bad: string[] = [];
  for (const tag of startTags(html)) {
    const attrs: Record<string, string> = {};
    for (const [name, value] of Object.entries(attributes(tag.attrs))) attrs[name] = name === 'rel' || name === 'target' ? value : urlValue(value);
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
  const css = cssUnescape(decodeEntities(html));
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

/** What the notice and the credit line must never be: hidden, collapsed or invisible by a style rule, print included. */
function hiddenByCss(html: string): string[] {
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const bad: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/\.(notice|credit)\b/.test(m[1])) continue;
    const hit = find(
      m[2],
      /display\s*:\s*none|visibility\s*:\s*(hidden|collapse)|opacity\s*:\s*0(?![.\d])|(?:^|[;\s])(?:width|height|max-height|max-width|font-size|line-height)\s*:\s*0(?:px|rem|em|%)?\s*(?:;|$)|(?:^|[;\s])(?:clip|clip-path)\s*:|(?:^|[;\s])text-indent\s*:\s*-|(?:^|[;\s])color\s*:\s*transparent/i,
    );
    if (hit) bad.push(`${m[1].trim()} { ${hit} }`);
  }
  return bad;
}

/** The credit paragraph: its text outside the link, the link target and the link text. */
function creditParts(html: string): { text: string; href?: string; link: string } | undefined {
  const m = new RegExp(`<p\\b(${TAG_BODY})>([\\s\\S]*?)</p>`, 'gi');
  for (const p of html.matchAll(m)) {
    if (attributes(p[1]).class !== 'credit') continue;
    const anchor = new RegExp(`<a\\b(${TAG_BODY})>([\\s\\S]*?)</a>`, 'i').exec(p[2]);
    return {
      text: textOf(p[2].replace(/<a\b[\s\S]*?<\/a>/gi, ' ')),
      href: anchor ? attributes(anchor[1]).href : undefined,
      link: anchor ? textOf(anchor[2]) : '',
    };
  }
  return undefined;
}

/**
 * The strings a reader or a screen reader meets, one per block of text, attribute value or generated-text string, so a
 * word of the shared claims list (lib/claims/pattern.ts) can be exempted by the exact string that holds it.
 */
function claimStrings(html: string): string[] {
  const noStyle = html.replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const blocks = noStyle
    .replace(new RegExp(`</?(?!(?:${INLINE_TAGS})\\b)[a-z]${TAG_BODY}>`, 'gi'), '\n')
    .split('\n')
    .map((b) => textOf(b))
    .filter(Boolean);
  const attrs: string[] = [];
  for (const tag of startTags(html)) {
    const a = attributes(tag.attrs);
    for (const name of TEXT_ATTRIBUTES) if (name in a) attrs.push(decodeEntities(a[name]).replace(/\s+/g, ' ').trim());
  }
  const generated = [...html.matchAll(/content\s*:\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2]);
  return [...blocks, ...attrs, ...generated].filter(Boolean);
}

/** The strings of a template that the shared claims list flags, in order, without repeats. */
function flaggedStrings(html: string): string[] {
  return [...new Set(claimStrings(html).filter((x) => isClaim(x)))];
}

/** The strings of a template flagged by the shared list that no exemption covers. */
function unexemptedClaims(html: string, exempt: readonly string[]): string[] {
  return flaggedStrings(html).filter((x) => x !== NOTICE && !exempt.includes(x));
}

/** Exemptions that no longer match a flagged string of the template: they must be removed. */
function staleExemptions(html: string, exempt: readonly string[]): string[] {
  const flagged = flaggedStrings(html);
  return exempt.filter((x) => !flagged.includes(x));
}

/**
 * REACH-1: the files of public/templates are held to the shared claims list (lib/claims/pattern.ts). A string it flags
 * is exempt only by its exact text, with the reason that the owner passed those bytes. The TC-2 notice is exempt in
 * every file (the SRS mandates it, SRS 10.4.1 TC-2). A new flagged string fails; an exemption that no longer matches
 * a flagged string fails. These are ordinary words of the templates' own guidance ("failure modes", "percentage",
 * "Completed by" as a signature label), not claims the platform makes.
 */
const EXEMPT_CLAIMS: Record<string, string[]> = {
  // owner-passed at CW-05, 6 Nov, sha256 4f029a26f4048f501103b51b70c0648d2b8bb4bc94b5d56dc3e275552ccbddd4
  'C-01_alternatives-analysis.html': [
    "Completed by",
    "e.g., Reduce diagnostic turnaround time by 40%, sensitivity of at least 90%...",
    "Consider: is the accuracy gain worth the added complexity? Could a simpler method achieve 80% of the benefit at 20% of the cost?",
  ],
  // owner-passed at CW-05, 6 Nov, sha256 05db63996ed71078e0a9dd4a76aceb3568c946f7156db289e605f03853aaf086
  'C-02_cost-benefit-impact.html': [
    "Could system failures deny access to essential services?",
    "Local context: In low- and middle-income settings, consider: infrastructure dependencies (power/connectivity for system operation), digital divide effects (who is excluded by digital-only interfaces), and whether system failures disproportionately affect populations with fewer alternatives.",
    "Completed by",
  ],
  // owner-passed at CW-05, 6 Nov, sha256 2ab7e2c7995237ca055c34b960d3dd88ac84202c9e35c6e0716b13c9a8c438e4
  'C-07_stakeholder-impact-mapping.html': [
    "Completed by",
  ],
  // owner-passed at CW-05, 6 Nov, sha256 ca930c6327239d01aeb7f48abfbe579ef5e4f74be170eeab0610bf9cd32e8f26
  'C-17_model-card.html': [
    "Known limitations and failure modes",
    "Completed by",
    "Under what conditions does the model fail? What are its boundaries?",
  ],
  // owner-passed at CW-05, 6 Nov, sha256 b078ab38addaada17d28700df05e92c6dfb2c116a13b46087c8b69ba6c6f1d7f
  'C-19_datasheet.html': [
    "Approved",
    "Completed by",
    "What percentage of data is missing? Are there systematic patterns in missingness?",
    "approved",
  ],
  // owner-passed at CW-05, 6 Nov, sha256 7341a13b53f02478f35517abf52749e0faeed028234be5140d83283f267980eb
  'C-25_feedback-redress.html': [
    "How are complaints classified? (severity levels)",
    "Completed by",
    "e.g., Agricultural credit scoring system, rural Uganda",
  ],
  // owner-passed at CW-05, 6 Nov, sha256 abb2157415de818e07dd54436e378df8c853d0c16689f9e4fdd50e53bcfc06b9
  'C-26_governance-raci.html': [
    "Completed by",
  ],
  // owner-passed at CW-05, 6 Nov, sha256 277ebffe57fb39305e1f05abdf89baae8bb93ce9bf5b454adf8de3b11cb437f3
  'C-28_codebook-deployment.html': [
    "Known failure modes",
    "Completed by",
    "In what situations does the system fail or give poor results? How would a user notice?",
    "What happens if the system fails? How do you revert to a previous version?",
    "Which tests must pass before a new version is deployed? Who runs them?",
  ],
};

/** The template with this control id, as visible text, attribute text and generated text. */
function t(id: string): string {
  return allText(templateById(id).html);
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

describe.each(TEMPLATES)('$file', ({ file, html, served }) => {
  const text = visibleText(html);
  const everything = allText(html);

  it('TC-2 FR-PUB-01: team-record notice, no approval wording, no phrase match', () => {
    expect(text.includes(NOTICE), 'the team-record notice is in the text').toBe(true);
    expect(h2s(html)).toContain('Team sign-off');
    expect(find(everything, /Review\s*&\s*(Approval|Sign-off)|Approval\s+status/i)).toBeUndefined();
    if (served) {
      // REACH-1: the shared list of lib/claims/pattern.ts. A string is exempt only by its exact text (EXEMPT_CLAIMS).
      expect(unexemptedClaims(html, EXEMPT_CLAIMS[file] ?? [])).toEqual([]);
    } else {
      // A held-back file is not served yet; the shared list is applied when it is released (unit/c-tpl-2).
      expect(find(everything, CLAIMS_CORE)).toBeUndefined();
    }
  });

  it('TC-2 FR-PUB-01: every exemption still matches a flagged string of the file', () => {
    expect(staleExemptions(html, EXEMPT_CLAIMS[file] ?? [])).toEqual([]);
    if (!served) expect(EXEMPT_CLAIMS[file]).toBeUndefined();
  });

  it('TC-2: the notice sits directly under the Team sign-off heading and is shown', () => {
    expect(noticeProblems(html)).toEqual([]);
    expect(hiddenByCss(html)).toEqual([]);
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

  it('TC-6 FR-PUB-02: the credit line equals data/credit.json, shown, with a link to the licence', () => {
    // A change of data/credit.json fails this test until the templates are edited and the owner passes them again.
    const credit = readCreditLine();
    const parts = creditParts(html);
    expect(parts, 'a <p class="credit"> paragraph').toBeDefined();
    expect(parts?.text).toBe(credit.text);
    expect(parts?.text).toContain(credit.licence);
    expect(parts?.href).toBe(credit.href);
    expect(parts?.link).toBe('Licence terms');
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
    expect(flaggedStrings('<p>com&shy;pliance</p>')).not.toEqual([]);
    expect(flaggedStrings('<dl><dt>Score</dt><dd>3</dd></dl>')).not.toEqual([]);
    expect(flaggedStrings("<input placeholder='Compliance notes'>")).not.toEqual([]);
    expect(flaggedStrings('<input placeholder=Compliance>')).not.toEqual([]);
    expect(flaggedStrings('<option label="Audited">x</option>')).not.toEqual([]);
    expect(bannedCharacters(allText('<p>Plain words, a colon: and a full stop.</p>'))).toEqual([]);
  });

  it('TC-2 FR-PUB-01 REACH-1: a word of the shared claims list is found by its exact string; an exemption is exact and cannot go stale', () => {
    const html = '<p>This is your rating</p><p>Completed by</p><p>Plain words</p>';
    expect(flaggedStrings(html)).toEqual(['This is your rating', 'Completed by']);
    expect(unexemptedClaims(html, ['Completed by'])).toEqual(['This is your rating']);
    // an exemption covers its exact string only, not a longer sentence that holds it
    expect(unexemptedClaims('<p>Completed by the platform</p>', ['Completed by'])).toEqual(['Completed by the platform']);
    expect(staleExemptions(html, ['Completed by', 'Gone string'])).toEqual(['Gone string']);
    expect(unexemptedClaims(`<p>${NOTICE}</p>`, [])).toEqual([]);
    expect(flaggedStrings(`<p>${NOTICE}</p>`)).toEqual([NOTICE]);
    expect(flaggedStrings('<input placeholder="Pass or fail?">')).not.toEqual([]);
    expect(flaggedStrings('<style>p::before { content: "Audited"; }</style><p>x</p>')).toEqual(['Audited']);
  });

  it('TC-2: a style rule that hides or collapses the notice or the credit line is found, print rules included', () => {
    const css = (rule: string) => `<style>${rule}</style><p class="notice">x</p>`;
    for (const bad of [
      '.notice { display: none; }',
      '.credit { visibility: hidden; }',
      '@media print { .notice { display:none } }',
      '@media print { .print-note { display: none; } .credit { height: 0; } }',
      'p.notice { font-size: 0px; }',
      '.notice, .other { opacity: 0; }',
      '.credit { color: transparent; }',
      '.notice { text-indent: -999px; }',
      '.notice { clip: rect(0 0 0 0); }',
    ]) {
      expect(hiddenByCss(css(bad)), bad).not.toEqual([]);
    }
    expect(hiddenByCss(css('.print-note { display: none; } .notice { font-size: 0.85rem; margin: 0.5rem 0 1rem; } .credit { opacity: 0.9; }'))).toEqual([]);
  });

  it('TC-5 NFR-PRIV-04: a ">" inside a quoted attribute value does not hide the attributes after it', () => {
    expect(remoteLoads('<img alt=">" src="https://x.test/a.png">')).not.toEqual([]);
    expect(remoteLoads("<img alt='>' src='https://x.test/a.png'>")).not.toEqual([]);
    expect(unnamedControls('<input title=">" type="text">')).toHaveLength(1);
    expect(attributeText('<input title=">" placeholder="Audited">')).toContain('Audited');
    expect(textOf('<p title=">">shown</p>')).toBe('shown');
  });

  it('TC-5 NFR-PRIV-04: entity-encoded, backslash and line-broken remote URLs are found', () => {
    for (const bad of [
      '<img src="https&#58;//x.test/a.png">',
      '<img src="https&colon;//x.test/a.png">',
      '<img src="&#104;ttps://x.test/a.png">',
      '<img src="&#x2F;&#x2F;x.test/a.png">',
      '<img src="\\\\x.test/a.png">',
      '<img src="/\\x.test/a.png">',
      '<img src="ht\ntps://x.test/a.png">',
      '<link rel="stylesheet" href="&#47;/x.test/a.css">',
      '<p style="background:url(&quot;https://x.test/a.png&quot;)">x</p>',
      '<p style="background:url(&#104;ttps://x.test/a.png)">x</p>',
      '<a href="&#104;ttp://x.test/">x</a>',
    ]) {
      expect(remoteLoads(bad), bad).not.toEqual([]);
    }
    expect(remoteLoads('<a href="https&#58;//x.test/" rel="noopener">x</a>')).toEqual([]);
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

  // TC-4 (SRS lines 4516, 4558): the section order of the datasheet and the model card template
  // equals the section order of the data card and model card field maps.
  const norm = (names: string[]) => names.map((n) => n.toLowerCase().replace(/\s*&\s*/g, ' and ').replace(/\s+/g, ' ').trim());
  const mapSections = (type: 'data_card' | 'model_card'): string[] => {
    const map = JSON.parse(readFileSync(path.join(ROOT, 'data', 'fieldmaps', `${type}.json`), 'utf8')) as FieldMap;
    const seen: string[] = [];
    for (const f of map.fields) if (!seen.includes(f.section)) seen.push(f.section);
    return norm(seen).map((n) => (n === 'record and sign-off' ? 'team sign-off' : n));
  };

  it('TC-4: C-19 and C-17 sections follow the data card and model card maps', () => {
    expect(norm(h2s(templateById('C-19').html))).toEqual(mapSections('data_card'));
    expect(norm(h2s(templateById('C-17').html))).toEqual(mapSections('model_card'));
  });
});

type Entry = ResourcesFile['templates'][number];
const ENTRY_FILE = /^\/templates\/[A-Za-z0-9._-]+\.html$/;

/**
 * What is wrong with the template entries of data/resources.json, read against the two folders. The path pattern is
 * checked before any file is read (a bad entry is reported, not opened); a passed entry is read from the served folder,
 * a failed one from the held-back folder; an entry's control id is the C-xx prefix of its file name, once.
 */
function entryProblems(entries: readonly Entry[], servedDir: string, heldDir: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!ENTRY_FILE.test(e.file)) {
      problems.push(`${e.file}: not a /templates/<name>.html path`);
      continue;
    }
    const name = e.file.slice('/templates/'.length);
    if (!/^C-\d{2}$/.test(e.controlId)) problems.push(`${e.file}: controlId ${e.controlId}`);
    if (name.slice(0, 4) !== e.controlId) problems.push(`${e.file}: controlId ${e.controlId} is not the file name prefix`);
    if (seen.has(e.controlId)) problems.push(`${e.file}: duplicate controlId ${e.controlId}`);
    seen.add(e.controlId);
    if (e.kind !== 'web page') problems.push(`${e.file}: kind ${e.kind}`);
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) problems.push(`${e.file}: sha256 is not 64 lowercase hex`);
    const dir = e.review.outcome === 'passed' ? servedDir : heldDir;
    const onDisk = path.join(dir, name);
    if (!existsSync(onDisk)) {
      problems.push(`${e.file}: ${e.review.outcome} entry, but ${path.basename(dir)}/${name} does not exist`);
      continue;
    }
    const b = readFileSync(onDisk);
    if (e.bytes !== b.length) problems.push(`${e.file}: bytes ${e.bytes}, file ${b.length}`);
    if (e.sha256 !== createHash('sha256').update(b).digest('hex')) problems.push(`${e.file}: sha256 differs from the file`);
  }
  return problems;
}

describe('review records, FR-SUG-06', () => {
  const entries = (JSON.parse(readFileSync(path.join(ROOT, 'data/resources.json'), 'utf8')) as ResourcesFile).templates;
  const passedFiles = entries.filter((e) => e.review.outcome === 'passed').map((e) => e.file.replace('/templates/', '')).sort();

  it('FR-SUG-06 TC-7: every file in the templates folder has a passed entry, and C-11 is absent until reviewed', () => {
    expect(readdirSync(SERVED_DIR).sort()).toEqual(passedFiles);
    if (!entries.some((e) => e.controlId === 'C-11' && e.review.outcome === 'passed')) {
      expect(existsSync(path.join(SERVED_DIR, 'C-11_informed-consent.html'))).toBe(false);
      expect(existsSync(path.join(HELD_DIR, 'C-11_informed-consent.html'))).toBe(true);
    }
  });

  it("FR-SUG-06 TC-7 FR-CNT-05: each entry's path, control id, kind, bytes and sha256 equal its file; a passed one is served", () => {
    expect(entryProblems(entries, SERVED_DIR, HELD_DIR)).toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.review.reviewer, e.file).toBe('Product owner, MAK-AI');
  });

  it('FR-SUG-06 TC-7: the entry checks refuse a bad path, a mismatched id, a duplicate and a failed entry with no held file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tpl-entries-'));
    try {
      const served = path.join(dir, 'served');
      const held = path.join(dir, 'held');
      mkdirSync(served);
      mkdirSync(held);
      const body = Buffer.from('<p>x</p>');
      writeFileSync(path.join(served, 'C-01_a.html'), body);
      writeFileSync(path.join(held, 'C-02_b.html'), body);
      const base = { kind: 'web page', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
      const passed: Entry = { ...base, controlId: 'C-01', file: '/templates/C-01_a.html', review: { reviewer: 'r', date: '2026-11-06', outcome: 'passed' } };
      const failed: Entry = { ...base, controlId: 'C-02', file: '/templates/C-02_b.html', review: { reviewer: 'r', date: '2026-11-06', outcome: 'failed' } };
      expect(entryProblems([passed, failed], served, held)).toEqual([]);
      // a failed entry is read from the held folder, not from the served one
      expect(entryProblems([{ ...failed, file: '/templates/C-03_c.html', controlId: 'C-03' }], served, held)).toHaveLength(1);
      // the path is checked before anything is read
      expect(entryProblems([{ ...passed, file: '/templates/../../.env' }], served, held)).toEqual(['/templates/../../.env: not a /templates/<name>.html path']);
      expect(entryProblems([{ ...passed, file: 'https://x.test/a.html' }], served, held)).toHaveLength(1);
      // the control id is the file name prefix, once
      expect(entryProblems([{ ...passed, controlId: 'C-09' }], served, held)).toHaveLength(1);
      expect(entryProblems([passed, passed], served, held)).toHaveLength(1);
      // a changed file no longer matches its entry
      expect(entryProblems([{ ...passed, sha256: 'a'.repeat(64) }], served, held)).toHaveLength(1);
      expect(entryProblems([{ ...passed, bytes: 1 }], served, held)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
