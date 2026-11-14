import { existsSync, readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { ROOT, repoFiles } from './repo-files';

/**
 * Shared by __tests__/lint/kit-styles-entries.test.ts and __tests__/lint/invitation-kit-sheets.test.ts: how a source
 * file names another module, where that name points, and which modules of components/ui/ are styles entries.
 *
 * A styles entry is `components/ui/<part>Styles.ts`: only stylesheet imports (and imports of other styles entries) and
 * comments. Why the kit has them is said once, in components/ui/formStyles.ts: in every build measured, sheets that
 * reach pages only through one module were served as one file; that is observed, not derived from the bundler's code,
 * and the built page's checks (the stylesheet count and contents in e2e/invitation-name-transfer.spec.ts, and the byte
 * limits of that spec and e2e/first-visit-transfer.spec.ts) are what confirm it.
 *
 * What the scan cannot see: a specifier built at run time (`'…' + name`, a variable, a template literal with `${}`
 * that does not spell `components/ui/` and `.css`), and an alias other than `@/` (tsconfig.json has only that one).
 */

export const KIT = 'components/ui';
export const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'];

export type Form = 'from' | 'bare' | 'import()' | 'require()' | '@import';
/** A module a file names; `inText` when the import itself sits inside a comment or a string (a commented-out import, or
 * code a script writes out as text). */
export type Spec = { spec: string; form: Form; inText: boolean };

// Whitespace or block comments, as between `import(` and its string (`import(/* webpackChunkName: "x" */ '…')`).
const GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/)*`;
// A quote, a double quote or a backtick (a template literal with no substitution).
const Q = String.raw`(['"\`])([^'"\`]+)\1`;
const SOURCE_FORMS: ReadonlyArray<[Form, RegExp]> = [
  ['from', new RegExp(String.raw`\bfrom${GAP}${Q}`, 'g')],                 // import … from, export … from
  ['bare', new RegExp(String.raw`\bimport${GAP}${Q}`, 'g')],               // import '…' (side effect)
  ['import()', new RegExp(String.raw`\bimport\s*\(${GAP}${Q}`, 'g')],     // import('…'), with or without more arguments
  ['require()', new RegExp(String.raw`\brequire\s*\(${GAP}${Q}`, 'g')],   // require('…')
];
// @import '…', @import"…", @import url(…) with or without quotes, in any case.
const CSS_IMPORT = /@import\s*(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/gi;

/**
 * The [start, end) ranges of a file's comments and strings. A small reader; it does not know regular expression
 * literals, so a quote inside one can make it misplace a range. That only decides whether a name that matches no file
 * is an error (see resolveSpec); what is reported as an import is the same either way.
 */
export function textRanges(src: string, css: boolean): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      ranges.push([i, stop]);
      i = stop;
    } else if (!css && c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      ranges.push([i, stop]);
      i = stop;
    } else if (c === '\'' || c === '"' || (!css && c === '`')) {
      const start = i;
      i += 1;
      while (i < src.length && src[i] !== c && !(c !== '`' && src[i] === '\n')) i += src[i] === '\\' ? 2 : 1;
      i += 1;
      ranges.push([start, i]);
    } else {
      i += 1;
    }
  }
  return ranges;
}

/** Every module a file names, in every import form, commented-out imports and imports written in strings included
 * (they over-report, which is safe). */
export function specifiers(file: string, src: string): Spec[] {
  const css = file.endsWith('.css');
  const text = textRanges(src, css);
  const inText = (at: number) => text.some(([a, b]) => at >= a && at < b);
  const forms: ReadonlyArray<[Form, RegExp]> = css ? [['@import', CSS_IMPORT]] : SOURCE_FORMS;
  return forms.flatMap(([form, re]) => [...src.matchAll(re)].map((m) => ({ spec: m[2], form, inText: inText(m.index) })));
}

const isFile = (p: string) => existsSync(posix.join(ROOT, p)) && statSync(posix.join(ROOT, p)).isFile();

/**
 * The repository path a specifier names, or null for a package. `@/` is the repository root (tsconfig paths); `./` and
 * `../` are relative to the importing file; any other specifier that names `components/ui/…` is taken at that path, so
 * an odd form (an absolute path, a bare path) still counts. A `?query` or `#fragment` is cut first. A module without
 * its extension is looked up with each source extension and as an index file. A relative or `@/` name that matches no
 * file throws "<file>: cannot resolve <specifier>", unless `lenient` (the import sits in a comment or a string), when
 * it is returned as written.
 */
export function resolveSpec(from: string, spec: string, lenient = false): string | null {
  const path = spec.replace(/[?#].*$/, '');
  let base: string;
  if (path.startsWith('@/')) base = path.slice(2);
  else if (path.startsWith('./') || path.startsWith('../')) base = posix.join(posix.dirname(from), path);
  else if (path.includes(`${KIT}/`)) return posix.normalize(path.slice(path.indexOf(`${KIT}/`)));
  else return null;
  base = posix.normalize(base);
  const candidates = [base, ...EXTENSIONS.map((e) => `${base}.${e}`), ...EXTENSIONS.map((e) => `${base}/index.${e}`)];
  const found = candidates.find(isFile);
  if (found !== undefined) return found;
  if (lenient) return base;
  throw new Error(`${from}: cannot resolve ${spec}`);
}

/** resolveSpec for a name found by specifiers(). */
export const resolveOf = (from: string, s: Spec) => resolveSpec(from, s.spec, s.inText);

/** Whether a repository path is a file a bundle can include: source or a stylesheet, outside __tests__/ and e2e/. */
export const isBundled = (f: string) => (SOURCE_EXT.test(f) || f.endsWith('.css')) && !f.startsWith('__tests__/') && !f.startsWith('e2e/');

/** Every file a bundle can include, tracked or untracked, .gitignore applied. */
export const bundledFiles = (): string[] => repoFiles().filter(isBundled);

export const isKitSheet = (path: string | null): path is string => path !== null && path.startsWith(`${KIT}/`) && path.endsWith('.css');

export const read = (path: string) => readFileSync(posix.join(ROOT, path), 'utf8');

export const ENTRY_NAME = /^components\/ui\/[A-Za-z]+Styles\.ts$/;

/** The styles entries on disk. */
export const entryFiles = (): string[] => repoFiles().filter((f) => ENTRY_NAME.test(f));

/** What an entry's text holds once its comments are gone: each line `import './X';`, else the offending lines. */
export function entryBody(src: string): { imports: string[]; other: string[] } {
  const lines = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const imports: string[] = [];
  const other: string[] = [];
  for (const line of lines) {
    const m = /^import\s+'(\.\/[A-Za-z][\w-]*(?:\.css)?)';$/.exec(line);
    if (m) imports.push(m[1]);
    else other.push(line);
  }
  return { imports, other };
}

/** Each kit sheet a styles entry names, with that entry (the one importer lint (b) allows it). */
export function sheetsOfEntries(): Map<string, string> {
  const sheetEntry = new Map<string, string>();
  for (const entry of entryFiles()) {
    for (const spec of entryBody(read(entry)).imports) {
      const target = resolveSpec(entry, spec);
      if (isKitSheet(target)) sheetEntry.set(target, entry);
    }
  }
  return sheetEntry;
}

/** What a file writes in place of an import of `sheet`. */
export function insteadOf(sheet: string, sheetEntry: Map<string, string>): string {
  const entry = sheetEntry.get(sheet);
  if (entry) return `write import '@/${entry.replace(/\.ts$/, '')}'; instead`;
  return `import the kit component that uses ${posix.basename(sheet)} instead, or ask lane 1 for a styles entry in ${KIT}/`;
}
