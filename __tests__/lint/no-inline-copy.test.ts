import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, onTestFinished } from 'vitest';

/**
 * Plan 1A Task 13: no user-facing words in JSX outside copy modules (stage-1a-foundation-plan.md, "Copy modules: the
 * convention"). Every `.tsx` under `app/` and `components/`, except the development gallery under `app/dev/`, is read
 * with the TypeScript compiler, and two things are findings:
 *  (a) text a reader sees: a JsxText node, or a JSX child that is wholly a string literal (`{'Two words'}`), whose
 *      text holds at least two words of two or more letters, a character reference (`&nbsp;`) counting as a space;
 *  (b) a string literal given directly to one of the props in PROPS, when it holds a letter.
 * A value that is a name, a member (`X_COPY.y`), a call, a conditional or a template with substitutions is not a
 * finding. The findings at the rule's introduction are in no-inline-copy.allow.json, which may only shrink: a new
 * finding fails, and so does an entry no longer found. The list is created once, by
 *   UPDATE_ALLOW=1 npx vitest run __tests__/lint/no-inline-copy.test.ts
 * which refuses to run while the file exists; entries are removed by hand as later tasks move the words.
 */

export const PROPS = new Set([
  'aria-label', 'title', 'placeholder', 'alt', 'label', 'legend', 'hint', 'caption', 'actionLabel', 'consequence', 'objectName',
]);

export const LIST = '__tests__/lint/no-inline-copy.allow.json';
export const REASON = 'Inline in JSX when the no-inline-copy rule was introduced (plan 1A Task 13); plan 1A Tasks 16 to 20 and plans 1B and 1C move it into a copy module.';

export type Kind = 'text' | 'braces' | 'prop';
export type Finding = { file: string; text: string; kind: Kind };
export type Entry = { file: string; text: string; reason: string };

