import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The vocabulary lint (plan 1A, Task 8; design spec section 6, "The vocabulary test"). A retired term of
 * `data/vocabulary.json` whose class is `phrase` may not appear in:
 *   (1) `lib/**\/copy.ts` string and template literals, except inside `verbatim('legal-text' | 'giz-credit', …)`;
 *   (2) the running content bundle's rendered fields (`data/content/<running>/`), signed and unsigned;
 *   (3) `data/fieldmaps/*.json` `label` and `section`;
 *   (4) `lib/email/templates.ts`, `lib/email/templates/*.ts` literals and `ops/host/break-glass-notice.txt`;
 *   (5) `public/templates/*.html` text nodes (report-only until stage 3);
 *   (6) markdown cells of `public/notebooks/*.ipynb` and `notebooks/**\/*.ipynb` (report-only until stage 3).
 * A `review` item is never linted: a reader checks it. The patterns are read from `data/vocabulary.json` (generated
 * from `scripts/vocabulary/lint-rules.json`), so the lint and the generated data cannot disagree.
 * A third-party product name (`properNames`: exact resource titles of the running content) is masked, span by span,
 * before the patterns run, so the rest of the same string is still linted.
 * `data/legal/**` and `data/credit.json` are the quoted texts and are not scanned. There is no allow-list file.
 * With `VOCABULARY_HITS_DIR` set, the hit lists are written there; otherwise the test writes nothing.
 */

const ROOT = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

type RetiredItem = { text: string; lint: 'phrase' | 'review'; pattern?: string; caseSensitive?: boolean; why?: string };
type Concept = { id: string; term: string; retired: RetiredItem[] };
type Vocabulary = { concepts: Concept[]; properNames: Array<{ text: string; source: string }> };
export type Rule = { id: string; term: string; item: string; re: RegExp };
export type Hit = { where: string; match: string; rule: Rule; text: string };

const VOCABULARY = JSON.parse(read('data/vocabulary.json')) as Vocabulary;

/** Every `phrase` item as a global regular expression; `i` unless the item is case-sensitive. */
export function phraseRules(v: Vocabulary): Rule[] {
  return v.concepts.flatMap((c) => c.retired
    .filter((r) => r.lint === 'phrase')
    .map((r) => ({ id: c.id, term: c.term, item: r.text, re: new RegExp(r.pattern as string, r.caseSensitive ? 'gu' : 'giu') })));
}
const RULES = phraseRules(VOCABULARY);
const PROPER_NAMES = VOCABULARY.properNames.map((p) => p.text);

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

export const VERBATIM_KINDS = ['legal-text', 'giz-credit'] as const;
const VERBATIM_MODULE = /(?:^@\/|\/)lib\/vocabulary\/verbatim$|^\.{1,2}\/(?:.*\/)?verbatim$/;

/** The local names a file binds to `verbatim` (named or aliased import) and the namespaces that carry it. */
export function verbatimBindings(sf: ts.SourceFile): { names: Set<string>; namespaces: Set<string> } {
  const names = new Set<string>(['verbatim']);
  const namespaces = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!VERBATIM_MODULE.test(st.moduleSpecifier.text)) continue;
    const b = st.importClause?.namedBindings;
    if (b && ts.isNamespaceImport(b)) namespaces.add(b.name.text);
    if (b && ts.isNamedImports(b)) {
      for (const el of b.elements) if ((el.propertyName ?? el.name).text === 'verbatim') names.add(el.name.text);
    }
  }
  return { names, namespaces };
}

/** True when `call` calls verbatim through one of the file's bindings. */
export function isVerbatimCall(call: ts.CallExpression, b: { names: Set<string>; namespaces: Set<string> }): boolean {
  const e = call.expression;
  if (ts.isIdentifier(e)) return b.names.has(e.text);
  return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && b.namespaces.has(e.expression.text) && e.name.text === 'verbatim';
}

const allowedKind = (call: ts.CallExpression) => {
  const a = call.arguments[0];
  return !!a && ts.isStringLiteral(a) && (VERBATIM_KINDS as readonly string[]).includes(a.text);
};

/**
 * The text of every string and template literal in a TypeScript source, with its line. A template's static parts are
 * joined by MASK, so a `${…}` hole is never read as text; a literal inside a hole is a literal of its own and is read.
 * Skipped: the module specifiers of import and export declarations (paths, not copy), and every literal inside the
 * arguments of a verbatim call whose first argument is an allowed kind.
 */
