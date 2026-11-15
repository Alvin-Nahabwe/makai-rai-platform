import ts from 'typescript';

/**
 * The comparison behind spec 12: a protected test may change only where a message literal became a copy constant.
 * `compareSources`, `sameUnits` and `copyImportsOf` are plan 1A's interface; plan 1C's frozen-file test is
 * `expect(compareSources(base, head)).toEqual([])`. The rest serves the ledger tests.
 *
 * Rules, applied to one removed line and the added line it is paired with:
 * (a) a string literal, a template literal with no substitution or a regular-expression literal on the before side is
 *     one LIT unit; numeric literals are ordinary tokens;
 * (b) a copy-constant reference (a name imported from a copy module, `*_COPY`, `TERM_*`, with `.member`s), a call on one
 *     with literal or CONST arguments, a template whose substitutions are all CONST units, and `new RegExp(X)` /
 *     `RegExp(X, 'flags')` with X a CONST unit are each one CONST unit;
 * (c) both lines have the same number of units; each position is identical text, or a LIT before and a CONST after;
 * (d) import lines from a copy module are dropped before pairing; no other added or removed line is allowed.
 */

export type Violation = { line: number; before: string; after: string; why: string };
export type LedgerEntry = {
  kind: 'wording' | 'structure' | 'rule' | 'removed';
  deleted?: string;
  changed?: string;
  replacedBy: string;
  property: string;
  proof: string;
  task: string;
};
export type GitAdapter = { show(ref: string, file: string): string; changed(a: string, b: string, file: string): boolean };

const COPY_MODULE = /(^@\/lib\/|(\.\.\/)+lib\/).*copy$/;
const COPY_CONST = [/^[A-Z][A-Z0-9_]*_COPY$/, /^TERM_[A-Z0-9_]+$/];
const K = ts.SyntaxKind;
const HAS_LETTER = /\p{L}/u;

// ---- tokens and units --------------------------------------------------------------------------------------------

type Tok = { kind: ts.SyntaxKind; text: string };
type Unit = { text: string; lit: boolean; isConst: boolean; regexLit?: string; regexCall?: string };

const NO_REGEX_AFTER = new Set<ts.SyntaxKind>([
  K.Identifier, K.PrivateIdentifier, K.NumericLiteral, K.BigIntLiteral, K.StringLiteral, K.NoSubstitutionTemplateLiteral,
  K.TemplateTail, K.RegularExpressionLiteral, K.CloseParenToken, K.CloseBracketToken, K.CloseBraceToken, K.ThisKeyword,
  K.SuperKeyword, K.TrueKeyword, K.FalseKeyword, K.NullKeyword, K.PlusPlusToken, K.MinusMinusToken,
]);
const TRIVIA = new Set<ts.SyntaxKind>([K.WhitespaceTrivia, K.NewLineTrivia, K.ConflictMarkerTrivia, K.ShebangTrivia]);

/** Tokens of one line. Comments are tokens (so a changed comment is a change); whitespace is not. */
function scan(text: string): Tok[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const toks: Tok[] = [];
  const braces: Array<'template' | 'brace'> = [];
  let prev: ts.SyntaxKind | undefined;
  for (;;) {
    let kind = scanner.scan();
    if (kind === K.EndOfFileToken) break;
    if (TRIVIA.has(kind)) continue;
    if ((kind === K.SlashToken || kind === K.SlashEqualsToken) && (prev === undefined || !NO_REGEX_AFTER.has(prev))) {
      kind = scanner.reScanSlashToken();
    } else if (kind === K.CloseBraceToken && braces[braces.length - 1] === 'template') {
      kind = scanner.reScanTemplateToken(false);
      if (kind === K.TemplateTail) braces.pop();
    } else if (kind === K.CloseBraceToken) braces.pop();
    else if (kind === K.TemplateHead) braces.push('template');
    else if (kind === K.OpenBraceToken) braces.push('brace');
    toks.push({ kind, text: scanner.getTokenText() });
    if (kind !== K.SingleLineCommentTrivia && kind !== K.MultiLineCommentTrivia) prev = kind;
  }
  return toks;
}

const isLiteral = (k: ts.SyntaxKind): boolean =>
  k === K.StringLiteral || k === K.NoSubstitutionTemplateLiteral || k === K.RegularExpressionLiteral || k === K.NumericLiteral;

