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
export type Vocabulary = { concepts: Concept[]; properNames: Array<{ text: string; source: string }> };
export type Rule = { id: string; term: string; item: string; re: RegExp };
export type Hit = { where: string; match: string; rule: Rule; text: string };

export const VOCABULARY = JSON.parse(read('data/vocabulary.json')) as Vocabulary;

/** Every `phrase` item as a global regular expression; `i` unless the item is case-sensitive. */
export function phraseRules(v: Vocabulary): Rule[] {
  return v.concepts.flatMap((c) => c.retired
    .filter((r) => r.lint === 'phrase')
    .map((r) => {
      try {
        return { id: c.id, term: c.term, item: r.text, re: new RegExp(r.pattern as string, r.caseSensitive ? 'gu' : 'giu') };
      } catch (e) {
        throw new Error(`vocabulary rule ${c.id} :: ${r.text}: invalid pattern ${JSON.stringify(r.pattern)}: ${(e as Error).message}`);
      }
    }));
}
export const RULES = phraseRules(VOCABULARY);
export const PROPER_NAMES = VOCABULARY.properNames.map((p) => p.text);

/** Not white space (so `^\s*…\s*$` anchors do not see through it) and not a word character (so `\b` holds). */
export const MASK = '\u2060';

/** Where a piece of text sits: a fixed place, or a function of the hit's index in the text (for text that spans lines). */
export type Where = string | ((index: number) => string);
export type TextUnit = { where: Where; text: string };

/** Hits in one piece of text: each proper name's exact spans masked, then every phrase rule run over the rest. */
export function lintText(where: Where, text: string, rules: Rule[] = RULES, properNames: string[] = PROPER_NAMES): Hit[] {
  let masked = text;
  for (const name of properNames) if (name) masked = masked.split(name).join(MASK.repeat(name.length));
  const hits: Hit[] = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    for (const m of masked.matchAll(rule.re)) {
      hits.push({ where: typeof where === 'string' ? where : where(m.index), match: m[0].trim() || m[0], rule, text });
    }
  }
  return hits;
}

export const formatHit = (h: Hit) => `${h.where}: "${h.match}" → use "${h.rule.term}" (concept ${h.rule.id})`;

// ---------------------------------------------------------------------------------------------------------------------
// TypeScript: string and template literals, skipping the arguments of an allowed verbatim(…) call.

/** Positions where a string literal is a key or a code, never text a reader sees. Decided by syntax kind only. */
const COMPARISON = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
export function isNonCopyPosition(n: ts.Node): boolean {
  const p = n.parent;
  if (!p) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) ||
    ts.isMethodSignature(p) || ts.isEnumMember(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === n) return true;
  if (ts.isCaseClause(p) && p.expression === n) return true;
  if (ts.isLiteralTypeNode(p)) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === n) return true;
  return ts.isBinaryExpression(p) && COMPARISON.has(p.operatorToken.kind);
}

/** One piece of text built from source parts; a hit's line is the line of the source character it starts on. */
type Part = { text: string; start: number; spansLines: boolean };
/** A `${…}` hole or a non-literal operand of `+`: one MASK, so neither side's words join across it. */
const holeAt = (start: number): Part => ({ text: MASK, start, spansLines: false });

/**
 * The text a reader may see in a TypeScript source, as units with their place. A template's static parts are joined by
 * MASK, so a `${…}` hole is never read as text; adjacent operands of `+` are one unit when one of them is a string,
 * with any other operand read as a hole. A literal inside a hole is a unit of its own.
 * Skipped: import and export module paths; every literal inside the arguments of an allowed verbatim call; a literal
 * in a non-copy position (isNonCopyPosition). A source with parse errors throws, naming the file.
 */