export function tsLiterals(file: string, source: string): Array<{ where: string; text: string }> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const b = verbatimBindings(sf);
  const out: Array<{ where: string; text: string }> = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n))) {
      if (ts.isExportDeclaration(n) && n.exportClause) visit(n.exportClause);
      return;
    }
    if (ts.isCallExpression(n) && isVerbatimCall(n, b) && allowedKind(n)) return;
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

type Field = { where: string; text: string; signed: boolean };

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

function walk(dir: string, keep: (rel: string) => boolean): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...walk(rel, keep)); }
    else if (keep(rel)) out.push(rel);
  }
  return out.sort();
}

const RUNNING = `data/content/${(JSON.parse(read('data/content/index.json')) as { running: string }).running}`;

export const scopeCopyModules = () => walk('lib', (f) => f.endsWith('/copy.ts')).flatMap((f) => lintTs(f, read(f)));
export const scopeFieldMaps = () => walk('data/fieldmaps', (f) => f.endsWith('.json')).flatMap((f) => {
  const m = JSON.parse(read(f)) as { fields: Array<{ label?: string; section?: string }> };
  return m.fields.flatMap((x, i) => [
    ...(typeof x.label === 'string' ? lintText(`${f}:fields[${i}].label`, x.label) : []),
    ...(typeof x.section === 'string' ? lintText(`${f}:fields[${i}].section`, x.section) : []),
  ]);
});
export const scopeEmail = () => [
  ...['lib/email/templates.ts', ...walk('lib/email/templates', (f) => f.endsWith('.ts'))].flatMap((f) => lintTs(f, read(f))),
  ...read('ops/host/break-glass-notice.txt').split('\n').flatMap((line, i) => lintText(`ops/host/break-glass-notice.txt:${i + 1}`, line)),
];
export const scopeTemplates = () => walk('public/templates', (f) => f.endsWith('.html')).flatMap((f) => lintHtml(f, read(f)));
export const scopeNotebooks = () => [
  ...walk('public/notebooks', (f) => f.endsWith('.ipynb')),
  ...walk('notebooks', (f) => f.endsWith('.ipynb')),
].flatMap((f) => notebookTexts(f, read(f)).flatMap((t) => lintText(t.where, t.text)));
export const scopeContent = (fields: Field[] = contentFields(RUNNING)) =>
  fields.flatMap((f) => lintText(f.where, f.text).map((h) => ({ ...h, signed: f.signed })));

/** Writes a hit list into VOCABULARY_HITS_DIR, only when it is set. */
function writeHits(name: string, hits: Hit[]) {
  const dir = process.env.VOCABULARY_HITS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), hits.map(formatHit).join('\n') + (hits.length ? '\n' : ''));
}

// ---------------------------------------------------------------------------------------------------------------------