function isCopyName(name: string, copyNames: ReadonlySet<string>): boolean {
  return copyNames.has(name) || COPY_CONST.some((re) => re.test(name));
}

/** End index (exclusive) of the CONST unit starting at `i`, or -1. */
function matchConst(toks: Tok[], i: number, copyNames: ReadonlySet<string>): number {
  const t = toks[i];
  if (!t) return -1;
  // new RegExp(X) / RegExp(X, 'flags')
  let j = i;
  if (t.kind === K.NewKeyword) j += 1;
  if (toks[j]?.kind === K.Identifier && toks[j].text === 'RegExp' && toks[j + 1]?.kind === K.OpenParenToken && toks[i - 1]?.kind !== K.DotToken) {
    const inner = matchConst(toks, j + 2, copyNames);
    if (inner > 0) {
      let e = inner;
      if (toks[e]?.kind === K.CommaToken && toks[e + 1]?.kind === K.StringLiteral) e += 2;
      if (toks[e]?.kind === K.CloseParenToken) return e + 1;
    }
    return -1;
  }
  // a template literal all of whose substitutions are CONST units
  // (its fixed text, the head, middles and tail, holds no letter: new wording cannot hide in a template)
  if (t.kind === K.TemplateHead) {
    if (HAS_LETTER.test(t.text)) return -1;
    let e = i + 1;
    for (;;) {
      const sub = matchConst(toks, e, copyNames);
      if (sub < 0) return -1;
      e = sub;
      if (toks[e]?.kind === K.TemplateMiddle && !HAS_LETTER.test(toks[e].text)) e += 1;
      else if (toks[e]?.kind === K.TemplateTail && !HAS_LETTER.test(toks[e].text)) return e + 1;
      else return -1;
    }
  }
  // a copy-constant reference, with `.member`s, and a call on it with literal or CONST arguments
  if (t.kind === K.Identifier && isCopyName(t.text, copyNames) && toks[i - 1]?.kind !== K.DotToken) {
    let e = i + 1;
    while (toks[e]?.kind === K.DotToken && toks[e + 1]?.kind === K.Identifier) e += 2;
    if (toks[e]?.kind === K.OpenParenToken) {
      let a = e + 1;
      if (toks[a]?.kind === K.CloseParenToken) return a + 1;
      for (;;) {
        const sub = matchConst(toks, a, copyNames);
        if (sub > 0) a = sub;
        else if (toks[a] && isLiteral(toks[a].kind)) a += 1;
        else break;
        if (toks[a]?.kind === K.CommaToken) a += 1;
        else if (toks[a]?.kind === K.CloseParenToken) return a + 1;
        else break;
      }
    }
    return e;
  }
  return -1;
}

function unitsOf(text: string, copyNames: ReadonlySet<string>): Unit[] {
  const toks = scan(text);
  const units: Unit[] = [];
  for (let i = 0; i < toks.length; ) {
    const end = matchConst(toks, i, copyNames);
    if (end > i) {
      const isCall = (toks[i].kind === K.NewKeyword || toks[i].text === 'RegExp') && toks[i].kind !== K.TemplateHead;
      const flagsArg = toks[end - 3]?.kind === K.CommaToken && toks[end - 2]?.kind === K.StringLiteral && toks[end - 1]?.kind === K.CloseParenToken ? toks[end - 2].text.slice(1, -1) : '';
      units.push({ text: toks.slice(i, end).map((t) => t.text).join(' '), lit: false, isConst: true, regexCall: isCall ? flagsArg : undefined });
      i = end;
    } else {
      const k = toks[i].kind;
      units.push({
        text: toks[i].text,
        lit: k === K.StringLiteral || k === K.NoSubstitutionTemplateLiteral || k === K.RegularExpressionLiteral,
        isConst: false,
        regexLit: k === K.RegularExpressionLiteral ? toks[i].text.slice(toks[i].text.lastIndexOf('/') + 1) : undefined,
      });
      i += 1;
    }
  }
  return units;
}

/** One line pair under rules (a) to (c). */
export function sameUnits(before: string, after: string, copyNames: ReadonlySet<string>): boolean {
  const b = unitsOf(before, copyNames);
  const a = unitsOf(after, copyNames);
  if (b.length !== a.length) return false;
  const sortedFlags = (f: string): string => [...f].sort().join('');
  return b.every((u, i) => {
    if (u.text === a[i].text) return true;
    if (!u.lit || !a[i].isConst) return false;
    // RegExp(X, flags) may replace only a regular-expression literal, with the same flags
    const call = a[i].regexCall;
    return call === undefined || (u.regexLit !== undefined && sortedFlags(u.regexLit) === sortedFlags(call));
  });
}

