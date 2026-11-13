import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, onTestFinished } from 'vitest';

/**
 * Plan 1A Task 13: no user-facing words in JSX outside copy modules (stage-1a-foundation-plan.md, "Copy modules: the
 * convention"). Every `.tsx` under `app/` and `components/`, except under the folder `app/dev/` (the development
 * gallery), is read with the TypeScript compiler.
 *
 * The text of an expression, after unwrapping parentheses, `as`, `satisfies` and `!`: a string literal's or a
 * plain template's own text; a template with substitutions, its literal parts in order with PLACEHOLDER for each
 * substitution (`At least ${…} characters.`); a `+` chain, each operand's text in order with PLACEHOLDER for an
 * operand that has none, and no text when no operand has any. Anything else (a name, a member, a call, an object,
 * an array, a JSX element) has no text. The leaves of an expression: both branches of a conditional, both sides of
 * `&&`, `||` and `??`, recursively; anything else is its own leaf.
 *
 * Findings, stored as normalised text with their placeholders:
 *  (a) a JsxText node, and each leaf with text of a JSX child `{expression}`, whose text holds at least two words of
 *      two or more letters (a placeholder or a character reference such as `&nbsp;` is not a word and joins none);
 *  (b) each leaf with text of the value of a prop in PROPS (`prop="…"` or `prop={expression}`) whose text holds a
 *      letter outside placeholders and character references.
 * Not read, on purpose: a literal inside a call's arguments, in an object or array literal, or held in a variable;
 * a one-word JsxText (the plan's threshold); and text split across children where no single piece holds two words.
 *
 * The findings when the rule was introduced are in no-inline-copy.allow.json, one entry per file and text. A new
 * finding fails, and so does an entry no longer found. The list is created once, by
 *   UPDATE_ALLOW=1 npx vitest run __tests__/lint/no-inline-copy.test.ts
 * which refuses while the file exists, so it cannot overwrite the list; and the list never holds more than CEILING
 * entries. Neither stops an entry swapped for another, or a file deleted and generated again: those are for the
 * review of the change. Entries are removed by hand as later tasks move the words into copy modules.
 */

export const PROPS = new Set([
  'aria-label', 'title', 'placeholder', 'alt', 'label', 'legend', 'hint', 'caption', 'actionLabel', 'consequence', 'objectName',
]);

export const LIST = '__tests__/lint/no-inline-copy.allow.json';
export const REASON = 'Inline in JSX when the no-inline-copy rule was introduced (plan 1A Task 13); plan 1A Tasks 16 to 20 and plans 1B and 1C move it into a copy module.';
/** Written for each substitution, and for each `+` operand that has no text. */
export const PLACEHOLDER = '${…}';

export type Finding = { file: string; text: string };
export type Entry = { file: string; text: string; reason: string };

export const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A character reference (`&nbsp;`, `&#39;`, `&#x27;`) is not a word and does not join two words into one. */
const CHARACTER_REFERENCE = /&(#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi;
const bare = (text: string): string => text.split(PLACEHOLDER).join(' ').replace(CHARACTER_REFERENCE, ' ');
const twoWords = (text: string): boolean => [...bare(text).matchAll(/\p{L}{2,}/gu)].length >= 2;
const hasLetter = (text: string): boolean => /\p{L}/u.test(bare(text));

const LOGICAL = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);

function unwrapped(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

/** The operands of a `+` chain, left to right: `a + b + c` gives `a`, `b`, `c`. */
function plusOperands(e: ts.BinaryExpression): ts.Expression[] {
  const left = e.left;
  const head = ts.isBinaryExpression(left) && left.operatorToken.kind === ts.SyntaxKind.PlusToken ? plusOperands(left) : [left];
  return [...head, e.right];
}

/** The text of an expression (see the header), or null when it has none. */
export function textOf(node: ts.Expression): string | null {
  const e = unwrapped(node);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((span) => PLACEHOLDER + span.literal.text).join('');
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const parts = plusOperands(e).map(textOf);
    return parts.every((part) => part === null) ? null : parts.map((part) => (part === null ? PLACEHOLDER : part)).join('');
  }
  return null;
}

