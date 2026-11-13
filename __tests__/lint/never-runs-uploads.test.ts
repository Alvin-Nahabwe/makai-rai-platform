import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { inspect } from '@/lib/evidence/inspect';

/**
 * FR-PUB-04: the platform never runs evaluations, models, notebooks or
 * uploaded files, and never computes metrics from a team's data. About
 * (S-28, `app/(public)/about/page.tsx`) states part of it: the platform does
 * not test a model or calculate anything from a team's data; this test keeps
 * the whole of it true.
 *
 * Two properties, each checked from a different side:
 *   1. No module under `app` or `lib` can start a process, a script, a worker,
 *      a VM context or a notebook runner. Code only: a comment that names a
 *      notebook does not count; any string naming `child_process`, `vm` or
 *      `worker_threads` does, however the module would be loaded.
 *   2. The only code that looks inside an uploaded file, `lib/evidence/inspect.ts`,
 *      reads at most the first 16 bytes and parses nothing.
 *
 * What this cannot prove: that a future route which streams a file to another
 * service is harmless. It proves the application itself has no way to run one.
 */

/** A string literal that names a module able to run code, with or without `node:`, whatever reaches it. */
const BANNED_MODULE = /['"`](node:)?(child_process|vm|worker_threads)['"`]/g;

/**
 * Any naming of a runner module counts, not only `import` and `require` syntax: `process.getBuiltinModule('node:vm')`,
 * an alias of it, or `createRequire(...)('child_process')` reach the same module (C4 pool re-review I1).
 */
const RUNNERS = new RegExp(
  `${BANNED_MODULE.source}|\\bFunction\\s*\\(|\\beval\\s*\\(|jupyter|nbconvert|papermill|pyodide|python-shell`,
);

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|mts|cjs)$/;

/**
 * The one worker the platform starts (FR-ACC-05, coordinator ruling bcrypt_pool): `lib/auth/passwordHash.ts` runs
 * bcryptjs on worker threads so password checks do not hold the event loop. It starts only its own fixed file,
 * `lib/auth/passwordHashWorker.js`, which compares or hashes a password and nothing else. These two files are exempt from
 * the worker_threads ban and from nothing more, and the case below checks that they stay that narrow.
 */
