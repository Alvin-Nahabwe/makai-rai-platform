import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { repoFiles, ROOT } from './repo-files';
import { isAllowedVerbatimCall, verbatimBindings } from './verbatim';

/**
 * The vocabulary lint's scanner (plan 1A, Task 8; design spec section 6). The cases live in
 * __tests__/lint/vocabulary.test.ts; this module holds no tests, so importing it registers none.
 */

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

type RetiredItem = { text: string; lint: 'phrase' | 'review'; pattern?: string; caseSensitive?: boolean; why?: string };
type Concept = { id: string; term: string; retired: RetiredItem[] };
type Vocabulary = { concepts: Concept[]; properNames: Array<{ text: string; source: string }> };
export type Rule = { id: string; term: string; item: string; re: RegExp };
export type Hit = { where: string; match: string; rule: Rule; text: string };

export const VOCABULARY = JSON.parse(read('data/vocabulary.json')) as Vocabulary;

/** Every `phrase` item as a global regular expression; `i` unless the item is case-sensitive. */
export function phraseRules(v: Vocabulary): Rule[] {
  return v.concepts.flatMap((c) => c.retired
    .filter((r) => r.lint === 'phrase')
    .map((r) => ({ id: c.id, term: c.term, item: r.text, re: new RegExp(r.pattern as string, r.caseSensitive ? 'gu' : 'giu') })));
}
export const RULES = phraseRules(VOCABULARY);
export const PROPER_NAMES = VOCABULARY.properNames.map((p) => p.text);

/** Not white space (so `^\s*…\s*$` anchors do not see through it) and not a word character (so `\b` holds). */
const MASK = '⁠';

/** Hits in one piece of text: each proper name's exact spans masked, then every phrase rule run over the rest. */
export function lintText(where: string, text: string, rules: Rule[] = RULES, properNames: string[] = PROPER_NAMES): Hit[] {
  let masked = text;
  for (const name of properNames) if (name) masked = masked.split(name).join(MASK.repeat(name.length));
  const hits: Hit[] = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    for (const m of masked.matchAll(rule.re)) hits.push({ where, match: m[0].trim() || m[0], rule, text });
  }
  return hits;
}

export const formatHit = (h: Hit) => `${h.where}: "${h.match}" → use "${h.rule.term}" (concept ${h.rule.id})`;

// ---------------------------------------------------------------------------------------------------------------------
// TypeScript: string and template literals, skipping the arguments of an allowed verbatim(…) call.

/**
 * The text of every string and template literal in a TypeScript source, with its line. A template's static parts are
 * joined by MASK, so a `${…}` hole is never read as text; a literal inside a hole is a literal of its own and is read.
 * Skipped: the module specifiers of import and export declarations (paths, not copy), and every literal inside the
 * arguments of a verbatim call whose first argument is an allowed kind.
 */
export function tsLiterals(file: string, source: string): Array<{ where: string; text: string }> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const b = verbatimBindings(sf, file);
  const out: Array<{ where: string; text: string }> = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n))) {
      if (ts.isExportDeclaration(n) && n.exportClause) visit(n.exportClause);
      return;
    }
    if (isAllowedVerbatimCall(n, b)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push({ where: `${file}:${lineOf(n)}`, text: n.text });
      return;
    }
    if (ts.isTemplateExpression(n)) {
      out.push({ where: `${file}:${lineOf(n)}`, text: [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(MASK) });
      for (const s of n.templateSpans) visit(s.expression);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export const lintTs = (file: string, source: string, rules: Rule[] = RULES, names: string[] = PROPER_NAMES) =>
  tsLiterals(file, source).flatMap((l) => lintText(l.where, l.text, rules, names));

// ---------------------------------------------------------------------------------------------------------------------
// HTML: text nodes outside script, style and any element marked data-verbatim="legal-text|giz-credit".
// The repository has no HTML parser dependency; this follows the tag-body pattern of __tests__/content/templates.test.ts.

const TAG_BODY = '(?:[^>"\']|"[^"]*"|\'[^\']*\')*';
const TOKEN = new RegExp(`<!--[\\s\\S]*?-->|<!doctype${TAG_BODY}>|<(/?)([a-zA-Z][\\w:-]*)(${TAG_BODY})>|[^<]+|<`, 'gi');
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const VERBATIM_ATTR = /(?:^|\s)data-verbatim\s*=\s*(?:"(legal-text|giz-credit)"|'(legal-text|giz-credit)'|(legal-text|giz-credit)(?=[\s/]|$))/i;

const decodeEntities = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&amp;/g, '&');

export function htmlTexts(file: string, html: string): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  const stack: Array<{ name: string; skip: boolean }> = [];
  const skipping = () => stack.some((e) => e.skip);
  let raw: string | null = null; // inside script or style: everything up to its end tag is not text
  for (const m of html.matchAll(TOKEN)) {
    const [tok, slash, rawName, attrs] = m;
    const name = rawName?.toLowerCase();
    if (raw) {
      if (slash && name === raw) raw = null;
      continue;
    }
    if (name) {
      if (slash) {
        const at = stack.map((e) => e.name).lastIndexOf(name);
        if (at >= 0) stack.length = at;
      } else if (name === 'script' || name === 'style') {
        if (!/\/\s*$/.test(attrs)) raw = name;
      } else if (!VOID.has(name) && !/\/\s*$/.test(attrs)) {
        stack.push({ name, skip: VERBATIM_ATTR.test(attrs) });
      }
      continue;
    }
    if (tok.startsWith('<!') || skipping()) continue;
    const text = decodeEntities(tok).replace(/\s+/g, ' ').trim();
    if (text) out.push({ where: `${file}:${html.slice(0, m.index).split('\n').length}`, text });
  }
  return out;
}

