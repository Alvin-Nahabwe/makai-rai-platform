import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { load as loadYaml } from 'js-yaml';
import { afterEach, expect, it } from 'vitest';

/**
 * NFR-PERF-01 (SRS line 3189): first-load JavaScript is at most 160 KB gzip for a public page and 190 KB for a
 * signed-in one. `scripts/measure_first_load.mjs <.next>` measures every route of a build and exits 1 above the
 * budget. Each case writes a small fake `.next` directory (a `build-manifest.json`, chunk files and two
 * `page_client-reference-manifest.js` files in the shape Next 16 writes) and runs the script on it, so the
 * sizes are known and no build is needed.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'measure_first_load.mjs');
const made: string[] = [];

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Bytes that gzip cannot shrink (a xorshift stream), so a chunk's gzip size is close to its length and known. */
function noise(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let x = seed || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = (x >>> 0) & 0xff;
  }
  return out;
}

const gz = (b: Buffer) => gzipSync(b, { level: 9 }).length;
const kb = (bytes: number) => (bytes / 1024).toFixed(1);

const CHUNKS = {
  root: noise(100_000, 11), // rootMainFiles: counted for every route
  polyfill: noise(80_000, 12), // polyfillFiles: never counted
  login: noise(40_000, 13), // /login: 100 000 + 40 000 bytes stays under 160 KB
  dash: noise(95_000, 14), // dashboard: 100 000 + 95 000 bytes is over 190 KB
};

function manifestFor(key: string, entries: Record<string, string[]>): string {
  // Next writes a second assignment after the initialiser; the object is plain JSON.
  return `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\nglobalThis.__RSC_MANIFEST[${JSON.stringify(key)}] = ${JSON.stringify({
    moduleLoading: { prefix: '' },
    clientModules: {},
    entryCSSFiles: {},
    entryJSFiles: entries,
  })};\n`;
}

interface FakeOptions {
  dashboard?: boolean;
  /** Skips writing this chunk file although the manifests name it. */
  omitChunk?: keyof typeof CHUNKS;
}

function fakeBuild(opts: FakeOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'measure-first-load-'));
  made.push(dir);
  const write = (rel: string, data: string | Buffer) => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  };
  write('build-manifest.json', JSON.stringify({ rootMainFiles: ['static/chunks/root.js'], polyfillFiles: ['static/chunks/polyfill.js'] }));
  for (const [name, bytes] of Object.entries(CHUNKS)) if (name !== opts.omitChunk) write(`static/chunks/${name}.js`, bytes);
  write(
    'server/app/(public)/login/page_client-reference-manifest.js',
    manifestFor('/(public)/login/page', {
      '[project]/app/layout': ['static/chunks/root.js'], // also a root file: counted once
      '[project]/app/(public)/login/page': ['static/chunks/root.js', 'static/chunks/login.js'],
    }),
  );
  if (opts.dashboard !== false) {
    write(
      'server/app/(authenticated)/orgs/[slug]/dashboard/page_client-reference-manifest.js',
      manifestFor('/(authenticated)/orgs/[slug]/dashboard/page', {
        '[project]/app/(authenticated)/orgs/[slug]/dashboard/page': ['static/chunks/dash.js'],
      }),
    );
  }
  return dir;
}

// The script's output is matched as text, so it runs without colour (NO_COLOR, no FORCE_COLOR) and any escape that
// still arrives is removed, because CI colours a child's output and an agent session does not.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', ...extraEnv };
  delete env.FORCE_COLOR;
  if (!('RELEASE_CANDIDATE' in extraEnv)) delete env.RELEASE_CANDIDATE;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: process.cwd(), encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout.replace(ANSI, ''), stderr: r.stderr.replace(ANSI, '') };
}

function exceptionsFile(entries: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'first-load-exceptions-'));
  made.push(dir);
  const file = join(dir, 'exceptions.json');
  writeFileSync(file, JSON.stringify(entries));
  return file;
}

const LOGIN_KB = kb(gz(CHUNKS.root) + gz(CHUNKS.login));
const DASH_KB = kb(gz(CHUNKS.root) + gz(CHUNKS.dash));
const DASH_EXCEPTION = [{ route: '/orgs/[slug]/dashboard', reason: 'the score charts, until the score removal merges' }];

it('NFR-PERF-01: public routes are held to 160 KB, signed-in routes to 190 KB, gzip of root plus entry chunks', () => {
  const r = run([fakeBuild(), '--exceptions', exceptionsFile([])]);
  expect(r.stdout).toContain(`route=/login firstLoadKB=${LOGIN_KB} budgetKB=160`); // under (public); the root chunk is counted once
  expect(r.stdout).toContain(`route=/orgs/[slug]/dashboard firstLoadKB=${DASH_KB} budgetKB=190`);
  expect(Number(DASH_KB)).toBeGreaterThan(190); // the fixture really is over, so the exit code below proves the comparison
  expect(Number(LOGIN_KB)).toBeLessThan(160);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('/orgs/[slug]/dashboard');
  expect(r.stderr).not.toContain('/login');
});