describe('the vocabulary lint, on fixtures', () => {
  const ruleOf = (id: string) => RULES.filter((r) => r.id === id);

  it('every phrase pattern in data/vocabulary.json compiles, and every retired item is phrase or review', () => {
    const items = VOCABULARY.concepts.flatMap((c) => c.retired);
    expect(items.length).toBeGreaterThan(0);
    for (const r of items) expect(['phrase', 'review']).toContain(r.lint);
    expect(RULES.length).toBe(items.filter((r) => r.lint === 'phrase').length);
  });

  it('a planted "MAK-AI Responsible AI Toolkit" in a copy module fails, and the message names the term and concept', () => {
    const hits = lintTs('lib/x/copy.ts', "export const X = { title: 'Welcome to the MAK-AI Responsible AI Toolkit' };");
    expect(hits.map(formatHit)).toEqual([
      'lib/x/copy.ts:1: "MAK-AI Responsible AI Toolkit" → use "MAK-AI RAI Platform" (concept product)',
    ]);
  });

  it("the same text inside verbatim('giz-credit', …) passes; through an aliased or namespace import too", () => {
    const text = "'Funded for the MAK-AI Responsible AI Toolkit'";
    expect(lintTs('a/copy.ts', `import { verbatim } from '@/lib/vocabulary/verbatim';\nexport const C = verbatim('giz-credit', ${text});`)).toEqual([]);
    expect(lintTs('a/copy.ts', `import { verbatim as v } from '@/lib/vocabulary/verbatim';\nexport const C = v('legal-text', ${text});`)).toEqual([]);
    expect(lintTs('a/copy.ts', `import * as V from '@/lib/vocabulary/verbatim';\nexport const C = V.verbatim('giz-credit', ${text});`)).toEqual([]);
  });

  it('a verbatim call with any other kind is linted', () => {
    const src = "import { verbatim } from '@/lib/vocabulary/verbatim';\nexport const C = verbatim('other' as never, 'the MAK-AI Responsible AI Toolkit');";
    expect(lintTs('a/copy.ts', src)).toHaveLength(1);
  });

  it('"Google Model Card Toolkit" passes as a proper name', () => {
    expect(PROPER_NAMES).toContain('Google Model Card Toolkit');
    expect(lintText('t', 'Google Model Card Toolkit')).toEqual([]);
    expect(lintText('t', 'the Google Model Card Toolkit')).toEqual([]);
  });

  it('a proper name inside a sentence that also holds a retired phrase still fails on the phrase', () => {
    const hits = lintText('t', 'Use the Google Model Card Toolkit with the Toolkit.');
    expect(hits.map((h) => [h.match, h.rule.id])).toEqual([['the Toolkit', 'product']]);
    expect(lintText('t', 'Google Model Card Toolkit, from the Dashboard').map((h) => h.rule.id)).toEqual(['dashboard']);
  });

  it('masking: a proper name that itself holds a retired phrase passes, and only its exact span is masked', () => {
    const names = ['Acme Dashboard Kit'];
    expect(lintText('t', 'Acme Dashboard Kit', RULES, [])).toHaveLength(1);
    expect(lintText('t', 'Acme Dashboard Kit', RULES, names)).toEqual([]);
    expect(lintText('t', 'Use Acme Dashboard Kit, not the Dashboard', RULES, names).map((h) => h.rule.id)).toEqual(['dashboard']);
    // The mask is not white space: a whole-string label rule does not see through a masked name.
    expect(lintText('t', 'Explore Acme Dashboard Kit', RULES, names)).toEqual([]);
  });

  it('the same word in our own sentence still fails when it matches a retired phrase', () => {
    expect(lintText('t', 'Open the RAI Toolkit').map((h) => h.rule.id)).toEqual(['product']);
  });

  it('"/orgs/x/dashboard" in a URL passes; "Dashboard" as a word fails (case-sensitive rule)', () => {
    expect(lintText('t', '/orgs/x/dashboard')).toEqual([]);
    expect(lintText('t', 'Back to the dashboard of counts')).toEqual([]);
    expect(lintText('t', 'Back to Dashboard').map((h) => h.rule.id)).toEqual(['dashboard']);
  });

  it('a case-sensitive rule does not match the other case; a case-insensitive one does', () => {
    expect(lintText('t', 'sign in')).toEqual([]);
    expect(lintText('t', 'Sign In').map((h) => h.rule.id)).toEqual(['sign-in-sign-out']);
    expect(lintText('t', 'EXPECTED PRACTICE').map((h) => h.rule.id)).toEqual(['what-good-looks-like']);
  });

  it('a review item never fails: each review item\'s own text raises no hit for that item', () => {
    const review = VOCABULARY.concepts.flatMap((c) => c.retired.filter((r) => r.lint === 'review').map((r) => ({ id: c.id, text: r.text })));
    expect(review.length).toBeGreaterThan(0);
    for (const r of review) {
      expect(lintText('t', r.text).filter((h) => h.rule.id === r.id && h.rule.item === r.text), r.text).toEqual([]);
    }
    expect(lintText('t', 'This action cannot be undone. Generate a report for this session.')).toEqual([]);
  });

  it("a template literal's static parts are scanned and its ${…} holes are not", () => {
    expect(lintTs('a/copy.ts', 'export const f = (Dashboard: string) => `Open ${Dashboard} now`;')).toEqual([]);
    expect(lintTs('a/copy.ts', 'export const f = (n: number) => `Open the Dashboard (${n})`;').map((h) => h.rule.id)).toEqual(['dashboard']);
    // A hole does not join its neighbours into a whole-string label.
    expect(lintTs('a/copy.ts', 'export const f = (n: number) => `${n} Post`;')).toEqual([]);
    expect(lintTs('a/copy.ts', "export const C = 'Post';").map((h) => h.rule.id)).toEqual(['stage-3']);
  });

  it('import and export paths are not copy', () => {
    expect(lintTs('a/copy.ts', "import { x } from '@/lib/Dashboard';\nexport { y } from './Dashboard';")).toEqual([]);
  });

  it('HTML: text nodes are scanned; script, style and a data-verbatim element of an allowed kind are not', () => {
    const html = [
      '<html><head><style>.Dashboard{}</style><script>const s = "Dashboard";</script></head><body>',
      '<p data-verbatim="giz-credit">the MAK-AI Responsible AI Toolkit <b>Dashboard</b></p>',
      '<p data-verbatim="other">Dashboard one</p>',
      '<p>Use the <em>RAI Toolkit</em> here &amp; there</p>',
      '</body></html>',
    ].join('\n');
    expect(lintHtml('t.html', html).map(formatHit)).toEqual([
      't.html:3: "Dashboard" → use "Home" (concept dashboard)',
      't.html:4: "RAI Toolkit" → use "MAK-AI RAI Platform" (concept product)',
    ]);
  });

  it('notebooks: markdown cells are scanned, code cells are not', () => {
    const nb = JSON.stringify({ cells: [
      { cell_type: 'markdown', source: ['# Title\n', 'Part of the RAI Toolkit.\n'] },
      { cell_type: 'code', source: ['print("RAI Toolkit")\n'] },
    ] });
    expect(notebookTexts('n.ipynb', nb).flatMap((t) => lintText(t.where, t.text)).map(formatHit)).toEqual([
      'n.ipynb:cell 1 line 2: "RAI Toolkit" → use "MAK-AI RAI Platform" (concept product)',
    ]);
  });

  it('a third-party version number after its name passes; a bare version tag fails', () => {
    expect(lintText('t', 'World Bank (api.worldbank.org v2, retrieved 30 Oct 2026)')).toEqual([]);
    expect(lintText('t', 'Python v3')).toEqual([]);
    expect(lintText('t', 'Q-PP-03 · v3').map((h) => h.rule.id).sort()).toEqual(['legal-text-version', 'version-of-a-decision']);
  });

  it('"organization" in our own text fails; a capitalised name mid-sentence passes', () => {
    expect(lintText('t', 'Adapt titles to your organization.').map((h) => h.match)).toEqual(['organization']);
    expect(lintText('t', '1. Organizational roles').map((h) => h.match)).toEqual(['Organizational']);
    expect(lintText('t', 'Guidance from the World Health Organization')).toEqual([]);
  });

  it('content fields carry their sign-off status: question texts and reason codes signed, area names not', () => {
    const fields = contentFields(RUNNING);
    expect(fields.find((f) => f.where.endsWith('.questions[0].text'))?.signed).toBe(true);
    expect(fields.find((f) => f.where.includes('reasonCodes.json:codes[0].label'))?.signed).toBe(true);
    expect(fields.find((f) => f.where.endsWith('areas[0].name'))?.signed).toBe(false);
    expect(fields.find((f) => f.where.endsWith('meta.framework'))?.signed).toBe(false);
    expect(ruleOf('product').length).toBe(3);
  });
});