/** The leaves of an expression (see the header), parentheses unwrapped on the way. */
export function leaves(node: ts.Expression): ts.Expression[] {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isConditionalExpression(e)) return [...leaves(e.whenTrue), ...leaves(e.whenFalse)];
  if (ts.isBinaryExpression(e) && LOGICAL.has(e.operatorToken.kind)) return [...leaves(e.left), ...leaves(e.right)];
  return [e];
}

/** The normalised texts of the leaves of `expression` that have text. */
const leafTexts = (expression: ts.Expression): string[] =>
  leaves(expression).map(textOf).filter((t): t is string => t !== null).map(normalise);

/** The findings in `src`, the text of the `.tsx` file `file`, in source order. */
export function inlineCopyFindings(file: string, src: string): Finding[] {
  const out: Finding[] = [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const text = normalise(node.text);
      if (twoWords(text)) out.push({ file, text });
    } else if (ts.isJsxExpression(node) && node.expression !== undefined && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const text of leafTexts(node.expression)) if (twoWords(text)) out.push({ file, text });
    } else if (ts.isJsxAttribute(node) && PROPS.has(node.name.getText(sf)) && node.initializer !== undefined) {
      const value = node.initializer;
      const texts = ts.isStringLiteral(value) ? [normalise(value.text)] : ts.isJsxExpression(value) && value.expression !== undefined ? leafTexts(value.expression) : [];
      for (const text of texts) if (hasLetter(text)) out.push({ file, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const byFileThenText = (x: { file: string; text: string }, y: { file: string; text: string }): number =>
  x.file < y.file ? -1 : x.file > y.file ? 1 : x.text < y.text ? -1 : x.text > y.text ? 1 : 0;
const key = (e: { file: string; text: string }): string => JSON.stringify([e.file, e.text]);

/** One entry per distinct file and text, sorted by file then text (code-unit order, the same on every machine). */
export function entriesOf(findings: Finding[]): Entry[] {
  const unique = new Map(findings.map((f) => [key(f), { file: f.file, text: f.text, reason: REASON }]));
  return [...unique.values()].sort(byFileThenText);
}

/** A message for each finding the list does not hold, and for each listed entry no longer found. */
export function listProblems(found: Entry[], listed: Entry[]): string[] {
  const foundKeys = new Set(found.map(key));
  const listedKeys = new Set(listed.map(key));
  return [
    ...found.filter((e) => !listedKeys.has(key(e))).map((e) =>
      `${e.file}: "${e.text}" is user-facing text written in JSX. Move it into the area's copy module lib/<area>/copy.ts; the allow-list is not added to.`),
    ...listed.filter((e) => !foundKeys.has(key(e))).map((e) =>
      `${e.file}: "${e.text}" is no longer found. Its entry is removed by hand from ${LIST}.`),
  ];
}

/** The write mode: creates the list at `path` when it does not exist, and refuses when it does (it never overwrites). */
export function createAllowList(path: string, entries: Entry[]): void {
  if (existsSync(path)) throw new Error(`${path} exists. UPDATE_ALLOW=1 only creates the list and never overwrites it; entries are removed by hand as their words move into copy modules.`);
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, { flag: 'wx' });
}

/** Whether the walk reads `path`: a `.tsx` under `app/` or `components/`, and not under the folder `app/dev/`. */
export function isScanned(path: string): boolean {
  return path.endsWith('.tsx') && (path.startsWith('app/') || path.startsWith('components/')) && !path.startsWith('app/dev/');
}

const isEntry = (e: unknown): e is Entry =>
  typeof e === 'object' && e !== null && !Array.isArray(e) &&
  typeof (e as Entry).file === 'string' && typeof (e as Entry).text === 'string' && typeof (e as Entry).reason === 'string';

/** The list at `path`, after checking that it exists and is an array of `{ file, text, reason }` with string values. */
export function readList(path: string): Entry[] {
  if (!existsSync(path)) throw new Error(`${path} is missing; it is created once by UPDATE_ALLOW=1`);
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(data)) throw new Error(`${path} is not an array of { file, text, reason }`);
  const malformed = data.filter((e) => !isEntry(e));
  if (malformed.length > 0) throw new Error(`${path} holds entries that are not { file, text, reason } with string values: ${malformed.map((e) => JSON.stringify(e)).join('; ')}`);
  return data;
}

// ---- (harness) ---------------------------------------------------------------------------------------------

const H = 'components/example/Example.tsx';
const texts = (src: string) => inlineCopyFindings(H, src).map((f) => f.text);

describe('no inline copy (harness)', () => {
  it('plan 1A Task 13 (harness): the listed props are the eleven the plan names', () => {
    expect([...PROPS]).toEqual([
      'aria-label', 'title', 'placeholder', 'alt', 'label', 'legend', 'hint', 'caption', 'actionLabel', 'consequence', 'objectName',
    ]);
  });

  it('plan 1A Task 13 (harness): the walk reads .tsx under app/ and components/, except under the folder app/dev/', () => {
    const paths = ['app/dev/ui-kit/page.tsx', 'app/devices/page.tsx', 'app/developer.tsx', 'components/x/A.tsx', 'app/x.ts', 'lib/x/A.tsx', 'app/dev.tsx'];
    expect(paths.filter(isScanned)).toEqual(['app/devices/page.tsx', 'app/developer.tsx', 'components/x/A.tsx', 'app/dev.tsx']);
  });

  it('plan 1A Task 13 (harness): JSX text of two words is found; one word and punctuation are not', () => {
    expect(texts('const A = () => <p>Save the record</p>;')).toEqual(['Save the record']);
    expect(texts('const A = () => <p>\n   Save   the\n record </p>;')).toEqual(['Save the record']);
    expect(texts('const A = () => <p>Save</p>;')).toEqual([]);
    expect(texts('const A = () => <p> · — : ( ) </p>;')).toEqual([]);
    expect(texts('const A = () => <p>A b</p>;')).toEqual([]);
  });

  it('plan 1A Task 13 (harness): a character reference separates words and is not one', () => {
    expect(texts('const A = () => <p>Save&nbsp;now</p>;')).toEqual(['Save&nbsp;now']);
    expect(texts('const A = () => <p>&nbsp;OK&nbsp;</p>;')).toEqual([]);
    expect(texts('const A = () => <p>&apos;&#39;&#x27;&amp;</p>;')).toEqual([]);
  });

  it('plan 1A Task 13 (harness): a string literal that is the whole JSX child counts, parenthesised or asserted too', () => {
    expect(texts("const A = () => <p>{'Two words here'}</p>;")).toEqual(['Two words here']);
    expect(texts('const A = () => <p>{`Two words here`}</p>;')).toEqual(['Two words here']);
    expect(texts("const A = () => <p>{'Save'}</p>;")).toEqual([]);
    expect(texts("const A = () => <p>{('Two words')}</p>;")).toEqual(['Two words']);
    expect(texts("const A = () => <p>{'Two words' as const}</p>;")).toEqual(['Two words']);
    expect(texts("const A = () => <p>{('Two words' satisfies string)}</p>;")).toEqual(['Two words']);
  });

  it('plan 1A Task 13 (harness): a template child is found with a placeholder per substitution; one word in its parts is not', () => {
    expect(texts('const A = () => <p>{`At least ${MIN} characters.`}</p>;')).toEqual(['At least ${…} characters.']);
    expect(texts('const A = (n: number) => <p>{`${n} items`}</p>;')).toEqual([]);
    expect(texts('const A = () => <p>{`${a} ${b}`}</p>;')).toEqual([]);
  });

  it('plan 1A Task 13 (harness): each branch of a conditional child is judged on its own', () => {
    expect(texts("const A = (x: boolean) => <p>{x ? 'Two words' : 'Other words'}</p>;")).toEqual(['Two words', 'Other words']);
    expect(texts("const A = (x: boolean) => <p>{x ? 'Sign in' : 'Save'}</p>;")).toEqual(['Sign in']);
    expect(texts("const A = (a: boolean, b: boolean) => <p>{a ? 'First two' : b ? 'Second two' : 'Third two'}</p>;")).toEqual(['First two', 'Second two', 'Third two']);
    expect(texts("const A = (a: boolean, b: boolean) => <p>{a ? (b ? 'Inner two' : 'Save') : 'Outer two'}</p>;")).toEqual(['Inner two', 'Outer two']);
  });

  it('plan 1A Task 13 (harness): the literal sides of &&, || and ?? children are found', () => {
    expect(texts("const A = (x: boolean) => <p>{x && 'Two words'}</p>;")).toEqual(['Two words']);
    expect(texts("const A = (x: string) => <p>{x || 'Not set yet'}</p>;")).toEqual(['Not set yet']);
    expect(texts("const A = (x?: string) => <p>{x ?? 'Not recorded here'}</p>;")).toEqual(['Not recorded here']);
  });

  it('plan 1A Task 13 (harness): a + join is found with a placeholder per operand that has no text; arithmetic is not', () => {
    expect(texts("const A = (name: string) => <p>{'Hello ' + name + ' and welcome'}</p>;")).toEqual(['Hello ${…} and welcome']);
    expect(texts('const A = (n: number) => <p>{n + 1}</p>;')).toEqual([]);
  });

  it('plan 1A Task 13 (harness): a literal inside a call, an object or a variable is not found', () => {
    expect(texts("const A = () => <p>{t('Two words')}</p>;")).toEqual([]);
    expect(texts("const A = () => <X label={t('Two words')} />;")).toEqual([]);
    expect(texts("const A = () => <X items={[{ label: 'Two words' }]} />;")).toEqual([]);
    expect(texts("const W = 'Two words';\nconst A = () => <p>{W}</p>;")).toEqual([]);
  });

  it('plan 1A Task 13 (harness): a conditional whose branch is a JSX element finds the element text once', () => {
    expect(texts("const A = (x: boolean) => <p>{x ? <b>Two words</b> : null}</p>;")).toEqual(['Two words']);
    expect(texts("const A = (x: boolean) => <p>{x && <b title='Bold'>Two words</b>}</p>;")).toEqual(['Bold', 'Two words']);
  });

  it('plan 1A Task 13 (harness): each listed prop given a string literal is found, in both spellings', () => {
    for (const prop of PROPS) {
      expect(texts(`const A = () => <X ${prop}="Save" />;`), prop).toEqual(['Save']);
      expect(texts(`const A = () => <X ${prop}={'Save it'} />;`), prop).toEqual(['Save it']);
      expect(texts(`const A = () => <X ${prop}={\`Save it\`} />;`), prop).toEqual(['Save it']);
    }
  });

  it('plan 1A Task 13 (harness): a listed prop given a template or a conditional is found per leaf', () => {
    expect(texts('const A = (name: string) => <X aria-label={`Remove ${name}`} />;')).toEqual(['Remove ${…}']);
    expect(texts("const A = (x: boolean) => <X title={x ? 'Switch to light' : 'Dark'} />;")).toEqual(['Switch to light', 'Dark']);
    expect(texts("const A = (x: boolean) => <X label={x && 'Shown'} />;")).toEqual(['Shown']);
  });

  it('plan 1A Task 13 (harness): a prop value with no letter is not found; one word is', () => {
    expect(texts('const A = () => <img alt="" src="a.png" />;')).toEqual([]);
    expect(texts('const A = () => <X label="1" title="·" />;')).toEqual([]);
    expect(texts('const A = () => <X title="&middot;" />;')).toEqual([]);
    expect(texts('const A = (n: number) => <X label={`${n}`} />;')).toEqual([]);
    expect(texts('const A = () => <button title="Save" />;')).toEqual(['Save']);
  });

  it('plan 1A Task 13 (harness): a copy constant, a call and an unlisted prop are not found', () => {
    expect(texts('const A = () => <X label={UI_COPY.save} title={t()} hint={copy.hint(n)} />;')).toEqual([]);
    expect(texts('const A = () => <X className="two words" data-x="Two words" id="save-now" />;')).toEqual([]);
    expect(texts('const A = () => <p>{UI_COPY.intro}</p>;')).toEqual([]);
  });

  it('plan 1A Task 13 (harness): entries are one per file and text, sorted by file then text', () => {
    const f = (file: string, text: string) => ({ file, text });
    expect(entriesOf([f('b.tsx', 'Zed one'), f('a.tsx', 'Two words'), f('a.tsx', 'Two words'), f('a.tsx', 'Also here')])).toEqual([
      { file: 'a.tsx', text: 'Also here', reason: REASON },
      { file: 'a.tsx', text: 'Two words', reason: REASON },
      { file: 'b.tsx', text: 'Zed one', reason: REASON },
    ]);
  });

  it('plan 1A Task 13 (harness): a new finding and a stale entry each fail, naming file and text', () => {
    const e = (file: string, text: string): Entry => ({ file, text, reason: REASON });
    expect(listProblems([e('a.tsx', 'Same words')], [e('a.tsx', 'Same words')])).toEqual([]);
    const [added] = listProblems([e('a.tsx', 'New words')], []);
    expect(added).toContain('a.tsx');
    expect(added).toContain('New words');
    expect(added).toContain('copy.ts');
    const [stale] = listProblems([], [e('a.tsx', 'Old words')]);
    expect(stale).toContain('a.tsx');
    expect(stale).toContain('Old words');
    expect(stale).toContain('removed by hand');
  });

  it('plan 1A Task 13 (harness): the write mode creates the list once and refuses while it exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-inline-copy-'));
    onTestFinished(() => rmSync(dir, { recursive: true }));
    const path = join(dir, 'allow.json');
    const entries = [{ file: 'a.tsx', text: 'Two words', reason: REASON }];
    createAllowList(path, entries);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(entries);
    writeFileSync(path, '[]\n');
    expect(() => createAllowList(path, entries)).toThrow(/removed by hand/);
    expect(readFileSync(path, 'utf8')).toBe('[]\n');
  });

  it('plan 1A Task 13 (harness): reading the list fails on a missing file, a non-array and an entry of the wrong shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-inline-copy-'));
    onTestFinished(() => rmSync(dir, { recursive: true }));
    const path = join(dir, 'allow.json');
    expect(() => readList(path)).toThrow(/is missing/);
    writeFileSync(path, '{}\n');
    expect(() => readList(path)).toThrow(/is not an array/);
    writeFileSync(path, JSON.stringify([{ file: 'a.tsx', text: 7, reason: REASON }]));
    expect(() => readList(path)).toThrow(/"text":7/);
    const good = [{ file: 'a.tsx', text: 'Two words', reason: REASON }];
    writeFileSync(path, JSON.stringify(good));
    expect(readList(path)).toEqual(good);
  });
});