export const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A character reference (`&nbsp;`, `&#39;`, `&#x27;`) is not a word and does not join two words into one. */
const CHARACTER_REFERENCE = /&(#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi;
const twoWords = (text: string): boolean => [...text.replace(CHARACTER_REFERENCE, ' ').matchAll(/\p{L}{2,}/gu)].length >= 2;
const hasLetter = (text: string): boolean => /\p{L}/u.test(text);

/** A plain string literal or a template with no substitution: the text it holds, as the source spells it. */
const literalText = (node: ts.Node | undefined): string | null =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;

/** The findings in `src`, the text of the `.tsx` file `file`, in source order. */
export function inlineCopyFindings(file: string, src: string): Finding[] {
  const out: Finding[] = [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const text = normalise(node.text);
      if (twoWords(text)) out.push({ file, text, kind: 'text' });
    } else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      const literal = literalText(node.expression);
      if (literal !== null && twoWords(normalise(literal))) out.push({ file, text: normalise(literal), kind: 'braces' });
    } else if (ts.isJsxAttribute(node) && PROPS.has(node.name.getText(sf)) && node.initializer !== undefined) {
      const value = node.initializer;
      const literal = ts.isJsxExpression(value) ? literalText(value.expression) : literalText(value);
      if (literal !== null && hasLetter(literal)) out.push({ file, text: normalise(literal), kind: 'prop' });
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

/** The write mode: creates the list at `path` when it does not exist, and refuses when it does (the list only shrinks). */
export function createAllowList(path: string, entries: Entry[]): void {
  if (existsSync(path)) throw new Error(`${path} exists. UPDATE_ALLOW=1 only creates it; the list may only shrink, and entries are removed by hand.`);
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, { flag: 'wx' });
}

// ---- (harness) ---------------------------------------------------------------------------------------------

const H = 'components/example/Example.tsx';
const texts = (src: string) => inlineCopyFindings(H, src).map((f) => f.text);

describe('no inline copy (harness)', () => {
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

  it('plan 1A Task 13 (harness): a string literal that is the whole JSX child counts; a conditional does not', () => {
    expect(texts("const A = () => <p>{'Two words here'}</p>;")).toEqual(['Two words here']);
    expect(texts('const A = () => <p>{`Two words here`}</p>;')).toEqual(['Two words here']);
    expect(texts("const A = () => <p>{'Save'}</p>;")).toEqual([]);
    expect(texts("const A = (x: boolean) => <p>{x ? 'Two words' : 'Other words'}</p>;")).toEqual([]);
    expect(texts("const A = (x: boolean) => <p>{x && 'Two words'}</p>;")).toEqual([]);
    expect(texts('const A = (n: number) => <p>{`${n} words here`}</p>;')).toEqual([]);
  });

  it('plan 1A Task 13 (harness): each listed prop given a string literal is found, in both spellings', () => {
    for (const prop of PROPS) {
      expect(texts(`const A = () => <X ${prop}="Save" />;`), prop).toEqual(['Save']);
      expect(texts(`const A = () => <X ${prop}={'Save it'} />;`), prop).toEqual(['Save it']);
      expect(texts(`const A = () => <X ${prop}={\`Save it\`} />;`), prop).toEqual(['Save it']);
    }
  });

  it('plan 1A Task 13 (harness): a prop value with no letter is not found; one word is', () => {
    expect(texts('const A = () => <img alt="" src="a.png" />;')).toEqual([]);
    expect(texts('const A = () => <X label="1" title="·" />;')).toEqual([]);
    expect(texts('const A = () => <button title="Save" />;')).toEqual(['Save']);
  });

  it('plan 1A Task 13 (harness): a copy constant, a call, a template with substitutions and an unlisted prop are not found', () => {
    expect(texts('const A = () => <X label={UI_COPY.save} title={t()} hint={`${n} left`} />;')).toEqual([]);
    expect(texts('const A = () => <X className="two words" data-x="Two words" id="save-now" />;')).toEqual([]);
    expect(texts('const A = () => <p>{UI_COPY.intro}</p>;')).toEqual([]);
  });

  it('plan 1A Task 13 (harness): findings carry their kind', () => {
    const kinds = inlineCopyFindings(H, "const A = () => <p title=\"Save\">Two words{'Brace words'}</p>;").map((f) => f.kind).sort();
    expect(kinds).toEqual(['braces', 'prop', 'text']);
  });

  it('plan 1A Task 13 (harness): entries are one per file and text, sorted by file then text', () => {
    const f = (file: string, text: string, kind: Kind): Finding => ({ file, text, kind });
    expect(entriesOf([f('b.tsx', 'Zed one', 'text'), f('a.tsx', 'Two words', 'text'), f('a.tsx', 'Two words', 'prop'), f('a.tsx', 'Also here', 'braces')])).toEqual([
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
});

// ---- the tree ----------------------------------------------------------------------------------------------

/** Every `.tsx` under `app/` and `components/`, as a path relative to the repository root, outside `app/dev/`. */
function scannedFiles(): string[] {
  return ['app', 'components']
    .flatMap((dir) => readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((f) => posix.join(dir, f.split(sep).join('/'))))
    .filter((f) => f.endsWith('.tsx') && !f.startsWith('app/dev/'))
    .sort();
}

describe('no inline copy', () => {
  const files = scannedFiles();
  const found = entriesOf(files.flatMap((file) => inlineCopyFindings(file, readFileSync(file, 'utf8'))));

  it('plan 1A Task 13: the walk reads the pages and components, and skips app/dev/ only', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('app/layout.tsx');
    expect(files.some((f) => f.startsWith('app/dev/'))).toBe(false);
  });

  it('plan 1A Task 13: every inline word in JSX is in no-inline-copy.allow.json, and every entry is still found', () => {
    if (process.env.UPDATE_ALLOW === '1') createAllowList(LIST, found);
    expect(existsSync(LIST), `${LIST} is missing; it is created once by UPDATE_ALLOW=1`).toBe(true);
    const listed = JSON.parse(readFileSync(LIST, 'utf8')) as Entry[];
    expect(listProblems(found, listed)).toEqual([]);
  });

  it('plan 1A Task 13: the list is well formed: sorted, one entry per file and text, normalised, with the fixed reason', () => {
    expect(existsSync(LIST), `${LIST} is missing; it is created once by UPDATE_ALLOW=1`).toBe(true);
    const listed = JSON.parse(readFileSync(LIST, 'utf8')) as Entry[];
    expect(listed.every((e) => Object.keys(e).join() === 'file,text,reason' && e.reason === REASON)).toBe(true);
    expect(listed.every((e) => e.text === e.text.replace(/\s+/g, ' ').trim() && e.text !== '')).toBe(true);
    expect(listed).toEqual(entriesOf(listed.map((e) => ({ file: e.file, text: e.text, kind: 'text' }))));
  });
});