it('NFR-PERF-01: a build within budget exits 0, polyfills and CSS are not counted, and a route group is not part of the route', () => {
  const r = run([fakeBuild({ dashboard: false }), '--exceptions', exceptionsFile([])]);
  expect(r.status).toBe(0);
  expect(r.stdout.trim().split('\n')).toEqual([`route=/login firstLoadKB=${LOGIN_KB} budgetKB=160`]);
  // The polyfill file is 80 000 bytes; counting it would put /login at (100 000 + 40 000 + 80 000) / 1024 = 215 KB.
  expect(Number(LOGIN_KB)).toBeLessThan(160);
});

it('NFR-PERF-01: a listed exception passes until its route is gone, then the stale entry fails', () => {
  const listed = exceptionsFile(DASH_EXCEPTION);
  const over = run([fakeBuild(), '--exceptions', listed]);
  expect(over.status).toBe(0);
  expect(over.stdout).toContain(`route=/orgs/[slug]/dashboard firstLoadKB=${DASH_KB} budgetKB=190`);
  expect(over.stdout).toContain('exception');
  expect(over.stdout).toContain('the score charts');

  // The route is gone from the build: the entry names nothing, so it fails and says which route.
  const gone = run([fakeBuild({ dashboard: false }), '--exceptions', listed]);
  expect(gone.status).toBe(1);
  expect(gone.stderr).toMatch(/stale[^\n]*\/orgs\/\[slug\]\/dashboard/);

  // The route is back within budget: the entry is stale as well.
  const within = run([fakeBuild(), '--exceptions', exceptionsFile([{ route: '/login', reason: 'was heavy' }])]);
  expect(within.status).toBe(1);
  expect(within.stderr).toMatch(/stale[^\n]*\/login/);
  expect(within.stderr).toContain('/orgs/[slug]/dashboard'); // and the dashboard, no longer excepted, is over budget
});

it('NFR-PERF-01: RELEASE_CANDIDATE=1 fails while any exception is listed', () => {
  const listed = exceptionsFile(DASH_EXCEPTION);
  const r = run([fakeBuild(), '--exceptions', listed], { RELEASE_CANDIDATE: '1' });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/RELEASE_CANDIDATE[^\n]*\/orgs\/\[slug\]\/dashboard/);
  // Without it the same run passes (the case above), and an empty list passes under it.
  expect(run([fakeBuild({ dashboard: false }), '--exceptions', exceptionsFile([])], { RELEASE_CANDIDATE: '1' }).status).toBe(0);
});

it('NFR-PERF-01: a build it cannot read is a failure of its own (exit 2), never a pass', () => {
  const none = exceptionsFile([]);
  const noBuild = run([join(tmpdir(), 'measure-first-load-does-not-exist'), '--exceptions', none]);
  expect(noBuild.status).toBe(2);
  expect(noBuild.stderr).toMatch(/build-manifest\.json/);

  const empty = mkdtempSync(join(tmpdir(), 'measure-first-load-empty-'));
  made.push(empty);
  writeFileSync(join(empty, 'build-manifest.json'), JSON.stringify({ rootMainFiles: [] }));
  const noAppDir = run([empty, '--exceptions', none]);
  expect(noAppDir.status).toBe(2);
  expect(noAppDir.stderr).toMatch(/server[/\\]app/);
  mkdirSync(join(empty, 'server', 'app'), { recursive: true });
  const noRoutes = run([empty, '--exceptions', none]);
  expect(noRoutes.status).toBe(2);
  expect(noRoutes.stderr).toMatch(/no route/i);

  const missingChunk = run([fakeBuild({ omitChunk: 'login' }), '--exceptions', none]);
  expect(missingChunk.status).toBe(2);
  expect(missingChunk.stderr).toContain('static/chunks/login.js');

  for (const bad of [{}, [{ route: '/x' }], [{ route: '', reason: 'r' }], ['/x'], [{ route: '/x', reason: '' }]])
    expect(run([fakeBuild(), '--exceptions', exceptionsFile(bad)]).status, JSON.stringify(bad)).toBe(2);
  expect(run([]).status).toBe(2); // no build directory given
});

it('NFR-PERF-01: the committed exception list is an empty array (scripts/first-load-exceptions.json)', () => {
  expect(JSON.parse(readFileSync('scripts/first-load-exceptions.json', 'utf8'))).toEqual([]);
});

it('NFR-PERF-01: the verify job measures first-load JavaScript right after the standalone check, and cannot skip it', () => {
  interface Step {
    name?: string;
    run?: string;
    if?: unknown;
    'continue-on-error'?: unknown;
  }
  const steps = (loadYaml(readFileSync('.github/workflows/ci.yml', 'utf8')) as { jobs: { verify: { steps: Step[] } } }).jobs.verify.steps;
  const at = steps.findIndex((s) => s.name === 'Check the standalone output');
  expect(at).toBeGreaterThan(0);
  const measure = steps[at + 1];
  expect(measure?.name).toBe('Measure first-load JavaScript');
  expect(measure?.run?.trim()).toBe('node scripts/measure_first_load.mjs .next');
  expect(measure).not.toHaveProperty('continue-on-error');
  expect(measure).not.toHaveProperty('if');
});
