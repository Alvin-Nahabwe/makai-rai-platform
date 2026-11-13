import { readdirSync, readFileSync } from 'node:fs';
import { posix, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Plan 1A Task 13, the copy-module convention (stage-1a-foundation-plan.md, "Copy modules: the convention"). Every
 * `lib/**\/copy.ts` is a module a browser bundle and a Playwright spec can import, so it holds words and nothing else:
 *  - imports: a whole `import type` declaration may come from any module (every compiler erases it); every other
 *    import, re-export, dynamic `import()` or `require` names `@/types/*`, `@/lib/vocabulary/terms`,
 *    `@/lib/vocabulary/verbatim`, `@/lib/format/*` or another copy module (`@/lib/<area>/copy`, or a relative path to
 *    one). An inline `import { type X }` is held to the list: it can survive compilation as a bare import.
 *  - no JSX, and the file is `.ts`;
 *  - every exported `const` whose value is not a function is named in capitals (`/^[A-Z][A-Z0-9_]*$/`); exported
 *    functions and types are free of that rule, since a varying sentence is a function beside the object.
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

const hasExport = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;

/**
 * What in `src` (the text of the copy module `file`) breaks the convention, one message per problem; empty when it
 * keeps it. The source is read as TSX, so a JSX node in a `.ts` file is seen as JSX rather than as a syntax error.
 */
export function copyModuleProblems(file: string, src: string): string[] {
  const problems: string[] = [];
  if (!file.endsWith('.ts')) problems.push(`${file}: a copy module is a .ts file; JSX and React belong in a component`);
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offList = (spec: string, form: string) =>
    problems.push(
      `${file}: ${form} '${spec}' is not on the copy-module list (@/types/*, @/lib/vocabulary/terms, ` +
        `@/lib/vocabulary/verbatim, @/lib/format/*, another copy module); only a whole \`import type { … } from\` ` +
        `declaration may come from outside it`,
    );
  const checkSpecifier = (node: ts.Expression | undefined, form: string) => {
    if (node === undefined || !ts.isStringLiteralLike(node)) problems.push(`${file}: ${form} with a computed module name`);
    else if (!allowedSpecifier(file, node.text)) offList(node.text, form);
  };

  // Local declarations, so that `export { name }` can be judged by what `name` holds.
  const locals = new Map<string, ts.VariableDeclaration>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) locals.set(d.name.text, d);
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
          const local = locals.get((spec.propertyName ?? spec.name).text);
          if (local && !spec.isTypeOnly) checkName(spec.name.text, local.initializer);
        }
      }
    } else if (ts.isVariableStatement(st) && hasExport(st)) {
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

/** Every file named `copy.ts` or `copy.tsx` under `dir`, as a path relative to the repository root. */
function copyModulesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((f) => posix.join(dir, f.split(sep).join('/')))
    .filter((f) => /(^|\/)copy\.tsx?$/.test(f))
    .sort();
}

// ---- (harness) ---------------------------------------------------------------------------------------------

const F = 'lib/example/copy.ts';
const ok = (src: string) => expect(copyModuleProblems(F, src), src).toEqual([]);
const badAt = (file: string, src: string) => expect(copyModuleProblems(file, src).length, src).toBeGreaterThan(0);
const bad = (src: string) => badAt(F, src);

describe('copy modules (harness)', () => {
  it('plan 1A Task 13 (harness): a whole import type declaration passes from any module', () => {
    ok("import type { A } from '@/components/ui/types';\nexport const X_COPY = {};");
    ok("import type A from 'react';\nexport const X_COPY = {};");
    ok("import type * as R from 'next/server';\nexport const X_COPY = {};");
    ok("export type { A } from '@/components/ui/types';");
  });

  it('plan 1A Task 13 (harness): an inline type specifier, a value import and a mixed import off the list fail', () => {
    bad("import { type A } from '@/components/ui/types';");
    bad("import { a } from '@/components/ui/types';");
    bad("import { type A, b } from '@/components/ui/types';");
    bad("import React from 'react';");
    bad("import { db } from '@/lib/data/db';");
    bad("import { cookies } from 'next/headers';");
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
    bad("import 'server-only';");
    bad("const r = require('react');");
    bad("export async function f() { return import('next/headers'); }");
    bad("export { db } from '@/lib/data/db';");
    bad("export * from '@/components/ui/types';");
    bad("import { x } from '../data/copy-helpers';");
    bad("import { x } from '@/types/../lib/data/db';");
    bad('export function f() { return require(); }');
  });

  it('plan 1A Task 13 (harness): the failure message names the file and the import and says what may come from outside', () => {
    const [message] = copyModuleProblems(F, "import { type A } from '@/components/ui/types';");
    expect(message).toContain(F);
    expect(message).toContain('@/components/ui/types');
    expect(message).toContain('import type');
  });

  it('plan 1A Task 13 (harness): JSX fails, and so does a copy.tsx file', () => {
    bad('export const X_COPY = { a: <p>Hello there</p> };');
    bad('export const X_COPY = { a: <></> };');
    badAt('lib/example/copy.tsx', "export const X_COPY = { a: 'Hello' };");
  });

  it('plan 1A Task 13 (harness): an exported non-function const must be named in capitals; functions and types are free', () => {
    ok("export const X_COPY = Object.freeze({ a: 'b' });\nexport const M11 = 'x';");
    ok('export function reasonCount(n: number): string { return String(n); }');
    ok('export const textErasedLine = (d: string): string => d;');
    ok('export const fn = function (d: string) { return d; };');
    ok('export type Words = string;\nexport interface W { a: string }');
    bad("export const xCopy = { a: 'b' };");
    bad("export const Copy = 'b';");
    bad("const words = { a: 'b' };\nexport { words };");
    bad("const WORDS = { a: 'b' };\nexport { WORDS as words };");
    ok("const WORDS = { a: 'b' };\nexport { WORDS };");
  });
});

// ---- the tree ----------------------------------------------------------------------------------------------

const modules = copyModulesUnder('lib');

describe('copy modules', () => {
  it('plan 1A Task 13: the walk finds the copy modules (lib/decision/copy.ts among them)', () => {
    expect(modules).toContain('lib/decision/copy.ts');
    expect(modules.length).toBeGreaterThanOrEqual(18);
  });

  it('plan 1A Task 13: every lib/**/copy.ts keeps the copy-module rules (imports, no JSX, capital names)', () => {
    const problems = modules.flatMap((file) => copyModuleProblems(file, readFileSync(file, 'utf8')));
    expect(problems).toEqual([]);
  });
});

