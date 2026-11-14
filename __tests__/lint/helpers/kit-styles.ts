import { existsSync, readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { ROOT, repoFiles } from './repo-files';

/**
 * Shared by __tests__/lint/kit-styles-entries.test.ts and __tests__/lint/invitation-kit-sheets.test.ts: how a source
 * file names another module, where that name points, and which modules of components/ui/ are styles entries.
 *
 * A styles entry is `components/ui/<part>Styles.ts`: only stylesheet imports (and imports of other styles entries) and
 * comments. Turbopack's default CSS chunking keeps two stylesheets in one built file only while exactly the same entries
 * (layouts, pages, not-found pages) load both, so sheets that only ever arrive through one module are never cut apart
 * (components/ui/formStyles.ts).
 */

export const KIT = 'components/ui';
export const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

export type Form = 'from' | 'bare' | 'import()' | 'require()' | '@import';
export type Spec = { spec: string; form: Form };

// A quote, a double quote or a backtick (a template literal with no substitution).
const Q = String.raw`(['"\`])([^'"\`]+)\1`;
const SOURCE_FORMS: ReadonlyArray<[Form, RegExp]> = [
  ['from', new RegExp(String.raw`\bfrom\s*${Q}`, 'g')],                     // import … from, export … from
  ['bare', new RegExp(String.raw`\bimport\s*${Q}`, 'g')],                   // import '…' (side effect)
  ['import()', new RegExp(String.raw`\bimport\s*\(\s*${Q}\s*\)`, 'g')],     // import('…')
  ['require()', new RegExp(String.raw`\brequire\s*\(\s*${Q}\s*\)`, 'g')],   // require('…')
];
// @import '…', @import "…", @import url(…) with or without quotes.
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/g;

/** Every module a file names, in every import form. Comments are not stripped: a commented import counts, which only over-reports. */
export function specifiers(file: string, src: string): Spec[] {
  if (file.endsWith('.css')) return [...src.matchAll(CSS_IMPORT)].map((m) => ({ spec: m[2], form: '@import' as const }));
  return SOURCE_FORMS.flatMap(([form, re]) => [...src.matchAll(re)].map((m) => ({ spec: m[2], form })));
}

const isFile = (p: string) => existsSync(posix.join(ROOT, p)) && statSync(posix.join(ROOT, p)).isFile();

/**
 * The repository path a specifier names, or null for a package. `@/` is the repository root (tsconfig paths); `./` and
 * `../` are relative to the importing file; any other specifier that names `components/ui/…` is taken at that path, so
 * an odd form (an absolute path, a bare path) still counts. A module without its extension is looked up as .ts, .tsx,
 * .js, .mjs or an index file; a name that matches no file is returned as written.
 */
export function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('./') || spec.startsWith('../')) base = posix.join(posix.dirname(from), spec);
  else if (spec.includes(`${KIT}/`)) base = spec.slice(spec.indexOf(`${KIT}/`));
  else return null;
  base = posix.normalize(base);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (isFile(candidate)) return candidate;
  }
  return base;
}

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
