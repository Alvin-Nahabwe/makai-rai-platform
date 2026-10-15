import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as templates from '@/lib/email/templates';

// Loaded with require so Vite does not try to read typescript's source map.
const ts = createRequire(__filename)('typescript') as typeof import('typescript');

/**
 * RL 2.3: a notification email travels over a channel the toolkit does not control, so it
 * carries nothing about an assessment, a finding or a score. The only things a template may
 * be given are the four CONTENT_FREE fields below: who is inviting you, as what, where to
 * click, and when the link stops working.
 *
 * Three layers, because each one covers what the others cannot:
 *
 *  1. BEHAVIOUR. Every template export is called with an input that answers
 *     `SENTINEL-RECORD` to any field outside CONTENT_FREE, and that also carries one such
 *     field of its own (`recordField`), so a template that enumerates its input (spread,
 *     rest, `Object.entries`) meets a sentinel too. If the subject, text or html contains
 *     it, the template prints a record field. If the template merely READS one, that is
 *     caught as well: a template that takes a record field has stopped being content-free
 *     even on the day it forgets to print it.
 *     LIMIT: behaviour sees reads, not declarations. A named field taken off a copy
 *     (`const { orgName, ...rest } = input; rest.findingTitle`) is caught only because
 *     making the copy enumerates the input and reads `recordField`; the test never learns
 *     the name `findingTitle`. What the template DECLARES it takes is layer 1b's job.
 *     LIMIT: a read gated on a content-free value (`input.role === 'reviewer' ? input.findingTitle`)
 *     never runs, because the sentinel input answers `role` with 'assessor'. Layer 1 cannot see
 *     it; layer 1b does, because the field is declared on one member of the input type.
 *  1b. DECLARED INPUT. The TypeScript checker reads the first parameter of every exported
 *     template, and every property it declares, on EVERY member of a union, must be in
 *     CONTENT_FREE. No index signature, `any` or `unknown`, and no second parameter, which
 *     would be another way in.
 *     LIMITS, both open and both found in review: a field reached through a cast on a name
 *     the type does not declare, behind a gate that never opens, is caught by neither layer;
 *     and a type parameter constrained to a union (`<T extends A | (A & { findingTitle })>`)
 *     is not expanded to its members, so only its nullable part is looked through. Review
 *     has to catch those.
 *  2. IMPORTS. A template that imports the data layer, the domain types, the engine or the
 *     report code is one edit away from rendering what they hold, so the import itself is
 *     refused, directly or through any repo file it pulls in.
 *  3. CALL SITES. Layer 1 only covers what the templates module exports. A caller that
 *     builds `{ subject, html, text }` by hand skips the module altogether, so every file
 *     that calls `sendEmail` must import a template. This is a proxy, and an honest one to
 *     name: it cannot tell a file that passes the template's output through from one that
 *     imports a template and ALSO sends a second, hand-written message.
 *
 * The detectors are plain functions over source text, and each is run against a
 * known-bad input below ("the detectors"), so a green result cannot come from a detector
 * that has quietly stopped detecting.
 */

const ROOT = path.join(__dirname, '../..');

// ---------------------------------------------------------------------------------------
// Layer 1: behaviour
// ---------------------------------------------------------------------------------------

const CONTENT_FREE = ['orgName', 'role', 'acceptUrl', 'expiresAt'];
const SENTINEL = 'SENTINEL-RECORD';

/** What the content-free fields answer. Strings are what a template should render. */
const CONTENT_FREE_VALUES: Record<string, unknown> = {
  orgName: 'Example Org',
  role: 'assessor',
  acceptUrl: 'https://example.test/invitations/token',
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
};
const RENDERED_VALUES = ['Example Org', 'assessor', 'https://example.test/invitations/token'];

type Template = (input: never) => { subject: unknown; text: unknown; html: unknown };

/** The one record field the input owns. Without it, enumeration would only ever meet content-free fields. */
const RECORD_FIELD = 'recordField';
const OWN_KEYS = [...CONTENT_FREE, RECORD_FIELD];
const answerFor = (prop: string): unknown => (CONTENT_FREE.includes(prop) ? CONTENT_FREE_VALUES[prop] : SENTINEL);