// ---- imports -----------------------------------------------------------------------------------------------------

const parse = (source: string): ts.SourceFile => ts.createSourceFile('file.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function copyImportDeclarations(sf: ts.SourceFile): ts.ImportDeclaration[] {
  return sf.statements.filter(
    (s): s is ts.ImportDeclaration => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && COPY_MODULE.test(s.moduleSpecifier.text),
  );
}

/** The identifiers a source imports from a module whose path matches rule (d)'s pattern. */
export function copyImportsOf(source: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const decl of copyImportDeclarations(parse(source))) {
    const clause = decl.importClause;
    if (!clause) continue;
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    else if (bindings) for (const el of bindings.elements) names.add(el.name.text);
  }
  return names;
}

// ---- line diff ---------------------------------------------------------------------------------------------------

type Line = { text: string; no: number };
type Pair = { before?: Line; after?: Line };

/** Removed and added lines of each hunk, paired in order; the longer side's extra lines have no partner. */
function pairLines(a: Line[], b: Line[]): Pair[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start].text === b[start].text) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1].text === b[endB - 1].text) { endA -= 1; endB -= 1; }
  const n = endA - start;
  const m = endB - start;
  // longest common subsequence of the middle, to find the hunks
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[start + i].text === b[start + j].text ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const pairs: Pair[] = [];
  let removed: Line[] = [];
  let added: Line[] = [];
  const flush = (): void => {
    for (let k = 0; k < Math.max(removed.length, added.length); k += 1) pairs.push({ before: removed[k], after: added[k] });
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i].text === b[start + j].text) { flush(); i += 1; j += 1; }
    else if (j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1])) { removed.push(a[start + i]); i += 1; }
    else { added.push(b[start + j]); j += 1; }
  }
  flush();
  return pairs;
}

const toLines = (text: string): Line[] => text.split('\n').map((t, k) => ({ text: t, no: k + 1 }));

/** `source` lines without the lines of its copy imports (rule (d)), keeping each line's original number. */
function withoutCopyImports(source: string): Line[] {
  const sf = parse(source);
  const lines = source.split('\n');
  const dropped = new Set<number>();
  for (const decl of copyImportDeclarations(sf)) {
    const start = sf.getLineAndCharacterOfPosition(decl.getStart(sf));
    const end = sf.getLineAndCharacterOfPosition(decl.getEnd());
    // dropped only when the line is nothing but the import: no other statement shares its first or last line
    const alone = lines[start.line].slice(0, start.character).trim() === '' && lines[end.line].slice(end.character).trim() === '';
    if (alone) for (let l = start.line; l <= end.line; l += 1) dropped.add(l + 1);
  }
  return toLines(source).filter((l) => !dropped.has(l.no));
}

/** Whole-file comparison. Returns the lines that break rules (a) to (d); empty means only permitted moves. */
export function compareSources(baseSource: string, headSource: string): Violation[] {
  const copyNames = copyImportsOf(headSource);
  const out: Violation[] = [];
  for (const { before, after } of pairLines(withoutCopyImports(baseSource), withoutCopyImports(headSource))) {
    const b = before?.text ?? '';
    const a = after?.text ?? '';
    if (sameUnits(b, a, copyNames)) continue;
    const why = !before ? 'a line was added' : !after ? 'a line was removed' : 'the change is more than a message literal becoming a copy constant';
    out.push({ line: after?.no ?? before?.no ?? 0, before: b, after: a, why });
  }
  return out;
}

/** The (before, after) line pairs between two bodies, as `git diff -U0` hunks pair them. An unpaired line meets ''. */
export function linePairs(baseBody: string, headBody: string): Array<[string, string]> {
  return pairLines(toLines(baseBody), toLines(headBody)).map(({ before, after }) => [before?.text ?? '', after?.text ?? '']);
}

// ---- cases -------------------------------------------------------------------------------------------------------

