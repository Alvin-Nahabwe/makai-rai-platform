import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
 *     `SENTINEL-RECORD` to any field outside CONTENT_FREE. If the subject, text or html
 *     contains it, the template prints a record field. If the template merely READS one,
 *     that is caught as well: a template that takes a record field has stopped being
 *     content-free even on the day it forgets to print it.
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

/** An input whose every property outside CONTENT_FREE is the sentinel, and which records what was read. */
function recordInput(): { input: unknown; read: Set<string> } {
  const read = new Set<string>();
  const input = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      read.add(prop);
      return CONTENT_FREE.includes(prop) ? CONTENT_FREE_VALUES[prop] : SENTINEL;
    },
    // `'x' in input`, `{ ...input }` and `Object.keys(input)` see the same object `input.x` does.
    has: (_target, prop) => typeof prop === 'string',
    ownKeys: () => [...CONTENT_FREE],
    getOwnPropertyDescriptor: (_target, prop) =>
      typeof prop === 'string' && CONTENT_FREE.includes(prop)
        ? { value: CONTENT_FREE_VALUES[prop], enumerable: true, configurable: true, writable: true }
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
 */
const NOT_SCANNED = new Set(['node_modules', '__tests__', 'e2e', 'docs', 'public', 'coverage']);
function productionSource(rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, rel))) {
    if (name.startsWith('.') || NOT_SCANNED.has(name)) continue;
    const child = path.posix.join(rel, name);
    if (statSync(path.join(ROOT, child)).isDirectory()) out.push(...productionSource(child));
    else if (/\.[cm]?[jt]sx?$/.test(name)) out.push(child);
  }
  return out;
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

  it('flag a template that spreads its input into the body', () => {
    const spreader = ((i: object) => ({
      subject: 'x',
      text: JSON.stringify({ ...i, other: (i as { score?: string }).score }),
      html: 'x',
    })) as Template;
    expect(contentProblems(spreader)).toContain('text contains a record field');
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
