import { readdirSync, readFileSync } from 'node:fs';
import { posix, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Plan 1A Task 13, the copy-module convention (stage-1a-foundation-plan.md, "Copy modules: the convention"). Every
 * copy module (`lib/**\/copy.ts`, or `lib/**\/copy/index.ts`, which `@/lib/<area>/copy` also resolves to) is a module
 * a browser bundle and a Playwright spec can import, so it holds words and nothing else:
 *  - imports: a whole `import type` declaration may come from any module (every compiler erases it); every other
 *    import, re-export, dynamic `import()` or `require` names `@/types/*`, `@/lib/vocabulary/terms`,
 *    `@/lib/vocabulary/verbatim`, `@/lib/format/*` or another copy module (`@/lib/<area>/copy`, or a relative path to
 *    one). An inline `import { type X }` is held to the list too. With this repository's settings it is erased
 *    (TypeScript 5.9.3 `transpileModule` with `isolatedModules`, and esbuild, emit no import for it); it survives as a
 *    bare `import {} from '…'` only under `verbatimModuleSyntax`, which tsconfig.json does not set. The rule is kept
 *    as a guard should that setting ever be turned on.
 *  - the file is `.ts` and parses as TypeScript, so it holds no JSX;
 *  - exports are named (no `export default`, no `export =`), and every exported `const` whose value is not a
 *    function, and every exported enum or class, is named in capitals (`/^[A-Z][A-Z0-9_]*$/`); exported functions
 *    and types are free of that rule, since a varying sentence is a function beside the object.
 * Not checked: `module.require`, `globalThis.require`, `require.resolve`, and the name of `export { x }` when `x` is
 * an import binding.
 */

/** `@/types/*`, the two vocabulary modules, `@/lib/format/*` and `@/lib/**\/copy` (plan 1A, "Copy modules", imports). */
const ALLOWED_ALIAS = [
  /^@\/types\/[A-Za-z0-9_./-]+$/,
  /^@\/lib\/vocabulary\/(terms|verbatim)$/,
  /^@\/lib\/format\/[A-Za-z0-9_./-]+$/,
  /^@\/lib\/([A-Za-z0-9_-]+\/)+copy$/,
];
const COPY_PATH = /^lib\/([A-Za-z0-9_-]+\/)+copy$/;
const CAPITALS = /^[A-Z][A-Z0-9_]*$/;

/** Whether `spec`, imported by `file` (a path relative to the repository root), names a module on the list. */
function allowedSpecifier(file: string, spec: string): boolean {
  if (spec.startsWith('@/')) return posix.normalize(spec) === spec && ALLOWED_ALIAS.some((re) => re.test(spec));
  if (spec.startsWith('./') || spec.startsWith('../')) return COPY_PATH.test(posix.join(posix.dirname(file), spec));
  return false;
}

function unwrap(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

const isFunctionValue = (init: ts.Expression | undefined): boolean =>
  init !== undefined && (ts.isArrowFunction(unwrap(init)) || ts.isFunctionExpression(unwrap(init)));

const isJsx = (node: ts.Node): boolean =>
  ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === kind) === true;

/**
 * What in `src` (the text of the copy module `file`) breaks the convention, one message per problem; empty when it
 * keeps it. A `.ts` module is read as TypeScript, so a generic arrow or a `<const>` assertion reads as what it is, and
 * JSX in it is a parse error; a `.tsx` module fails for its extension and is read as TSX so that its JSX is named.
 */
export function copyModuleProblems(file: string, src: string): string[] {
  const problems: string[] = [];
  const isTs = file.endsWith('.ts');
  if (!isTs) problems.push(`${file}: a copy module is a .ts file; JSX and React belong in a component`);
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, isTs ? ts.ScriptKind.TS : ts.ScriptKind.TSX);
  if (isTs) {
    const { diagnostics } = ts.transpileModule(src, {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext },
    });
    if (diagnostics === undefined) problems.push(`${file}: the compiler returned no parse result, so the module is not shown to parse as TypeScript`);
    else {
      for (const d of diagnostics) {
        const where = d.start === undefined ? 'a position the compiler did not give' : `line ${sf.getLineAndCharacterOfPosition(d.start).line + 1}`;
        problems.push(`${file}: ${where} does not parse as TypeScript (${ts.flattenDiagnosticMessageText(d.messageText, ' ')}); JSX belongs in a component`);
      }
    }
  }
  const offList = (spec: string, form: string) =>
    problems.push(
      `${file}: ${form} '${spec}' is not on the copy-module list (@/types/*, @/lib/vocabulary/terms, ` +
        `@/lib/vocabulary/verbatim, @/lib/format/*, another copy module); only a whole \`import type { … } from\` ` +
        `declaration may come from outside it`,
    );
  const checkSpecifier = (node: ts.Expression | undefined, form: string) => {
    if (node === undefined || !ts.isStringLiteralLike(node)) problems.push(`${file}: ${form} without a string-literal module name`);
    else if (!allowedSpecifier(file, node.text)) offList(node.text, form);
  };

  // Local variables, enums and classes, so that `export { name }` can be judged by what `name` holds: a variable by
  // its initializer, an enum or a class as an object (held to the capitals rule). Function declarations are free.
  const locals = new Map<string, { init: ts.Expression | undefined }>();
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) locals.set(d.name.text, { init: d.initializer });
    } else if ((ts.isEnumDeclaration(st) || ts.isClassDeclaration(st)) && st.name) locals.set(st.name.text, { init: undefined });
  }
  const checkName = (exported: string, init: ts.Expression | undefined) => {
    if (!isFunctionValue(init) && !CAPITALS.test(exported))
      problems.push(`${file}: exported object '${exported}' is not named in capitals (for example ${exported.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()})`);
  };

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      if (!st.importClause?.isTypeOnly) checkSpecifier(st.moduleSpecifier, 'import from');
    } else if (ts.isImportEqualsDeclaration(st)) {
      if (!st.isTypeOnly && ts.isExternalModuleReference(st.moduleReference)) checkSpecifier(st.moduleReference.expression, 'import = require');
    } else if (ts.isExportDeclaration(st)) {
      if (st.moduleSpecifier) {
        if (!st.isTypeOnly) checkSpecifier(st.moduleSpecifier, 'export from');
      } else if (!st.isTypeOnly && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const spec of st.exportClause.elements) {
          if (spec.name.text === 'default') {
            problems.push(`${file}: export { … as default } at line ${sf.getLineAndCharacterOfPosition(spec.getStart(sf)).line + 1}; a copy module has named exports only`);
            continue;
          }
          const local = locals.get((spec.propertyName ?? spec.name).text);
          if (local && !spec.isTypeOnly) checkName(spec.name.text, local.init);
        }
      }
    } else if (ts.isExportAssignment(st) || hasModifier(st, ts.SyntaxKind.DefaultKeyword)) {
      problems.push(`${file}: ${ts.isExportAssignment(st) && st.isExportEquals ? 'export =' : 'export default'} at line ${sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1}; a copy module has named exports only`);
    } else if ((ts.isEnumDeclaration(st) || ts.isClassDeclaration(st)) && hasModifier(st, ts.SyntaxKind.ExportKeyword) && st.name) {
      checkName(st.name.text, undefined);
    } else if (ts.isVariableStatement(st) && hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) checkName(d.name.text, d.initializer);
        else problems.push(`${file}: an exported destructuring binding has no single name to check`);
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (isJsx(node)) {
      problems.push(`${file}: JSX at line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}; a copy module holds words, not markup`);
      return;
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) checkSpecifier(node.arguments[0], 'dynamic import()');
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') checkSpecifier(node.arguments[0], 'require()');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return problems;
}

