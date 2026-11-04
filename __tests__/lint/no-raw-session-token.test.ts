import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import ts from 'typescript';

/**
 * NFR-SEC-07 (SRS line 2937) and ADR-0002 (docs/adr/0002-identity-and-account-linking.md): the raw
 * session is unreachable from application code. `getToken` and `decode` from `next-auth/jwt` (a
 * re-export of `@auth/core/jwt`) decrypt the session cookie and hand back every claim in it,
 * among them the `id` and `sessionEpoch` that `resolveIdentity` checks against the database. If
 * application code could call them, a cached claim could stand in for that check.
 *
 * Exactly one file under `app/**` and `lib/**` may import them: `lib/auth/idleDeadline.ts`, which
 * reads `exp` and `sessionIssuedAt` for the idle warning (UX-43) and returns two numbers and no
 * identity. `proxy.ts` and `types/` are outside the two roots, and test files are too.
 *
 * This is a scan and not an ESLint rule, so it does not depend on the lint configuration. It reads
 * the source with the TypeScript parser and finds a static `import`, a re-export (`export ... from`),
 * `import x = require()`, a dynamic `import()` and a `require()` of either module. A type-only
 * import reads nothing at run time and stays allowed, as at `lib/auth/callbacks.ts:12`.
 *
 * Limit, stated plainly: a specifier built at run time (`require(name)`) is not seen, nor is a path
 * that reaches the same file under another package name. Both would also pass an ESLint selector.
 */

const BANNED_MODULES = new Set(['next-auth/jwt', '@auth/core/jwt']);
const ROOTS = ['app', 'lib', 'components'];
const EXEMPT = 'lib/auth/idleDeadline.ts';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

function scriptKind(file: string): ts.ScriptKind {
  const ext = extname(file);
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const specifierOf = (node: ts.Node | undefined): string | undefined =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

/** The banned imports in one source file, each as `line: form 'specifier'`. */
function findRawTokenImports(source: string, file: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const found: string[] = [];
  const report = (node: ts.Node, form: string, specifier: string) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    found.push(`${line + 1}: ${form} '${specifier}'`);
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = specifierOf(node.moduleSpecifier);
      if (specifier && BANNED_MODULES.has(specifier)) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        const typesOnly =
          clause !== undefined &&
          (clause.isTypeOnly ||
            (clause.name === undefined && named !== undefined && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly)));
        if (!typesOnly) report(node, 'import', specifier);
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = specifierOf(node.moduleSpecifier);
      if (specifier && BANNED_MODULES.has(specifier)) {
        const named = node.exportClause;
        const typesOnly =
          node.isTypeOnly || (named !== undefined && ts.isNamedExports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly));
        if (!typesOnly) report(node, 'export from', specifier);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      const specifier = ts.isExternalModuleReference(reference) ? specifierOf(reference.expression) : undefined;
      if (specifier && BANNED_MODULES.has(specifier) && !node.isTypeOnly) report(node, 'import =', specifier);
    } else if (ts.isCallExpression(node)) {
      const specifier = specifierOf(node.arguments[0]);
      if (specifier && BANNED_MODULES.has(specifier)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) report(node, 'import()', specifier);
        else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') report(node, 'require()', specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function sourceFilesUnder(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (SOURCE_EXTENSIONS.has(extname(name))) files.push(path);
    }
  };
  walk(root);
  return files;
}

describe('the raw session token is unreachable from application code (ADR-0002)', () => {
  it('NFR-SEC-07 ADR-0002: next-auth/jwt is banned in app/** and lib/**, except in lib/auth/idleDeadline.ts', () => {
    const files = ROOTS.flatMap(sourceFilesUnder);
    // Non-vacuity: a scan that walked the wrong directory would pass on zero files. These are the two
    // trees of the application, which hold hundreds of files, and the scan names files it must have seen.
    expect(files.length).toBeGreaterThan(50);
    for (const mustSee of ['lib/auth/identity.ts', 'lib/auth/callbacks.ts', 'lib/data/tenant.ts', 'app/(authenticated)/layout.tsx', 'app/not-found.tsx']) {
      expect(files, mustSee).toContain(mustSee);
    }

    const violations = files
      .filter((file) => file !== EXEMPT)
      .flatMap((file) => findRawTokenImports(readFileSync(file, 'utf8'), file).map((hit) => `${file}:${hit}`));
    expect(violations).toEqual([]);

    // The exemption is not dead text: the one permitted file exists and uses the import it is permitted.
    expect(existsSync(EXEMPT)).toBe(true);
    expect(findRawTokenImports(readFileSync(EXEMPT, 'utf8'), EXEMPT).map((hit) => hit.replace(/^\d+: /, ''))).toEqual(["import 'next-auth/jwt'"]);
  });

  it('NFR-SEC-07 ADR-0002 (helper): the scan finds every form of the import and lets a type-only import through', () => {
    const flagged: Array<[string, string]> = [
      ['named', "import { getToken } from 'next-auth/jwt';"],
      ['default', "import jwt from 'next-auth/jwt';"],
      ['namespace', "import * as jwt from 'next-auth/jwt';"],
      ['side effect', "import 'next-auth/jwt';"],
      ['mixed type and value', "import { type JWT, getToken } from 'next-auth/jwt';"],
      ['@auth/core', "import { decode } from '@auth/core/jwt';"],
      ['re-export', "export { encode } from 'next-auth/jwt';"],
      ['re-export all', "export * from '@auth/core/jwt';"],
      ['dynamic import', "export const a = await import('next-auth/jwt');"],
      ['dynamic import in a template', 'export const a = await import(`next-auth/jwt`);'],
      ['require', "export const a = require('next-auth/jwt');"],
      ['import equals', "import jwt = require('next-auth/jwt');"],
      ['inside a function', "export async function f() { const { getToken } = await import('next-auth/jwt'); return getToken; }"],
    ];
    for (const [name, source] of flagged) expect(findRawTokenImports(source, 'lib/x.ts'), name).toHaveLength(1);

    const allowed: Array<[string, string]> = [
      ['type import', "import type { JWT } from 'next-auth/jwt';"],
      ['type default', "import type jwt from 'next-auth/jwt';"],
      ['inline type specifiers', "import { type JWT, type JWTDecodeParams } from 'next-auth/jwt';"],
      ['type re-export', "export type { JWT } from 'next-auth/jwt';"],
      ['type of an import', "export type A = typeof import('next-auth/jwt');"],
      ['type-only import equals', "import type jwt = require('next-auth/jwt');"],
      ['a module whose name only starts the same', "import { x } from 'next-auth/jwt-helpers';"],
      ['another module', "import { auth } from 'next-auth';"],
      ['a string that only mentions it', "export const note = \"see next-auth/jwt\";"],
      ['a comment', "// import { getToken } from 'next-auth/jwt'\nexport const a = 1;"],
    ];
    for (const [name, source] of allowed) expect(findRawTokenImports(source, 'lib/x.ts'), name).toEqual([]);

    // The file kind follows the extension, so JSX and plain JavaScript are read too.
    expect(findRawTokenImports("const { getToken } = require('next-auth/jwt');", 'lib/x.js')).toHaveLength(1);
    expect(findRawTokenImports("import { getToken } from 'next-auth/jwt'; export const X = () => <div>{String(getToken)}</div>;", 'app/x.tsx')).toHaveLength(1);
  });
});