describe('the vocabulary lint, on the repository', () => {
  it('scope (2): the running content bundle, signed and unsigned fields, holds no retired phrase', () => {
    const fields = contentFields(RUNNING);
    expect(fields.length).toBeGreaterThan(500);
    const hits = scopeContent(fields);
    expect(hits.map((h) => `${h.signed ? 'signed' : 'unsigned'} ${formatHit(h)} in: ${h.text}`)).toEqual([]);
  });

  it('rendered content fields outside the scope list: report-only, prints the count', () => {
    const hits = scopeContent(contentExtraFields(RUNNING));
    console.log([`vocabulary lint: ${hits.length} hit(s) in rendered content fields the scope list does not name`, ...hits.map(formatHit)].join('\n'));
  });

  // Scopes (1) copy modules, (3) field maps and (4) email all hold hits today: the worklist of the copy tasks.
  // Register row (toolkit-process/docs/DEFERRED_REGISTER.md), trigger "Task 20 merged"; Task 20 removes `.fails`.
  it.fails('vocabulary lint (worklist until Task 20)', () => {
    const hits = [...scopeCopyModules(), ...scopeFieldMaps(), ...scopeEmail()];
    writeHits('vocabulary-hits-baseline.txt', hits);
    expect(hits.map(formatHit)).toEqual([]);
  });

  it('templates (scope 5, stage 3): report-only, prints the count, never fails', () => {
    const hits = scopeTemplates();
    writeHits('vocabulary-template-hits.txt', hits);
    console.log(`vocabulary lint: ${hits.length} hit(s) in public/templates (report-only until stage 3)`);
  });

  it('notebooks (scope 6, stage 3): report-only, prints the count, never fails', () => {
    const hits = scopeNotebooks();
    writeHits('vocabulary-notebook-hits.txt', hits);
    console.log(`vocabulary lint: ${hits.length} hit(s) in notebooks (report-only until stage 3)`);
  });
});