// ---- the copy modules in the tree ---------------------------------------------------------------------------

/** A copy module's path: `…/copy.ts`, `…/copy.tsx`, or `…/copy/index.ts(x)`, which `@/lib/<area>/copy` also resolves to. */
export function isCopyModulePath(path: string): boolean {
  return /(^|\/)copy(\/index)?\.tsx?$/.test(path);
}

/** Every copy module under `dir`, as a path relative to the repository root. */
function copyModulesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((f) => posix.join(dir, f.split(sep).join('/')))
    .filter(isCopyModulePath)
    .sort();
}

// ---- (harness) ---------------------------------------------------------------------------------------------

const F = 'lib/example/copy.ts';
const ok = (src: string) => expect(copyModuleProblems(F, src), src).toEqual([]);
/** `src`, as the module `file`, is reported with a problem whose message holds `fragment`. */
const badAt = (file: string, src: string, fragment: string) =>
  expect(copyModuleProblems(file, src).filter((p) => p.includes(fragment)), `${src}\nexpected a problem holding: ${fragment}`).not.toEqual([]);
const bad = (src: string, fragment: string) => badAt(F, src, fragment);
const OFF_LIST = 'is not on the copy-module list';
const CAPS = 'is not named in capitals';

describe('copy modules (harness)', () => {
  it('plan 1A Task 13 (harness): a whole import type declaration passes from any module', () => {
    ok("import type { A } from '@/components/ui/types';\nexport const X_COPY = {};");
    ok("import type A from 'react';\nexport const X_COPY = {};");
    ok("import type * as R from 'next/server';\nexport const X_COPY = {};");
    ok("export type { A } from '@/components/ui/types';");
  });

  it('plan 1A Task 13 (harness): an inline type specifier, a value import and a mixed import off the list fail', () => {
    bad("import { type A } from '@/components/ui/types';", OFF_LIST);
    bad("import { a } from '@/components/ui/types';", OFF_LIST);
    bad("import { type A, b } from '@/components/ui/types';", OFF_LIST);
    bad("import React from 'react';", OFF_LIST);
    bad("import { db } from '@/lib/data/db';", OFF_LIST);
    bad("import { cookies } from 'next/headers';", OFF_LIST);
  });

  it('plan 1A Task 13 (harness): a value import from each listed place passes', () => {
    ok("import { Rec } from '@/types/record';");
    ok("import { TERM_X } from '@/lib/vocabulary/terms';");
    ok("import { verbatim } from '@/lib/vocabulary/verbatim';");
    ok("import { formatDay } from '@/lib/format/dates';");
    ok("import { UI_COPY } from '@/lib/ui/copy';");
    ok("import { UI_COPY } from '../ui/copy';");
    ok("export { UI_COPY } from '@/lib/ui/copy';");
  });

  it('plan 1A Task 13 (harness): a side-effect import, a require, a dynamic import and a re-export off the list fail', () => {
    bad("import 'server-only';", `import from 'server-only' ${OFF_LIST}`);
    bad("const r = require('react');", `require() 'react' ${OFF_LIST}`);
    bad("export async function f() { return import('next/headers'); }", `dynamic import() 'next/headers' ${OFF_LIST}`);
    bad("export { db } from '@/lib/data/db';", `export from '@/lib/data/db' ${OFF_LIST}`);
    bad("export * from '@/components/ui/types';", `export from '@/components/ui/types' ${OFF_LIST}`);
    bad("import { x } from '../data/copy-helpers';", `'../data/copy-helpers' ${OFF_LIST}`);
    bad("import { x } from '@/types/../lib/data/db';", `'@/types/../lib/data/db' ${OFF_LIST}`);
    bad('export function f() { return require(); }', 'require() without a string-literal module name');
  });

  it('plan 1A Task 13 (harness): the failure message names the file and the import and says what may come from outside', () => {
    const [message] = copyModuleProblems(F, "import { type A } from '@/components/ui/types';");
    expect(message).toContain(F);
    expect(message).toContain('@/components/ui/types');
    expect(message).toContain('import type');
  });

  it('plan 1A Task 13 (harness): a .ts module is read as TypeScript: a generic arrow and a <const> assertion pass', () => {
    ok('export const pick = <T>(x: T): T => x;');
    ok("export const X_COPY = <const>{ a: 'b' };");
  });

  it('plan 1A Task 13 (harness): JSX in copy.ts does not parse, named by file and line; a copy.tsx file fails', () => {
    bad('export const X_COPY = { a: <p>Hello there</p> };', `${F}: line 1 does not parse as TypeScript`);
    bad("export const A_COPY = 'a';\nexport const X_COPY = { a: <></> };", `${F}: line 2 does not parse as TypeScript`);
    badAt('lib/example/copy.tsx', "export const X_COPY = { a: 'Hello' };", 'a copy module is a .ts file');
    badAt('lib/example/copy.tsx', 'export const X_COPY = { a: <p>Hello there</p> };', 'JSX at line 1');
  });

  it('plan 1A Task 13 (harness): an exported non-function const must be named in capitals; functions and types are free', () => {
    ok("export const X_COPY = Object.freeze({ a: 'b' });\nexport const M11 = 'x';");
    ok('export function reasonCount(n: number): string { return String(n); }');
    ok('export const textErasedLine = (d: string): string => d;');
    ok('export const fn = function (d: string) { return d; };');
    ok('export type Words = string;\nexport interface W { a: string }');
    bad("export const xCopy = { a: 'b' };", `'xCopy' ${CAPS}`);
    bad("export const Copy = 'b';", `'Copy' ${CAPS}`);
    bad("const words = { a: 'b' };\nexport { words };", `'words' ${CAPS}`);
    bad("const WORDS = { a: 'b' };\nexport { WORDS as words };", `'words' ${CAPS}`);
    ok("const WORDS = { a: 'b' };\nexport { WORDS };");
    bad("export const { a } = { a: 'b' };", 'no single name');
  });

  it('plan 1A Task 13 (harness): an exported enum or class is held to the capitals rule', () => {
    bad('export enum Colours { A }', `'Colours' ${CAPS}`);
    bad('export class Words {}', `'Words' ${CAPS}`);
    ok('export enum STATUS { A }');
    ok('export class WORDS {}');
    bad('enum Colours { A }\nexport { Colours };', `'Colours' ${CAPS}`);
    bad('class Words {}\nexport { Words };', `'Words' ${CAPS}`);
    ok('enum STATUS { A }\nexport { STATUS };');
  });

  it('plan 1A Task 13 (harness): a default export and export = fail; a copy module has named exports only', () => {
    bad("export default { a: 'b' };", 'named exports only');
    bad('export default function words() { return 1; }', 'named exports only');
    bad("export = { a: 'b' };", 'named exports only');
    bad("const f = (n: number) => String(n);\nexport { f as default };", 'named exports only');
    bad("const X_COPY = { a: 'b' };\nexport { X_COPY as default };", 'named exports only');
  });

  it('plan 1A Task 13 (harness): the walk takes copy.ts, copy.tsx and copy/index.ts(x), and nothing else', () => {
    expect(['lib/x/copy.ts', 'lib/x/y/copy.ts', 'lib/x/copy.tsx', 'lib/x/copy/index.ts', 'lib/x/copy/index.tsx'].filter(isCopyModulePath))
      .toEqual(['lib/x/copy.ts', 'lib/x/y/copy.ts', 'lib/x/copy.tsx', 'lib/x/copy/index.ts', 'lib/x/copy/index.tsx']);
    expect(['lib/x/copyright.ts', 'lib/x/copy/other.ts', 'lib/x/copy.test.ts', 'lib/x/acopy.ts', 'lib/x/copy.js'].filter(isCopyModulePath)).toEqual([]);
  });
});

// ---- the tree ----------------------------------------------------------------------------------------------

const modules = copyModulesUnder('lib');

describe('copy modules', () => {
  it('plan 1A Task 13: the walk finds the copy modules (lib/decision/copy.ts among them)', () => {
    expect(modules).toContain('lib/decision/copy.ts');
    expect(modules.length).toBeGreaterThanOrEqual(18);
  });

  it('plan 1A Task 13: every copy module under lib/ keeps the rules (imports, parses as TypeScript, named exports in capitals)', () => {
    const problems = modules.flatMap((file) => copyModuleProblems(file, readFileSync(file, 'utf8')));
    expect(problems).toEqual([]);
  });
});