// ---- the tree ----------------------------------------------------------------------------------------------

/**
 * The number of entries the list held when it was generated. Never raised; it may be lowered as the list shrinks, and
 * need not be.
 */
export const CEILING = 579;

/** Every file the walk reads (`isScanned`), as a path relative to the repository root. */
function scannedFiles(): string[] {
  return ['app', 'components']
    .flatMap((dir) => readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((f) => posix.join(dir, f.split(sep).join('/'))))
    .filter(isScanned)
    .sort();
}

describe('no inline copy', () => {
  const files = scannedFiles();
  const found = entriesOf(files.flatMap((file) => inlineCopyFindings(file, readFileSync(file, 'utf8'))));

  it('plan 1A Task 13: the walk finds the pages and components (more than 100 files, app/layout.tsx among them)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('app/layout.tsx');
  });

  it('plan 1A Task 13: each finding of the rule is in no-inline-copy.allow.json, and each entry is still a finding', () => {
    if (process.env.UPDATE_ALLOW === '1') createAllowList(LIST, found);
    expect(listProblems(found, readList(LIST))).toEqual([]);
  });

  it('plan 1A Task 13: the list never holds more entries than CEILING (stops net growth, not an entry swapped for another)', () => {
    const listed = readList(LIST);
    expect(
      listed.length,
      `${LIST} holds ${listed.length} entries, more than CEILING (${CEILING}). The list is not added to: move the new text into lib/<area>/copy.ts. ` +
        'This stops net growth only; an entry swapped for another is for the review of that change.',
    ).toBeLessThanOrEqual(CEILING);
  });

  it('plan 1A Task 13: the list is well formed: sorted, one entry per file and text, normalised, with the fixed reason', () => {
    const listed = readList(LIST);
    const bad = listed.filter((e) => Object.keys(e).join() !== 'file,text,reason' || e.reason !== REASON || e.text !== normalise(e.text) || e.text === '');
    expect(bad).toEqual([]);
    expect(listed).toEqual(entriesOf(listed));
  });
});