/** The `it(` and `test(` cases of a source with a literal title, with their full lines as the body. */
export function casesOf(source: string, fileName = 'file.ts'): Array<{ title: string; body: string; from: number; to: number; start: number; end: number }> {
  const kind = /\.[cm]?jsx?$/.test(fileName) ? (/\.jsx$/.test(fileName) ? ts.ScriptKind.JSX : ts.ScriptKind.JS) : /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const lines = source.split('\n');
  const cases: Array<{ title: string; body: string; from: number; to: number; start: number; end: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let callee: ts.Expression = node.expression;
      while (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee)) callee = callee.expression;
      const first = node.arguments[0];
      if (ts.isIdentifier(callee) && (callee.text === 'it' || callee.text === 'test') && first) {
        const title = ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first) ? first.text : ts.isTemplateExpression(first) ? first.head.text : undefined;
        if (title !== undefined) {
          const from = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
          const to = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
          // the case's own characters: from its call to its closing parenthesis and an optional `;`
          const end = source[node.getEnd()] === ';' ? node.getEnd() + 1 : node.getEnd();
          cases.push({ title, body: lines.slice(from, to + 1).join('\n'), from, to, start: node.getStart(sf), end });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return cases;
}

/** `source` with every case's own characters blanked, so the code outside the cases can be compared with line numbers kept. */
export function outsideCases(source: string, fileName = 'file.ts'): string {
  const chars = [...source];
  // only the case's own characters are blanked (line breaks kept), so code sharing a line with a case is still compared
  for (const c of casesOf(source, fileName)) for (let i = c.start; i < c.end; i += 1) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  return chars.join('');
}

/** True when the code outside the cases differs at all, apart from copy imports and blank lines. */
function outsideChanged(baseOutside: string, headOutside: string): boolean {
  return pairLines(withoutCopyImports(baseOutside), withoutCopyImports(headOutside)).some(
    ({ before, after }) => (before?.text.trim() ?? '') !== (after?.text.trim() ?? ''),
  );
}

// ---- the ledger --------------------------------------------------------------------------------------------------

const splitKey = (key: string): { file: string; title: string } => {
  const at = key.indexOf('::');
  return { file: key.slice(0, at), title: key.slice(at + 2) };
};

/** A ledger entry for `key` of one of `kinds` whose `replacedBy` title exists at HEAD; `bad` collects entries that name a missing one. */
function excuse(key: string, kinds: LedgerEntry['kind'][], ledger: LedgerEntry[], titlesAtHead: (file: string) => string[], bad: string[]): boolean {
  let excused = false;
  for (const e of ledger) {
    if (!kinds.includes(e.kind) || (e.deleted !== key && e.changed !== key)) continue;
    if (![e.property, e.proof, e.task].every((f) => typeof f === 'string' && f.trim() !== '')) {
      bad.push(`${key}: the ${e.kind} entry needs a property, a proof and a task`);
      continue;
    }
    const target = e.replacedBy.includes('::') ? splitKey(e.replacedBy) : undefined;
    if (target && titlesAtHead(target.file).includes(target.title)) excused = true;
    else bad.push(`${key}: the ${e.kind} entry's replacedBy "${e.replacedBy}" does not exist at HEAD`);
  }
  return excused;
}

/** The problems with one protected file; empty when it differs from the base only by permitted moves or ledger entries. */
export function checkProtectedFile(args: {
  file: string;
  baseSource: string;
  headSource: string;
  isHumanRead: boolean;
  ledger: LedgerEntry[];
  titlesAtHead: (file: string) => string[];
}): string[] {
  const { file, baseSource, headSource, isHumanRead, ledger, titlesAtHead } = args;
  const problems: string[] = [];
  const headCases = casesOf(headSource, file);
  const copyNames = copyImportsOf(headSource);
  const seen = new Map<string, number>();
  const matched = new Set<number>();
  for (const baseCase of casesOf(baseSource, file)) {
    const nth = seen.get(baseCase.title) ?? 0;
    seen.set(baseCase.title, nth + 1);
    const key = `${file}::${baseCase.title}`;
    const headCase = headCases.filter((c) => c.title === baseCase.title)[nth];
    if (headCase) matched.add(headCases.indexOf(headCase));
    const bad: string[] = [];
    if (isHumanRead) {
      // compared by a reviewer: a removed or changed case needs a wording, structure or rule entry
      if (headCase && headCase.body === baseCase.body) continue;
      const kinds: LedgerEntry['kind'][] = ['wording', 'structure', 'rule'];
      if (!excuse(key, kinds, ledger, titlesAtHead, bad)) problems.push(...bad, `${key}: a humanRead file's case ${headCase ? 'changed' : 'was removed'} without a wording, structure or rule entry`);
      continue;
    }
    if (excuse(key, ['wording', 'structure', 'rule'], ledger, titlesAtHead, bad)) continue;
    problems.push(...bad);
    if (!headCase) {
      problems.push(`${key}: was removed without a ledger entry`);
      continue;
    }
    for (const [before, after] of linePairs(baseCase.body, headCase.body)) {
      if (!sameUnits(before, after, copyNames)) problems.push(`${key}: "${before.trim()}" became "${after.trim()}"`);
    }
  }
  // a case added at HEAD is not compared, but vitest hoists vi.mock and vi.hoisted to the top of the file wherever they are
  // written, so such a call in a new case acts on every case in the file
  headCases.forEach((c, i) => {
    if (matched.has(i) || !/\bvi\.(mock|hoisted)\s*\(/.test(c.body)) return;
    const key = `${file}::${c.title}`;
    const bad: string[] = [];
    if (!excuse(key, ['structure', 'rule'], ledger, titlesAtHead, bad)) problems.push(...bad, `${key}: an added case calls vi.mock or vi.hoisted, which vitest hoists over every case in the file, without a structure or rule entry`);
  });
  // the code outside the cases (constants, hooks, describe blocks, helpers) is compared as a whole
  const moduleKey = `${file}::(module)`;
  const baseOutside = outsideCases(baseSource, file);
  const headOutside = outsideCases(headSource, file);
  const bad: string[] = [];
  if (isHumanRead) {
    if (outsideChanged(baseOutside, headOutside) && !excuse(moduleKey, ['wording', 'structure', 'rule'], ledger, titlesAtHead, bad)) {
      problems.push(...bad, `${moduleKey}: a humanRead file changed outside its cases without a wording, structure or rule entry`);
    }
  } else {
    const violations = compareSources(baseOutside, headOutside);
    if (violations.length > 0 && !excuse(moduleKey, ['wording', 'structure', 'rule'], ledger, titlesAtHead, bad)) {
      problems.push(...bad, ...violations.map((v) => `${moduleKey} line ${v.line}: "${v.before.trim()}" became "${v.after.trim()}" (${v.why})`));
    }
  }
  return problems;
}

/** The base text of a protected file: the base tag's, or the `main` side of the last listed merge that changed it. */
export function resolveBaseSource(file: string, base: string, mainMerges: string[], git: GitAdapter): string {
  let ref = base;
  for (const merge of mainMerges) if (git.changed(base, `${merge}^2`, file)) ref = `${merge}^2`;
  return git.show(ref, file);
}

/** The base titles that are absent at HEAD without a complete ledger entry, as messages. */
export function unexplainedRemovals(args: {
  baseTitles: Record<string, string[]>;
  titlesAtHead: (file: string) => string[];
  ledger: LedgerEntry[];
}): string[] {
  const { baseTitles, titlesAtHead, ledger } = args;
  const problems: string[] = [];
  for (const [file, titles] of Object.entries(baseTitles)) {
    const count = (list: string[], title: string): number => list.filter((t) => t === title).length;
    const atHead = titlesAtHead(file);
    for (const title of new Set(titles)) {
      if (count(atHead, title) >= count(titles, title)) continue;
      const key = `${file}::${title}`;
      const entries = ledger.filter((e) => e.deleted === key || e.changed === key);
      if (entries.length === 0) { problems.push(`${key}: removed without an entry in test-replacements.json`); continue; }
      const ok = entries.some((e) => {
        const target = e.replacedBy.includes('::') ? splitKey(e.replacedBy) : undefined;
        return target !== undefined && titlesAtHead(target.file).includes(target.title) && e.property.trim() !== '' && e.proof.trim() !== '';
      });
      if (!ok) problems.push(`${key}: its entry needs a replacedBy that exists at HEAD, a property and a proof`);
    }
  }
  return problems;
}

/** Fails, naming the tag and the cure, when the base tag is not in the clone (a depth-1 checkout has no tags). */
export function requireBaseTag(base: string, git: (...args: string[]) => string): void {
  try {
    git('rev-parse', '--verify', '--quiet', `${base}^{commit}`);
  } catch (cause) {
    throw new Error(`the tag ${base} was not found: this gate reads files at that tag, so CI needs a full checkout (actions/checkout with fetch-depth: 0)`, { cause });
  }
}