/**
 * An input whose every property outside CONTENT_FREE is the sentinel, and which records what was read.
 * Its own keys are the content-free fields plus RECORD_FIELD, so `{ ...input }`, a rest pattern,
 * `Object.values`, `Object.entries` and `JSON.stringify({ ...input })` each read a sentinel
 * (spread and rest use [[Get]] on every own key). `Object.keys` alone reads nothing, and leaks nothing.
 */
function recordInput(): { input: unknown; read: Set<string> } {
  const read = new Set<string>();
  const input = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      read.add(prop);
      return answerFor(prop);
    },
    has: (_target, prop) => typeof prop === 'string',
    ownKeys: () => [...OWN_KEYS],
    getOwnPropertyDescriptor: (_target, prop) =>
      typeof prop === 'string' && OWN_KEYS.includes(prop)
        ? { value: answerFor(prop), enumerable: true, configurable: true, writable: true }
        : undefined,
  });
  return { input, read };
}

/** What is wrong with a template's output on a sentinel input; empty when nothing is. */
function contentProblems(template: Template): string[] {
  const { input, read } = recordInput();
  const out = template(input as never);
  const problems: string[] = [];
  for (const part of ['subject', 'text', 'html'] as const) {
    const value = out[part];
    if (typeof value !== 'string' || value.length === 0) problems.push(`${part} is not a non-empty string`);
    else if (value.toUpperCase().includes(SENTINEL)) problems.push(`${part} contains a record field`);
  }
  for (const key of read) if (!CONTENT_FREE.includes(key)) problems.push(`reads "${key}", which is not content-free`);
  return problems;
}

// ---------------------------------------------------------------------------------------
// Layer 2 and 3: source
// ---------------------------------------------------------------------------------------