export const lintHtml = (file: string, html: string, rules: Rule[] = RULES, names: string[] = PROPER_NAMES) =>
  htmlTexts(file, html).flatMap((t) => lintText(t.where, t.text, rules, names));

// ---------------------------------------------------------------------------------------------------------------------
// Notebooks: markdown cells only. Where is `file:cell <n> line <m>` (both 1-based within the notebook's cells).

export function notebookTexts(file: string, json: string): Array<{ where: string; text: string }> {
  const nb = JSON.parse(json) as { cells: Array<{ cell_type: string; source: string | string[] }> };
  return nb.cells.flatMap((c, i) => {
    if (c.cell_type !== 'markdown') return [];
    const src = Array.isArray(c.source) ? c.source.join('') : c.source;
    return src.split('\n').map((line, j) => ({ where: `${file}:cell ${i + 1} line ${j + 1}`, text: line }));
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The content bundle: the rendered fields, each with its JSON path and whether a sign-off covers it.
// Signed (lib/content/signoffs.ts `signOffPayload`): question text, expectedPractice, whyAsked, reasonPrompt,
// evidenceExamples, helpText, example; documentHelp; reasonCodes label, useWhen, reasonMustSay.

export type Field = { where: string; text: string; signed: boolean };

export function contentFields(dir: string): Field[] {
  const j = (f: string) => JSON.parse(read(`${dir}/${f}`));
  const out: Field[] = [];
  const add = (file: string, path: string, v: unknown, signed: boolean) => {
    if (typeof v === 'string') out.push({ where: `${dir}/${file}:${path}`, text: v, signed });
    else if (Array.isArray(v)) v.forEach((x, i) => add(file, `${path}[${i}]`, x, signed));
    else if (v !== undefined && v !== null) throw new Error(`${dir}/${file}:${path} is not text`);
  };
  const qb = j('questionBank.json');
  for (const [stage, s] of Object.entries(qb.stages as Record<string, { modules: Array<Record<string, unknown> & { questions: Array<Record<string, unknown>> }> }>)) {
    s.modules.forEach((m, mi) => {
      const mp = `stages.${stage}.modules[${mi}]`;
      add('questionBank.json', `${mp}.title`, m.title, false);
      add('questionBank.json', `${mp}.description`, m.description, false);
      m.questions.forEach((q, qi) => {
        const qp = `${mp}.questions[${qi}]`;
        for (const k of ['text', 'expectedPractice', 'whyAsked', 'reasonPrompt', 'evidenceExamples', 'helpText', 'example']) add('questionBank.json', `${qp}.${k}`, q[k], true);
        add('questionBank.json', `${qp}.options`, q.options, false);
      });
    });
  }
  const rc = j('reasonCodes.json') as { codes: Array<Record<string, unknown>> };
  rc.codes.forEach((r, i) => { for (const k of ['label', 'useWhen', 'reasonMustSay']) add('reasonCodes.json', `codes[${i}].${k}`, r[k], true); });
  const dh = j('documentHelp.json') as Record<string, unknown>;
  for (const [k, v] of Object.entries(dh)) add('documentHelp.json', k, v, true);
  const aa = j('assessmentAreas.json');
  add('assessmentAreas.json', 'meta.framework', aa.meta.framework, false);
  for (const [k, s] of Object.entries(aa.stages as Record<string, Record<string, unknown>>)) {
    add('assessmentAreas.json', `stages.${k}.label`, s.label, false);
    add('assessmentAreas.json', `stages.${k}.description`, s.description, false);
  }
  (aa.areas as Array<Record<string, unknown>>).forEach((a, i) => {
    for (const k of ['name', 'description', 'mitigated']) add('assessmentAreas.json', `areas[${i}].${k}`, a[k], false);
  });
  (aa.controls as Array<Record<string, unknown> & { resources?: Array<Record<string, unknown>> }>).forEach((c, i) => {
    for (const k of ['name', 'description']) add('assessmentAreas.json', `controls[${i}].${k}`, c[k], false);
    (c.resources ?? []).forEach((r, ri) => add('assessmentAreas.json', `controls[${i}].resources[${ri}].title`, r.title, false));
  });
  add('projectConfig.json', 'projectName', j('projectConfig.json').projectName, false);
  return out;
}

/**
 * Fields the app renders that the scope list of plan 1A Task 8 does not name (area `context`, shown at
 * app/(authenticated)/explore/framework/page.tsx:49; reference `relevance`, components/report/ReferencesList.tsx:62).
 * Counted and reported only; whether they join scope (2) is not this file's decision.
 */
export function contentExtraFields(dir: string): Field[] {
  const aa = JSON.parse(read(`${dir}/assessmentAreas.json`));
  const out: Field[] = [];
  (aa.areas as Array<{ context?: string; references?: Array<{ relevance?: string }> }>).forEach((a, i) => {
    if (typeof a.context === 'string') out.push({ where: `${dir}/assessmentAreas.json:areas[${i}].context`, text: a.context, signed: false });
    (a.references ?? []).forEach((r, ri) => {
      if (typeof r.relevance === 'string') out.push({ where: `${dir}/assessmentAreas.json:areas[${i}].references[${ri}].relevance`, text: r.relevance, signed: false });
    });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The files of each scope, found by pattern at run time.

/** The repository's files (./repo-files.ts) whose path matches. */
const filesMatching = (re: RegExp) => repoFiles().filter((f) => re.test(f));

export const RUNNING = `data/content/${(JSON.parse(read('data/content/index.json')) as { running: string }).running}`;

/** What one scope read and found: the files, the number of strings linted, and the hits. */
export type ScopeResult = { files: string[]; strings: number; hits: Hit[] };

function scan(files: string[], texts: (f: string) => Array<{ where: string; text: string }>): ScopeResult {
  let strings = 0;
  const hits: Hit[] = [];
  for (const f of files) for (const t of texts(f)) { strings++; hits.push(...lintText(t.where, t.text)); }
  return { files, strings, hits };
}

export const scopeCopyModules = () => scan(filesMatching(/^lib\/(?:.*\/)?copy\.ts$/), (f) => tsLiterals(f, read(f)));
export const scopeFieldMaps = () => scan(filesMatching(/^data\/fieldmaps\/[^/]+\.json$/), (f) => {
  const m = JSON.parse(read(f)) as { fields: Array<{ label?: string; section?: string }> };
  return m.fields.flatMap((x, i) => [
    ...(typeof x.label === 'string' ? [{ where: `${f}:fields[${i}].label`, text: x.label }] : []),
    ...(typeof x.section === 'string' ? [{ where: `${f}:fields[${i}].section`, text: x.section }] : []),
  ]);
});
export const scopeEmail = () => scan(
  ['lib/email/templates.ts', ...filesMatching(/^lib\/email\/templates\/[^/]+\.ts$/), 'ops/host/break-glass-notice.txt'],
  (f) => f.endsWith('.txt') ? read(f).split('\n').map((line, i) => ({ where: `${f}:${i + 1}`, text: line })) : tsLiterals(f, read(f)),
);
export const scopeTemplates = () => scan(filesMatching(/^public\/templates\/[^/]+\.html$/), (f) => htmlTexts(f, read(f)));
export const scopeNotebooks = () => scan(filesMatching(/^(?:public\/notebooks\/[^/]+|notebooks\/.+)\.ipynb$/), (f) => notebookTexts(f, read(f)));
export const scopeContent = (fields: Field[] = contentFields(RUNNING)) =>
  fields.flatMap((f) => lintText(f.where, f.text).map((h) => ({ ...h, signed: f.signed })));

// ---------------------------------------------------------------------------------------------------------------------
// The worklist ratchet (scopes 1, 3 and 4 until Task 20): hits per file, per "<concept id> :: <item text>".

export type Worklist = Record<string, Record<string, number>>;

/** The file a hit's `where` names: everything before its first colon (no scanned path holds one). */
export const fileOf = (where: string) => where.slice(0, where.indexOf(':'));
export const worklistKey = (h: Hit) => `${h.rule.id} :: ${h.rule.item}`;

export function worklistOf(hits: Hit[]): Worklist {
  const w: Worklist = {};
  for (const h of hits) {
    const byKey = (w[fileOf(h.where)] ??= {});
    byKey[worklistKey(h)] = (byKey[worklistKey(h)] ?? 0) + 1;
  }
  const sorted: Worklist = {};
  for (const f of Object.keys(w).sort()) sorted[f] = Object.fromEntries(Object.entries(w[f]).sort(([a], [b]) => a.localeCompare(b)));
  return sorted;
}

/** Every (file, concept, item) with more hits than `allowed` permits; an entry that is absent allows 0. */
export function ratchetViolations(current: Worklist, allowed: Worklist): string[] {
  const out: string[] = [];
  for (const [file, byKey] of Object.entries(current)) {
    for (const [key, n] of Object.entries(byKey)) {
      const max = allowed[file]?.[key] ?? 0;
      if (n > max) out.push(`${file}: ${key}: ${n} hit(s), the worklist allows ${max}`);
    }
  }
  return out;
}

/** Writes a hit list into VOCABULARY_HITS_DIR, only when it is set. */
export function writeHits(name: string, hits: Hit[]) {
  const dir = process.env.VOCABULARY_HITS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), hits.map(formatHit).join('\n') + (hits.length ? '\n' : ''));
}