export function tsLiterals(file: string, source: string): TextUnit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (!Array.isArray(diagnostics)) throw new Error(`${file}: the TypeScript parser gave no diagnostics list`);
  if (diagnostics.length) {
    throw new Error(`${file}: does not parse: ${diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ')}`);
  }
  const b = verbatimBindings(sf, file);
  const out: TextUnit[] = [];
  const lineAt = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const hole = (e: ts.Node) => holeAt(e.getStart(sf));

  const unit = (parts: Part[]) => {
    const offsets: number[] = [];
    let text = '';
    for (const part of parts) { offsets.push(text.length); text += part.text; }
    out.push({ text, where: (index: number) => {
      let k = 0;
      while (k + 1 < parts.length && offsets[k + 1] <= index) k++;
      const before = parts[k].spansLines ? parts[k].text.slice(0, Math.max(0, index - offsets[k])).split('\n').length - 1 : 0;
      return `${file}:${lineAt(parts[k].start) + before}`;
    } });
  };
  /** The static parts of a template (start just after the backtick or the closing brace), its holes visited. */
  const templateParts = (n: ts.TemplateExpression | ts.NoSubstitutionTemplateLiteral): Part[] => {
    if (ts.isNoSubstitutionTemplateLiteral(n)) return [{ text: n.text, start: n.getStart(sf) + 1, spansLines: true }];
    const parts: Part[] = [{ text: n.head.text, start: n.head.getStart(sf) + 1, spansLines: true }];
    for (const s of n.templateSpans) {
      visit(s.expression);
      parts.push(hole(s.expression), { text: s.literal.text, start: s.literal.getStart(sf) + 1, spansLines: true });
    }
    return parts;
  };
  const isStringy = (n: ts.Node) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);
  const plusOperands = (n: ts.Expression): ts.Expression[] => {
    const e = ts.isParenthesizedExpression(n) ? n.expression : n;
    return ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken ? [...plusOperands(e.left), ...plusOperands(e.right)] : [n];
  };

  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (isAllowedVerbatimCall(n, b)) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken && !(ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      const ops = plusOperands(n);
      if (ops.some(isStringy)) {
        const parts: Part[] = [];
        for (const op of ops) {
          if (ts.isStringLiteral(op)) parts.push({ text: op.text, start: op.getStart(sf), spansLines: false });
          else if (ts.isNoSubstitutionTemplateLiteral(op) || ts.isTemplateExpression(op)) parts.push(...templateParts(op));
          else { parts.push(hole(op)); visit(op); }
        }
        if (!isNonCopyPosition(n)) unit(parts);
        return;
      }
    }
    if (ts.isStringLiteral(n)) {
      if (!isNonCopyPosition(n)) unit([{ text: n.text, start: n.getStart(sf), spansLines: false }]);
      return;
    }
    if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
      const parts = templateParts(n);
      if (!isNonCopyPosition(n)) unit(parts);
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
// Plain text and markdown, by block: lines of one paragraph are joined with their white space collapsed, so a phrase
// across a line wrap is found; a hit reports the line (1-based) its first character sits on.

export type Block = { text: string; lineAt: (index: number) => number };
const MD_HEADING = /^\s{0,3}#{1,6}\s/;
const MD_BLOCK_START = /^\s{0,3}(?:[-*+]\s|\d+[.)]\s|>|\|)/;

export function textBlocks(text: string, markdown: boolean): Block[] {
  const groups: Array<Array<{ line: string; n: number }>> = [];
  let current: Array<{ line: string; n: number }> | null = null;
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) { current = null; return; }
    const heading = markdown && MD_HEADING.test(line);
    if (!current || heading || (markdown && MD_BLOCK_START.test(line)) || (markdown && MD_HEADING.test(current[0].line))) {
      current = [];
      groups.push(current);
    }
    current.push({ line, n: i + 1 });
  });
  return groups.map((g) => {
    let out = '';
    const lines: number[] = [];
    for (const { line, n } of g) {
      for (const ch of line.trim()) {
        if (/\s/.test(ch)) { if (!out.endsWith(' ')) { out += ' '; lines.push(n); } } else { out += ch; lines.push(n); }
      }
      if (!out.endsWith(' ')) { out += ' '; lines.push(n); }
    }
    const text = out.trimEnd();
    return { text, lineAt: (index: number) => lines[Math.min(index, lines.length - 1)] };
  });
}

/** Markdown cells only, by block. Where is `file:cell <n> line <m>` (both 1-based within the notebook). */
export function notebookTexts(file: string, json: string): TextUnit[] {
  const nb = JSON.parse(json) as { cells?: Array<{ cell_type: string; source: string | string[] }> };
  if (!Array.isArray(nb.cells)) throw new Error(`${file}: no "cells" list`);
  return nb.cells.flatMap((c, i) => {
    if (c.cell_type !== 'markdown') return [];
    const src = Array.isArray(c.source) ? c.source.join('') : c.source;
    return textBlocks(src, true).map((b) => ({ text: b.text, where: (index: number) => `${file}:cell ${i + 1} line ${b.lineAt(index)}` }));
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The content bundle: every string value of its content files, with its JSON path and whether a sign-off covers it.

export const CONTENT_FILES = ['questionBank.json', 'reasonCodes.json', 'assessmentAreas.json', 'documentHelp.json', 'projectConfig.json'] as const;
/** Per file, the keys whose values are not read (key -> reason). */
export type ContentExclusions = Record<string, Record<string, string>>;
/** Per file, the keys a sign-off covers, or '*' for every value of the file. */
export type SignedKeys = Record<string, readonly string[] | '*'>;
export type ContentUnit = { where: string; text: string; signed: boolean };

/** The content files of one bundle directory, parsed (signoffs.json is the sign-off record, not text). */
export function readBundle(dir: string): Record<string, unknown> {
  return Object.fromEntries(CONTENT_FILES.map((f) => [f, JSON.parse(read(`${dir}/${f}`))]));
}

/**
 * Every string value in `bundle` except the text of an excluded key. An array item takes the key of its array. A value
 * that is not a string, an array or an object (a number, a boolean, null) throws, naming its path: the content files
 * hold none today, and a new one should be looked at, not skipped.
 */
export function contentStrings(bundle: Record<string, unknown>, dir: string, excluded: ContentExclusions, signed: SignedKeys): ContentUnit[] {
  const out: ContentUnit[] = [];
  for (const [file, root] of Object.entries(bundle)) {
    const skip = excluded[file] ?? {};
    const signedKeys = signed[file] ?? [];
    const walk = (v: unknown, path: string, key: string) => {
      if (typeof v === 'string') {
        out.push({ where: `${dir}/${file}:${path}`, text: v, signed: signedKeys === '*' || signedKeys.includes(key) });
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, `${path}[${i}]`, key));
      } else if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          // An exclusion covers a key's text only (a string or a list of strings); objects under the same key are read.
          const isText = typeof x === 'string' || (Array.isArray(x) && x.every((y) => typeof y === 'string'));
          if (!(Object.hasOwn(skip, k) && isText)) walk(x, path ? `${path}.${k}` : k, k);
        }
      } else {
        throw new Error(`${dir}/${file}:${path} is ${JSON.stringify(v)}, not text, a list or an object`);
      }
    };
    walk(root, '', '');
  }
  return out;
}