/** Repo paths a template must not reach (directories, or the module itself for types/domain). */
const RECORD_HOLDERS = ['lib/data', 'data', 'types/domain', 'lib/engine', 'lib/report'];
const TEMPLATES_MODULE = 'lib/email/templates';
const SEND_MODULE = 'lib/email/send.ts';
/** The brief's expression: a call, not the declaration. */
const SEND_CALL = /(?<!function )sendEmail\(/;

type Reader = (repoPath: string) => string | undefined;
type Import = { spec: string; typeOnly: boolean };

const readRepoFile: Reader = (rel) => {
  const abs = path.join(ROOT, rel);
  return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : undefined;
};

/** Every module a file imports, re-exports, `require`s or `import()`s, and whether it is type-only. */
function importsOf(file: string, source: string): Import[] {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const found: Import[] = [];
  const allNamedAreTypes = (b: import('typescript').NamedImportsOrExports | import('typescript').NamespaceImport | undefined) =>
    !!b && (ts.isNamedImports(b) || ts.isNamedExports(b)) && b.elements.length > 0 && b.elements.every((e) => e.isTypeOnly);
  const visit = (n: import('typescript').Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const clause = n.importClause;
      found.push({ spec: n.moduleSpecifier.text, typeOnly: !!clause && (clause.isTypeOnly || allNamedAreTypes(clause.namedBindings)) });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      found.push({ spec: n.moduleSpecifier.text, typeOnly: n.isTypeOnly || allNamedAreTypes(n.exportClause as never) });
    } else if (ts.isExternalModuleReference(n) && ts.isStringLiteral(n.expression)) {
      found.push({ spec: n.expression.text, typeOnly: false });
    } else if (
      ts.isCallExpression(n) &&
      n.arguments.length === 1 &&
      ts.isStringLiteralLike(n.arguments[0]) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
    ) {
      found.push({ spec: n.arguments[0].text, typeOnly: false });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** A specifier as a repo-root-relative path without extension; null for a package. */
function repoPathOf(spec: string, fromFile: string): string | null {
  let p: string;
  if (spec.startsWith('@/')) p = spec.slice(2);
  else if (spec.startsWith('.')) p = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  else return null;
  return p.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
}

/** The files a repo path can stand for, in resolution order. */
const candidatesFor = (p: string): string[] => [`${p}.ts`, `${p}.tsx`, `${p}/index.ts`, `${p}/index.tsx`];

const holdsRecords = (p: string): boolean => RECORD_HOLDERS.some((root) => p === root || p.startsWith(`${root}/`));
const isTemplatesModule = (p: string): boolean => p === TEMPLATES_MODULE || p.startsWith(`${TEMPLATES_MODULE}/`);

/**
 * Every import of a record-holding module reachable from `entries`, following imports
 * through repo files, so a template cannot reach `lib/data` by way of a helper.
 */
function recordImportsReachableFrom(entries: string[], read: Reader): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = read(file);
    if (source === undefined) continue;
    for (const { spec } of importsOf(file, source)) {
      const target = repoPathOf(spec, file);
      if (target === null) continue;
      if (holdsRecords(target)) hits.push(`${file} imports '${spec}'`);
      else {
        const next = candidatesFor(target).find((c) => read(c) !== undefined);
        if (next) queue.push(next);
      }
    }
  }
  return hits;
}

/** Files that call `sendEmail` without importing a value from the templates module. */
function sendersWithoutTemplates(files: string[], read: Reader): string[] {
  return files.filter((file) => {
    if (file === SEND_MODULE) return false;
    const source = read(file);
    if (source === undefined || !SEND_CALL.test(source)) return false;
    const usesTemplate = importsOf(file, source).some(({ spec, typeOnly }) => {
      const target = repoPathOf(spec, file);
      return !typeOnly && target !== null && isTemplatesModule(target);
    });
    return !usesTemplate;
  });
}

/**
 * Production source: everything but tests and non-code directories. Tests are out of scope
 * on purpose: `email-send.test.ts` calls the transport with hand-written messages to test
 * the transport, which is not a notification going to anyone.
 *
 * `node_modules`, `__tests__` and dot-directories are skipped at any depth. `docs`, `public`,
 * `e2e` and `coverage` are skipped only at the repo root, where they are not code: further
 * down, `app/docs/` or `app/public/` could be a route, and a route can send mail.
 */
const SKIPPED_AT_ANY_DEPTH = new Set(['node_modules', '__tests__']);
const SKIPPED_AT_ROOT = new Set(['docs', 'public', 'e2e', 'coverage']);
const isSkipped = (name: string, atRoot: boolean): boolean =>
  name.startsWith('.') || SKIPPED_AT_ANY_DEPTH.has(name) || (atRoot && SKIPPED_AT_ROOT.has(name));

function productionSource(root = ROOT, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(root, rel))) {
    if (isSkipped(name, rel === '')) continue;
    const child = path.posix.join(rel, name);
    if (statSync(path.join(root, child)).isDirectory()) out.push(...productionSource(root, child));
    else if (/\.[cm]?[jt]sx?$/.test(name)) out.push(child);
  }
  return out;
}

/**
 * What each exported function of a module declares it takes (layer 1b), read by the
 * TypeScript checker so intersections, `Pick` and imported types are resolved, not guessed.
 * `source` replaces the file's text, for the detector's own tests.
 */