const PASSWORD_HASH_POOL = [join('lib', 'auth', 'passwordHash.ts'), join('lib', 'auth', 'passwordHashWorker.js')];
/** A require( or import( whose argument is not a string literal: a module name computed at run time (final review m-B). */
const DYNAMIC_LOADER = /\b(require|import)\(\s*[^'"`\s)]/;
/** The loaders that take a name outside import syntax; each use is allowed only where it is listed below (final review m-B). */
const OTHER_LOADERS = /\bgetBuiltinModule\b|\bcreateRequire\b|\bprocess\.(binding|_linkedBinding|dlopen)\b/;

const RUNNERS_BUT_WORKERS = new RegExp(RUNNERS.source.replace(/\|worker_threads/g, ''));

function codeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : codeFiles(path);
    return CODE_FILE.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/**
 * The code of a file with its comments left out. Each token keeps its own text; the
 * trivia before it (spaces, newlines, comments) becomes one space, or nothing when there
 * was none, so `new Function(` stays one piece and a comment never reaches the pattern.
 *
 * Kept per path for the run: the cases apply several patterns to the same files, and parsing is
 * the slow step, so each file is parsed once. No file a case scans changes after its first read.
 */
const codeByFile = new Map<string, string>();
function codeOf(file: string): string {
  let code = codeByFile.get(file);
  if (code === undefined) {
    code = parseCode(file);
    codeByFile.set(file, code);
  }
  return code;
}

function parseCode(file: string): string {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let out = '';
  const visit = (n: ts.Node): void => {
    // A doc comment is a node of its own in the tree; it is a comment, not code.
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (n.getChildCount(sf) === 0) {
      if (n.kind === ts.SyntaxKind.EndOfFileToken) return;
      out += (n.getStart(sf) > n.getFullStart() ? ' ' : '') + n.getText(sf);
    } else {
      n.getChildren(sf).forEach(visit);
    }
  };
  visit(sf);
  return out;
}

/** The root modules that run in the server: proxy.ts and instrumentation*.ts. */
function rootModules(): string[] {
  return readdirSync('.').filter((n) => /^(proxy|instrumentation[\w.-]*)\.(ts|js|mjs)$/.test(n));
}

/** `file` of every code file under `roots`, and every file in `extra`, whose code matches `re`. */
function grepTs(roots: string[], re: RegExp, extra: string[] = []): string[] {
  return [...roots.flatMap((root) => codeFiles(root)), ...extra]
    .filter((f) => re.test(codeOf(f)))
    .map((f) => relative(process.cwd(), f));
}

/** The magic byte strings in `lib/evidence/inspect.ts`, read from its source: the table is not exported. */
function signatureLengths(): number[] {
  const src = readFileSync('lib/evidence/inspect.ts', 'utf8');
  return [...src.matchAll(/Buffer\.from\('([0-9a-f]+)',\s*'hex'\)/g)].map((m) => m[1].length / 2);
}

describe('uploads are never executed or parsed', () => {
  it('FR-PUB-04: no module under app, lib or components, and no root server module, can run a process, a script or a notebook', () => {
    // A scan that read nothing would pass: both roots must hold code, and the evidence module must be in it.
    for (const root of ['app', 'lib', 'components']) expect(codeFiles(root).length, `no code found under ${root}`).toBeGreaterThan(0);
    expect(codeFiles('lib')).toContain(join('lib', 'evidence', 'inspect.ts'));
    // A server component under components/ and the root modules run on the server too.
    expect(rootModules(), 'the root modules proxy.ts and instrumentation.ts were found').toEqual(expect.arrayContaining(['proxy.ts', 'instrumentation.ts']));
    expect(grepTs(['app', 'lib', 'components'], RUNNERS, rootModules()).filter((f) => !PASSWORD_HASH_POOL.includes(f))).toEqual([]);
    // A name the pattern above cannot read: no require( or import( of a computed name anywhere, and getBuiltinModule only
    // in the pool and in lib/integrity/canonical.mjs (node:crypto, by a literal), and no other loader at all.
    expect(grepTs(['app', 'lib', 'components'], DYNAMIC_LOADER, rootModules())).toEqual([]);
    expect(grepTs(['app', 'lib', 'components'], OTHER_LOADERS, rootModules()).sort())
      .toEqual([join('lib', 'auth', 'passwordHash.ts'), join('lib', 'integrity', 'canonical.mjs')].sort());
  });

  it('FR-PUB-04 FR-ACC-05: the password hash pool starts only its own worker file, which runs bcryptjs and nothing else', () => {
    // Outside worker_threads, the two files match nothing a runner would.
    for (const f of PASSWORD_HASH_POOL) expect(RUNNERS_BUT_WORKERS.test(codeOf(f)), f).toBe(false);
    // Each file names a banned module only as 'node:worker_threads', and only where the pool needs it: the pool's type
    // import and its one getBuiltinModule call; the worker's one require.
    const banned = (f: string) => [...codeOf(f).matchAll(BANNED_MODULE)].map((m) => m[0]).sort();
    expect(banned(PASSWORD_HASH_POOL[0])).toEqual(["'node:worker_threads'", "'node:worker_threads'"]);
    expect(banned(PASSWORD_HASH_POOL[1])).toEqual(["'node:worker_threads'"]);
    expect([...codeOf(PASSWORD_HASH_POOL[0]).matchAll(/\bgetBuiltinModule\b/g)]).toHaveLength(1);
    // That one call loads worker_threads, and the one Worker it builds gets the path and no options (no eval, no argv).
    expect(codeOf(PASSWORD_HASH_POOL[0])).toMatch(/process\.getBuiltinModule\('node:worker_threads'\)/);
    expect([...codeOf(PASSWORD_HASH_POOL[0]).matchAll(/\bWorker\)\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['workerPath']);
    // The worker loads exactly two modules: the thread's message port and bcryptjs.
    const worker = codeOf(PASSWORD_HASH_POOL[1]);
    expect([...worker.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]).sort()).toEqual(['bcryptjs', 'node:worker_threads']);
    expect(worker).not.toMatch(/\bimport\s*\(|\bprocess\.(binding|dlopen)|\bnew\s+Worker\b/);
    expect(worker).toMatch(/bcrypt\.compareSync\(a, b\) : bcrypt\.hashSync\(a, b\)/);
    // The pool's own path is a fixed file, and no module passes it another one (the option exists for the tests).
    const pool = codeOf(PASSWORD_HASH_POOL[0]);
    expect(pool).toMatch(/WORKER_PATH = join\(process\.cwd\(\), 'lib', 'auth', 'passwordHashWorker\.js'\)/);
    expect(grepTs(['app', 'lib', 'components'], /\bworkerPath\b/, rootModules())).toEqual([PASSWORD_HASH_POOL[0]]);
  });

  it('FR-PUB-04: the scan flags a process import in code and ignores a comment that names a notebook', () => {
    // The sources below are text written to a temporary directory and scanned. Nothing here executes them.
    const dir = mkdtempSync(join(tmpdir(), 'never-runs-'));
    try {
      mkdirSync(join(dir, 'lib'));
      writeFileSync(join(dir, 'lib', 'run.ts'), "import { exec } from 'node:child_process';\nexport const r = exec;\n");
      writeFileSync(join(dir, 'lib', 'req.js'), "const cp = require('child_process');\nmodule.exports = cp;\n");
      writeFileSync(join(dir, 'lib', 'dyn.ts'), "export const f = new Function('return 1');\nexport const e = eval('1');\n");
      writeFileSync(join(dir, 'lib', 'nb.ts'), "export const url = 'https://example.org/jupyter/lab';\n");
      writeFileSync(join(dir, 'lib', 'dynimport.ts'), "export const load = () => import('node:child_process');\n");
      writeFileSync(join(dir, 'lib', 'worker.js'), "const w = require('worker_threads');\nmodule.exports = w;\n");
      writeFileSync(join(dir, 'lib', 'fn.ts'), "export const g = Function('return 1');\n");
      // A builtin reached without import syntax: by getBuiltinModule, directly and through an alias, and by createRequire.
      writeFileSync(join(dir, 'lib', 'gbm.ts'), "export const cp = process.getBuiltinModule('node:child_process');\n");
      writeFileSync(join(dir, 'lib', 'alias.ts'), "const load = process.getBuiltinModule;\nexport const v = load('node:vm');\n");
      writeFileSync(join(dir, 'lib', 'cr.ts'), "import { createRequire } from 'node:module';\nexport const w = createRequire(import.meta.url)(\"worker_threads\");\n");
      // Another builtin by the same API stays legal (lib/integrity/canonical.mjs reads node:crypto this way).
      writeFileSync(join(dir, 'lib', 'crypto.mjs'), "export const c = process.getBuiltinModule('node:crypto');\n");
      // A name built at run time, which no string pattern can read: the dynamic-loader check catches the call instead.
      writeFileSync(join(dir, 'lib', 'computed.js'), "const n = ['child', 'process'].join('_');\nmodule.exports = require(n);\n");
      writeFileSync(
        join(dir, 'lib', 'comment.ts'),
        [
          '// Never import child_process or run a jupyter notebook here.',
          '/* papermill, pyodide */',
          '/** Never run a jupyter notebook. Never call eval( or new Function( on a file. */',
          'export const ok = 1;',
          '/**',
          ' * @returns nothing; python-shell is not used.',
          ' */',
          'export function f(): void {}',
          '',
        ].join('\n'),
      );
      const flagged = grepTs([join(dir, 'lib')], RUNNERS).map((f) => f.split('/').pop());
      expect(flagged.sort()).toEqual(['alias.ts', 'cr.ts', 'dyn.ts', 'dynimport.ts', 'fn.ts', 'gbm.ts', 'nb.ts', 'req.js', 'run.ts', 'worker.js']);
      expect(grepTs([join(dir, 'lib')], DYNAMIC_LOADER).map((f) => f.split('/').pop())).toEqual(['computed.js']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-04: the evidence check reads at most the first 16 bytes and parses nothing', () => {
    const lengths = signatureLengths();
    const entries = (readFileSync('lib/evidence/inspect.ts', 'utf8').match(/\bmagic:(?!\s*Buffer;)/g) ?? []).length; // not the type annotation
    expect(lengths.length, 'a signature in lib/evidence/inspect.ts is not written as Buffer.from(hex, "hex")').toBe(entries);
    expect(lengths.length, 'no signature found in lib/evidence/inspect.ts').toBeGreaterThanOrEqual(4);
    for (const s of lengths) expect(s).toBeLessThanOrEqual(16);

    // Whatever follows byte 16 cannot change the answer: replace the tail with zeros and compare.
    const magics = [...readFileSync('lib/evidence/inspect.ts', 'utf8').matchAll(/Buffer\.from\('([0-9a-f]+)',\s*'hex'\)/g)].map(
      (m) => m[1],
    );
    for (const hex of magics) {
      const buf = Buffer.concat([Buffer.from(hex, 'hex'), randomBytes(4096)]);
      const headOnly = Buffer.concat([buf.subarray(0, 16), Buffer.alloc(buf.length - 16)]);
      expect(headOnly.length).toBe(buf.length);
      expect(inspect(buf)).toEqual(inspect(headOnly));
      expect(inspect(buf).ok, hex).toBe(true);
    }

    expect(readFileSync('lib/evidence/inspect.ts', 'utf8')).not.toMatch(/\.toString\(|JSON\.parse|import\(|require\(/);
  });
});