/** A field map's label and section of every field; anything else in its shape throws, naming the place. */
export function fieldMapTexts(file: string, json: string): TextUnit[] {
  const m = JSON.parse(json) as { fields?: unknown };
  if (!Array.isArray(m.fields)) throw new Error(`${file}: no "fields" list`);
  return (m.fields as Array<Record<string, unknown>>).flatMap((x, i) => (['label', 'section'] as const).map((k) => {
    if (typeof x[k] !== 'string') throw new Error(`${file}:fields[${i}].${k} is not text`);
    return { where: `${file}:fields[${i}].${k}`, text: x[k] as string };
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// The files of each scope, found by pattern at run time.

/** The repository's files (./repo-files.ts) whose path matches. */
const filesMatching = (re: RegExp) => repoFiles().filter((f) => re.test(f));

export const RUNNING = `data/content/${(JSON.parse(read('data/content/index.json')) as { running: string }).running}`;

/** What one scope read and found: the files, the number of strings linted, and the hits. */
export type ScopeResult = { files: string[]; strings: number; hits: Hit[] };

function scan(files: string[], texts: (f: string) => TextUnit[]): ScopeResult {
  let strings = 0;
  const hits: Hit[] = [];
  for (const f of files) for (const t of texts(f)) { strings++; hits.push(...lintText(t.where, t.text)); }
  return { files, strings, hits };
}

export const scopeCopyModules = () => scan(filesMatching(/^lib\/(?:.*\/)?copy\.ts$/), (f) => tsLiterals(f, read(f)));
export const scopeFieldMaps = () => scan(filesMatching(/^data\/fieldmaps\/[^/]+\.json$/), (f) => fieldMapTexts(f, read(f)));
export const scopeEmail = () => scan(
  ['lib/email/templates.ts', ...filesMatching(/^lib\/email\/templates\/[^/]+\.ts$/), 'ops/host/break-glass-notice.txt'],
  (f) => f.endsWith('.txt') ? textBlocks(read(f), false).map((b) => ({ text: b.text, where: (i: number) => `${f}:${b.lineAt(i)}` })) : tsLiterals(f, read(f)),
);
export const scopeTemplates = () => scan(filesMatching(/^public\/templates\/[^/]+\.html$/), (f) => htmlTexts(f, read(f)));
export const scopeNotebooks = () => scan(filesMatching(/^(?:public\/notebooks\/[^/]+|notebooks\/.+)\.ipynb$/), (f) => notebookTexts(f, read(f)));
export const scopeContent = (units: ContentUnit[]) =>
  units.flatMap((u) => lintText(u.where, u.text).map((h) => ({ ...h, signed: u.signed })));

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

/**
 * Every (file, concept, item) whose count differs from its worklist entry: above it (a new hit; an absent entry means
 * 0), or below it, including an entry whose file no longer has the item (the entry must be lowered or removed).
 */
export function ratchetViolations(current: Worklist, allowed: Worklist): string[] {
  const out: string[] = [];
  for (const [file, byKey] of Object.entries(current)) {
    for (const [key, n] of Object.entries(byKey)) {
      const max = allowed[file]?.[key] ?? 0;
      if (n > max) out.push(`${file}: ${key}: ${n} hit(s), the worklist allows ${max}`);
    }
  }
  for (const [file, byKey] of Object.entries(allowed)) {
    for (const [key, max] of Object.entries(byKey)) {
      const n = current[file]?.[key] ?? 0;
      if (n < max) {
        out.push(`${file}: ${key}: ${n} hit(s), the worklist allows ${max}: lower or remove this entry: the worklist only shrinks (VOCABULARY_WORKLIST_PRINT=1 prints the current list)`);
      }
    }
  }
  return out;
}

/** Problems with the worklist file's shape: it must be an object of files, each an object of positive integers. */
export function worklistShapeProblems(w: unknown): string[] {
  const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(w)) return ['the worklist is not an object of files'];
  const out: string[] = [];
  for (const [file, byKey] of Object.entries(w)) {
    if (!isObject(byKey)) { out.push(`${file}: not an object of entries`); continue; }
    for (const [key, n] of Object.entries(byKey)) {
      if (!(typeof n === 'number' && Number.isInteger(n) && n > 0)) out.push(`${file}: ${key}: ${JSON.stringify(n)} is not a positive integer (remove an entry that reaches 0)`);
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