function declaredInputs(rel: string, source?: string): { checked: string[]; problems: string[] } {
  const file = path.join(ROOT, rel);
  const options: import('typescript').CompilerOptions = {
    target: ts.ScriptTarget.ES2017,
    lib: ['lib.es5.d.ts'],
    types: [],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    baseUrl: ROOT,
    paths: { '@/*': ['./*'] },
  };
  const host = ts.createCompilerHost(options);
  if (source !== undefined) {
    const { fileExists, readFile, getSourceFile } = host;
    host.fileExists = (f) => f === file || fileExists(f);
    host.readFile = (f) => (f === file ? source : readFile(f));
    host.getSourceFile = (f, languageVersion, ...rest) =>
      f === file ? ts.createSourceFile(f, source, languageVersion, true) : getSourceFile(f, languageVersion, ...rest);
  }
  const program = ts.createProgram([file], options, host);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(file);
  const moduleSymbol = sf && checker.getSymbolAtLocation(sf);
  const checked: string[] = [];
  const problems: string[] = [];
  if (!sf || !moduleSymbol) return { checked, problems: [`${rel} is not a module the checker can read`] };

  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const signatures = checker.getTypeOfSymbolAtLocation(symbol, sf).getCallSignatures();
    for (const signature of signatures) {
      checked.push(exported.name);
      const params = signature.getParameters();
      if (params.length > 1) problems.push(`${exported.name}: takes ${params.length} arguments, so more than one input`);
      if (params.length === 0) continue;
      const declared = checker.getTypeOfSymbolAtLocation(params[0], sf);
      if (declared.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) problems.push(`${exported.name}: input is any, unknown or unresolved`);
      // `getPropertiesOfType` on a union lists only the properties EVERY member has, so a field declared
      // on one member would pass: each member is checked. The nullable part goes first, and it is not
      // optional: a type parameter constrained to `X | undefined` is not a union at all, so the split
      // below would see only `T`, which has no properties of its own. `getNonNullableType` turns it into
      // `T & {}`, whose properties are X's. (A concrete `X | undefined` becomes `X`.)
      const type = checker.getNonNullableType(declared);
      const found = new Set<string>();
      for (const member of type.isUnion() ? type.types : [type]) {
        if (checker.getIndexInfosOfType(member).length > 0) found.add('input accepts arbitrary fields (index signature)');
        for (const prop of checker.getPropertiesOfType(member)) {
          if (!CONTENT_FREE.includes(prop.name)) found.add(`input declares "${prop.name}"`);
        }
      }
      for (const problem of found) problems.push(`${exported.name}: ${problem}`);
    }
  }
  return { checked, problems };
}

/** Source text held in memory, for the detectors' own tests. */
const fromMemory =
  (files: Record<string, string>): Reader =>
  (rel) =>
    files[rel];

// ---------------------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------------------

describe('notification templates (RL 2.3)', () => {
  const exported = Object.entries(templates).filter(([, v]) => typeof v === 'function') as [string, Template][];

  it('every notification template takes only content-free fields', () => {
    // A renamed or emptied module must not pass by having nothing to check.
    expect(exported.length).toBeGreaterThan(0);

    for (const [name, template] of exported) {
      expect(contentProblems(template), name).toEqual([]);

      // The sentinel input was really used: the content-free values reach the output.
      const { input } = recordInput();
      const out = template(input as never);
      expect(RENDERED_VALUES.some((v) => String(out.text).includes(v)), `${name} renders no content-free field`).toBe(true);
    }
  });

  it('every notification template declares only content-free input fields', () => {
    const { checked, problems } = declaredInputs(`${TEMPLATES_MODULE}.ts`);
    // The checker saw the same functions the behavioural test called.
    expect([...checked].sort()).toEqual(exported.map(([name]) => name).sort());
    expect(problems).toEqual([]);
  });

  it('templates import nothing that holds record content', () => {
    const entries = candidatesFor(TEMPLATES_MODULE).filter((c) => readRepoFile(c) !== undefined);
    // The module under test was found: otherwise the walk below would visit nothing.
    expect(entries.length, `no source file for ${TEMPLATES_MODULE}`).toBeGreaterThan(0);

    expect(recordImportsReachableFrom(entries, readRepoFile)).toEqual([]);
  });

  it('every sendEmail call sends a template output', () => {
    const files = productionSource();
    // The walk reached the transport and the one known caller, so it is looking at the right tree.
    expect(files).toContain(SEND_MODULE);
    expect(files.filter((f) => SEND_CALL.test(readRepoFile(f) ?? '')), 'no sendEmail call site found').toContain(
      'app/api/v1/orgs/[slug]/members/route.ts',
    );

    expect(sendersWithoutTemplates(files, readRepoFile)).toEqual([]);
  });
});

describe('the detectors', () => {
  it('flag a template that prints a record field', () => {
    const leaky = ((i: { orgName: string; patientName: string }) => ({
      subject: `Invitation to ${i.orgName}`,
      text: `Hello ${i.patientName}`,
      html: '<p>Hello</p>',
    })) as Template;
    expect(contentProblems(leaky)).toEqual(['text contains a record field', 'reads "patientName", which is not content-free']);
  });

  it('flag a template that merely reads a record field', () => {
    const reader = ((i: { orgName: string; findingTitle: string }) => {
      void i.findingTitle;
      return { subject: i.orgName, text: i.orgName, html: i.orgName };
    }) as Template;
    expect(contentProblems(reader)).toEqual(['reads "findingTitle", which is not content-free']);
  });

  // The next four enumerate the input and name no field at all: only the record field the
  // input owns can make them visible.
  const ENUMERATED = ['text contains a record field', 'reads "recordField", which is not content-free'];

  it('flag a template that spreads its input into the body', () => {
    const spreader = ((i: object) => ({ subject: 'x', text: JSON.stringify({ ...i }), html: 'x' })) as Template;
    expect(contentProblems(spreader)).toEqual(ENUMERATED);
  });

  it('flag a template that renders every field it is given', () => {
    const lister = ((i: object) => ({
      subject: 'x',
      text: Object.entries(i)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join('; '),
      html: 'x',
    })) as Template;
    expect(contentProblems(lister)).toEqual(ENUMERATED);
  });

  it('flag a template that renders the values of its input', () => {
    const values = ((i: object) => ({ subject: 'x', text: Object.values(i).join(' '), html: 'x' })) as Template;
    expect(contentProblems(values)).toEqual(ENUMERATED);
  });

  it('flag a template that renders a rest copy of its input', () => {
    const rest = ((i: { orgName: string }) => {
      const { orgName, ...others } = i;
      return { subject: orgName, text: JSON.stringify(others), html: 'x' };
    }) as Template;
    expect(contentProblems(rest)).toEqual(ENUMERATED);
  });

  it('flag a named field read off a rest copy, through the enumeration that made the copy', () => {
    const named = ((i: { orgName: string; findingTitle?: string }) => {
      const { orgName, ...others } = i;
      return { subject: orgName, text: `${orgName} ${String(others.findingTitle)}`, html: 'x' };
    }) as Template;
    // `others.findingTitle` is undefined here, so nothing is printed: the copy itself is what is caught.
    expect(contentProblems(named)).toEqual(['reads "recordField", which is not content-free']);
  });

  it('do not flag Object.keys alone, which reads no value', () => {
    const keys = ((i: object) => ({ subject: 'x', text: `${Object.keys(i).length} fields`, html: 'x' })) as Template;
    expect(contentProblems(keys)).toEqual([]);
  });

  it('flag an output that is not subject, text and html strings', () => {
    expect(contentProblems((() => ({ subject: 'x', text: '', html: undefined })) as Template)).toEqual([
      'text is not a non-empty string',
      'html is not a non-empty string',
    ]);
  });

  it('pass a template that uses the content-free fields only', () => {
    const clean = ((i: { orgName: string; role: string; acceptUrl: string; expiresAt: Date }) => ({
      subject: `Join ${i.orgName}`,
      text: `${i.role} ${i.acceptUrl} ${i.expiresAt.toISOString()}`,
      html: `<p>${i.orgName}</p>`,
    })) as Template;
    expect(contentProblems(clean)).toEqual([]);
  });

  describe('for declared inputs', () => {
    const check = (body: string) => declaredInputs('__t16-virtual-template.ts', body);
    const output = 'subject: "s", text: "t", html: "h"';

    it('pass an input with content-free fields only, optional ones included', () => {
      const { checked, problems } = check(
        `export interface In { orgName: string; role?: string; acceptUrl: string; expiresAt: Date }
         export function good(i: In) { return { ${output} }; }
         export const arrow = (i?: Pick<In, 'orgName'>) => ({ ${output} });`,
      );
      expect(checked.sort()).toEqual(['arrow', 'good']);
      expect(problems).toEqual([]);
    });

    it('flag a declared record field: plain, by intersection, on a rest-copy template (M1), optional, on any one union member, or behind a nullable generic', () => {
      const { problems } = check(
        `export interface In { orgName: string; findingTitle?: string }
         export function declares(i: In) { return { ${output} }; }
         export function intersects(i: { orgName: string } & { score: number }) { return { ${output} }; }
         export function viaRest(i: In) { const { orgName, ...rest } = i; return { ${output}, rest }; }
         export function optional(i?: { orgName: string; findingTitle: string }) { return { ${output} }; }
         export function union(i: { orgName: string } | { orgName: string; findingTitle: string; score: number }) { return { ${output} }; }
         export function unionOfOptional(i?: { orgName: string } | { role: string; score: number }) { return { ${output} }; }
         export function unionFirst(i: { orgName: string; findingTitle: string } | { orgName: string }) { return { ${output} }; }
         export function nullableGeneric<T extends { orgName: string; findingTitle: string } | undefined>(i: T) { return { ${output} }; }
         export function nullGeneric<T extends { orgName: string; score: number } | null>(i: T) { return { ${output} }; }`,
      );
      expect(problems).toEqual([
        'declares: input declares "findingTitle"',
        'intersects: input declares "score"',
        'viaRest: input declares "findingTitle"',
        'optional: input declares "findingTitle"',
        'union: input declares "findingTitle"',
        'union: input declares "score"',
        'unionOfOptional: input declares "score"',
        'unionFirst: input declares "findingTitle"',
        'nullableGeneric: input declares "findingTitle"',
        'nullGeneric: input declares "score"',
      ]);
    });

    it('flag a record field read behind a content-free value, which behaviour cannot reach', () => {
      type Gated = { role: 'assessor' } | { role: 'reviewer'; findingTitle: string };
      const gated = ((i: Gated) => ({
        subject: 'x',
        text: i.role === 'reviewer' ? `review ${i.findingTitle}` : 'ok',
        html: 'x',
      })) as Template;
      // The sentinel input answers role = 'assessor', so the branch that reads findingTitle never runs...
      expect(contentProblems(gated)).toEqual([]);
      // ...and the declaration is what gives it away.
      expect(
        check(
          `export type Gated = { role: 'assessor' } | { role: 'reviewer'; findingTitle: string };
           export function gated(i: Gated) { return { ${output} }; }`,
        ).problems,
      ).toEqual(['gated: input declares "findingTitle"']);
    });

    it('flag an input that accepts anything', () => {
      const { problems } = check(
        `export function loose(i: Record<string, string>) { return { ${output} }; }
         export function anyInput(i: any) { return { ${output} }; }
         export function unknownInput(i: unknown) { return { ${output} }; }`,
      );
      expect(problems).toEqual([
        'loose: input accepts arbitrary fields (index signature)',
        'anyInput: input is any, unknown or unresolved',
        'unknownInput: input is any, unknown or unresolved',
      ]);
    });

    it('flag a second argument, which is another way in', () => {
      expect(check(`export function two(i: { orgName: string }, extra: string) { return { ${output} }; }`).problems).toEqual([
        'two: takes 2 arguments, so more than one input',
      ]);
    });

    it('follow a re-export and ignore a type', () => {
      const { checked, problems } = check(
        `export interface Unused { patientName: string }
         function inner(i: { orgName: string }) { return { ${output} }; }
         export { inner as renamed };`,
      );
      expect(checked).toEqual(['renamed']);
      expect(problems).toEqual([]);
    });
  });

  describe('for the source walk', () => {
    it('skip tests and dot-directories at any depth, and docs, public, e2e and coverage at the root only', () => {
      expect(isSkipped('node_modules', false)).toBe(true);
      expect(isSkipped('__tests__', false)).toBe(true);
      expect(isSkipped('.next', false)).toBe(true);
      for (const dir of ['docs', 'public', 'e2e', 'coverage']) {
        expect(isSkipped(dir, true), `${dir} at the root`).toBe(true);
        expect(isSkipped(dir, false), `${dir} below the root`).toBe(false);
      }
      expect(isSkipped('app', true)).toBe(false);
    });

    it('find a caller in app/docs and app/public, and not in the root-level directories', () => {
      const root = mkdtempSync(path.join(tmpdir(), 't16-walk-'));
      try {
        const write = (rel: string) => {
          mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
          writeFileSync(path.join(root, rel), 'export const x = 1;');
        };
        for (const rel of [
          'app/docs/notify.ts',
          'app/public/notify.ts',
          'app/reports/notify.ts',
          'lib/a.mjs',
          'docs/skipped.ts',
          'public/skipped.ts',
          'e2e/skipped.ts',
          'coverage/skipped.ts',
          'node_modules/skipped.ts',
          'app/node_modules/skipped.ts',
          'app/__tests__/skipped.ts',
          '.next/skipped.ts',
          'app/.cache/skipped.ts',
          'app/readme.md',
        ]) {
          write(rel);
        }
        expect(productionSource(root).sort()).toEqual([
          'app/docs/notify.ts',
          'app/public/notify.ts',
          'app/reports/notify.ts',
          'lib/a.mjs',
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('for imports', () => {
    const read = fromMemory({
      'lib/email/templates.ts': "import { shout } from './helpers';\nexport const x = shout;",
      'lib/email/helpers.ts': "import type { Assessment } from '@/types/domain';\nexport const shout = 1;",
      'lib/email/direct.ts': "import { x } from '../data/assessments';",
      'lib/email/viaAlias.ts': "export { score } from '@/lib/engine/scoring';",
      'lib/email/viaRequire.ts': "const r = require('../report/build');",
      'lib/email/viaImport.ts': "const m = await import('@/data/constants');",
      'lib/email/clean.ts': "import { escape } from 'node:querystring';\n// import '@/lib/data/identity';\nexport const y = 1;",
    });

    it('find a record-holding import, a type import included, through a helper', () => {
      expect(recordImportsReachableFrom(['lib/email/templates.ts'], read)).toEqual([
        "lib/email/helpers.ts imports '@/types/domain'",
      ]);
    });

    it.each([
      ['a relative import', 'lib/email/direct.ts', "lib/email/direct.ts imports '../data/assessments'"],
      ['an alias re-export', 'lib/email/viaAlias.ts', "lib/email/viaAlias.ts imports '@/lib/engine/scoring'"],
      ['a require', 'lib/email/viaRequire.ts', "lib/email/viaRequire.ts imports '../report/build'"],
      ['a dynamic import', 'lib/email/viaImport.ts', "lib/email/viaImport.ts imports '@/data/constants'"],
    ])('find %s', (_what, file, expected) => {
      expect(recordImportsReachableFrom([file], read)).toEqual([expected]);
    });

    it('ignore a package, a comment and a path that only starts like a record holder', () => {
      expect(recordImportsReachableFrom(['lib/email/clean.ts'], read)).toEqual([]);
      const lookalike = fromMemory({ 'a.ts': "import '@/lib/database';\nimport '@/types/domains';" });
      expect(recordImportsReachableFrom(['a.ts'], lookalike)).toEqual([]);
    });
  });

  describe('for sendEmail call sites', () => {
    const read = fromMemory({
      'app/a.ts': "import { sendEmail } from '@/lib/email/send';\nawait sendEmail({ to, from, subject: 'hi', html, text });",
      'app/b.ts': "import { sendEmail } from '@/lib/email/send';\nimport { invitationEmail } from '@/lib/email/templates';\nawait sendEmail({ to, from, ...invitationEmail(x) });",
      'app/x/c.ts': "import { sendEmail } from '../../lib/email/send';\nimport * as t from '../../lib/email/templates';\nawait sendEmail(t.x());",
      'app/d.ts': "import type { EmailContent } from '@/lib/email/templates';\nawait sendEmail(content);",
      'app/e.ts': "export const note = 'nothing is sent here';",
      'lib/email/send.ts': 'export async function sendEmail(message) {}',
      'lib/other.ts': 'export async function sendEmail(message) {}',
    });

    it('find a caller that builds its own message, and one that imports only a type', () => {
      expect(sendersWithoutTemplates(['app/a.ts', 'app/b.ts', 'app/x/c.ts', 'app/d.ts', 'app/e.ts'], read)).toEqual(['app/a.ts', 'app/d.ts']);
    });

    it('treat a declaration as a definition, not a call', () => {
      expect(SEND_CALL.test('export async function sendEmail(message) {}')).toBe(false);
      expect(sendersWithoutTemplates(['lib/email/send.ts', 'lib/other.ts'], read)).toEqual([]);
    });
  });
});
