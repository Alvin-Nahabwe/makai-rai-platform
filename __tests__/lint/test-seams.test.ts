import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContentSemver } from '@/types/content';
import { contentRoot, readContentBytes, readContentIndex, runningSemver } from '@/lib/content/root';

/**
 * H-S1, H-S2, H-S10 and H-S11 (unit H0). `lib/content/root.ts` is the only module
 * under `app/` or `lib/` that reads a content file, and it has a test seam: a
 * live test server can be pointed at the fixture bundle. The seam must never be
 * open in production, and no file that builds or deploys the production image
 * may mention its variables.
 *
 * This file tests the real module, so it removes the vitest setup file's mock
 * of it (`__tests__/setup/content.ts`, added by the fixture bundle task).
 */
vi.unmock('@/lib/content/root');

const DATA = join(process.cwd(), 'data', 'content');
const FIXTURES = join(process.cwd(), '__tests__', 'fixtures', 'content');
const SEAM_VARS = ['MAKRAI_TEST_SEAMS', 'MAKRAI_CONTENT_ROOT', 'MAKRAI_TEST_IDLE_SECONDS'] as const;

/** Each case builds its own roots inside the fixture directory, so no case depends on the generated bundle. */
let tmp = '';
let sibling = '';
const suffix = () => randomBytes(6).toString('hex');
const INDEX = { running: '9.9.9-tmp', versions: ['9.9.9-tmp'] };

function makeRoot(dir: string): void {
  mkdirSync(join(dir, '9.9.9-tmp'), { recursive: true });
  writeFileSync(join(dir, 'index.json'), JSON.stringify(INDEX));
  writeFileSync(join(dir, '9.9.9-tmp', 'questionBank.json'), '{"meta":{"version":"9.9.9-tmp"}}');
}

beforeEach(() => {
  tmp = join(FIXTURES, `.tmp-${suffix()}`);
  sibling = join(process.cwd(), '__tests__', 'fixtures', `content-other-${suffix()}`);
  makeRoot(tmp);
  makeRoot(sibling);
  symlinkSync(join(process.cwd(), 'data'), join(tmp, 'escape'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(sibling, { recursive: true, force: true });
});

/** Runs `fn` with exactly the given seam variables set and every other seam variable unset, then restores them. */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = Object.fromEntries(SEAM_VARS.map((v) => [v, process.env[v]]));
  for (const v of SEAM_VARS) delete process.env[v];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const v of SEAM_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  }
}

/** Every tracked or not-yet-tracked file, as the production-env lint lists them. */
function repoFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
  return out.split('\n').filter((f) => f !== '' && existsSync(f));
}

function filesUnder(dir: string): string[] {
  const files = repoFiles().filter((f) => f.startsWith(`${dir}/`));
  // A scan over a directory that is not there would pass for nothing.
  expect(files.length, `files under ${dir}`).toBeGreaterThan(0);
  return files;
}

/** Comments removed (a comment may name a call), except the tracer directive, which is the thing under test. */
function codeOf(src: string): string {
  return src
    .replace(/\/\*(?!turbopackIgnore)[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The text between the parenthesis opened at `open` and its match. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('unbalanced parenthesis in lib/content/root.ts');
}

const PRODUCTION_JOIN_ARGS = /^process\.cwd\(\), 'data', 'content'/;
const PRODUCTION_JOIN_CALL = /^join\(process\.cwd\(\), 'data', 'content'/;

/**
 * The argument text of every `join`, `readFileSync` and `realpathSync` call that is not the production
 * form. The production form (a literal prefix after `process.cwd()`, directly or as the argument of
 * `readFileSync`) is what the build tracer resolves to `data/content` alone; every other call is the
 * seam branch, whose computed arguments must be hidden from the tracer (contract, "Static read paths").
 */
function seamBranchCalls(src: string): string[] {
  const code = codeOf(src);
  const calls: string[] = [];
  for (const m of code.matchAll(/\b(join|readFileSync|realpathSync)\(/g)) {
    const args = balanced(code, m.index! + m[0].length - 1);
    const production = m[1] === 'join' ? PRODUCTION_JOIN_ARGS.test(args.trim()) : PRODUCTION_JOIN_CALL.test(args.trim());
    if (!production) calls.push(args);
  }
  return calls;
}

it('FR-CNT-01 NFR-SEC-17: the content seam is closed unless MAKRAI_TEST_SEAMS is exactly 1 and the real root is inside the fixture directory', () => {
  withEnv({ MAKRAI_CONTENT_ROOT: tmp }, () => expect(contentRoot()).toBe(DATA));
  withEnv({ MAKRAI_CONTENT_ROOT: tmp, MAKRAI_TEST_SEAMS: 'true' }, () => expect(contentRoot()).toBe(DATA));
  withEnv({ MAKRAI_CONTENT_ROOT: tmp, MAKRAI_TEST_SEAMS: '1' }, () => expect(contentRoot()).toBe(realpathSync(tmp)));
  withEnv({ MAKRAI_CONTENT_ROOT: join(tmp, '..', '..', '..', '..', 'data'), MAKRAI_TEST_SEAMS: '1' }, () =>
    expect(contentRoot()).toBe(DATA),
  );
  withEnv({ MAKRAI_CONTENT_ROOT: join(tmp, 'no-such-dir'), MAKRAI_TEST_SEAMS: '1' }, () => expect(contentRoot()).toBe(DATA)); // missing path
  withEnv({ MAKRAI_CONTENT_ROOT: tmp, MAKRAI_TEST_SEAMS: '1' }, () => {
    expect(runningSemver()).toBe('9.9.9-tmp');
    expect(readContentIndex()).toEqual({ running: '9.9.9-tmp', versions: ['9.9.9-tmp'] });
    expect(readContentBytes('9.9.9-tmp', 'questionBank.json').equals(readFileSync(join(tmp, '9.9.9-tmp', 'questionBank.json')))).toBe(true);
  });
});

it('FR-CNT-01 NFR-SEC-17: a symlink out of the fixture tree and a sibling directory both fall back to data/content', () => {
  withEnv({ MAKRAI_CONTENT_ROOT: join(tmp, 'escape'), MAKRAI_TEST_SEAMS: '1' }, () => expect(contentRoot()).toBe(DATA));
  withEnv({ MAKRAI_CONTENT_ROOT: sibling, MAKRAI_TEST_SEAMS: '1' }, () => expect(contentRoot()).toBe(DATA)); // the prefix check appends path.sep
  withEnv({ MAKRAI_CONTENT_ROOT: '', MAKRAI_TEST_SEAMS: '1' }, () => expect(contentRoot()).toBe(DATA)); // flag set, no root
});

it('FR-CNT-01: the fixture directory itself is an accepted root, because the live servers are pointed at it', () => {
  // playwright.config.ts and the slot environment set MAKRAI_CONTENT_ROOT to the fixture directory itself,
  // which holds index.json. A prefix check of "real root + separator" alone would refuse it.
  withEnv({ MAKRAI_CONTENT_ROOT: FIXTURES, MAKRAI_TEST_SEAMS: '1' }, () => expect(contentRoot()).toBe(realpathSync(FIXTURES)));
  withEnv({ MAKRAI_CONTENT_ROOT: FIXTURES, MAKRAI_TEST_SEAMS: '0' }, () => expect(contentRoot()).toBe(DATA));
});

it('FR-CNT-01 NFR-SEC-17: readContentBytes refuses a path-like semver or file name', () => {
  for (const [v, f] of [
    ['../..', 'package.json'],
    ['0.0.1-fixture', '../index.json'],
    ['0.0.1-fixture/..', 'x'],
    ['0.0.1-fixture', 'a\\b'],
    ['0.0.1-fixture', 'a\0b'],
    ['', 'questionBank.json'], // an empty name or "." would read the directory itself, not a file of a version
    ['.', 'questionBank.json'],
    ['0.0.1-fixture', ''],
    ['0.0.1-fixture', '.'],
  ])
    expect(() => readContentBytes(v as ContentSemver, f), `${v} ${f}`).toThrow(/content path/);
});

it('FR-CNT-01: no seam variable appears in an image, compose, env template, runbook or deploy file', () => {
  const files = [
    ...filesUnder('docker'),
    ...repoFiles().filter((f) => /(^|\/)Dockerfile[^/]*$/.test(f)),
    ...repoFiles().filter((f) => /(^|\/)docker-compose[^/]*\.yml$/.test(f)),
    '.env.example',
    ...filesUnder('docs/runbooks'),
    ...filesUnder('.github/workflows').filter((f) => f !== '.github/workflows/ci.yml'),
  ];
  for (const f of files)
    for (const v of SEAM_VARS) expect(readFileSync(f, 'utf8'), `${v} in ${f}`).not.toContain(v);
});

it('FR-CNT-01 NFR-SEC-17: the production read paths are literal and the seam branch is ignored by the tracer', () => {
  const src = readFileSync('lib/content/root.ts', 'utf8');
  const code = codeOf(src);
  expect(code).toContain("join(process.cwd(), 'data', 'content', 'index.json')");
  expect(code).toMatch(/join\(process\.cwd\(\), 'data', 'content', semver, file\)/);
  const seam = seamBranchCalls(src);
  expect(seam.length, 'the seam branch has calls to check').toBeGreaterThan(0);
  for (const call of seam) expect(call, call).toMatch(/^\s*\/\*turbopackIgnore: true\*\//); // every join, readFileSync, realpathSync with a computed argument
});

it('FR-CNT-01: the two content seam variables are justified absences from the production container', () => {
  const src = readFileSync('__tests__/lint/prod-env-completeness.test.ts', 'utf8');
  for (const v of ['MAKRAI_TEST_SEAMS', 'MAKRAI_CONTENT_ROOT'])
    expect(src).toMatch(new RegExp(`${v}:\\s*'test seam; must never reach the production container'`));
});

/** A fresh copy of the real module, because the warning is once per process, that is once per module instance. */
async function freshRoot(): Promise<typeof import('@/lib/content/root')> {
  vi.resetModules();
  return import('@/lib/content/root');
}

it('FR-CNT-01 NFR-SEC-17: a refused seam root warns once per process, and an accepted root or an unset flag warns nothing', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const root = await freshRoot();
    withEnv({}, () => root.contentRoot()); // nothing set
    withEnv({ MAKRAI_CONTENT_ROOT: tmp }, () => root.contentRoot()); // a root, no flag: production never sets the flag
    withEnv({ MAKRAI_CONTENT_ROOT: tmp, MAKRAI_TEST_SEAMS: 'true' }, () => root.contentRoot()); // not exactly 1: the seam was not asked for
    withEnv({ MAKRAI_CONTENT_ROOT: tmp, MAKRAI_TEST_SEAMS: '1' }, () => root.contentRoot()); // accepted
    withEnv({ MAKRAI_CONTENT_ROOT: FIXTURES, MAKRAI_TEST_SEAMS: '1' }, () => root.contentRoot()); // accepted
    expect(warn).not.toHaveBeenCalled();

    withEnv({ MAKRAI_CONTENT_ROOT: join(tmp, 'escape'), MAKRAI_TEST_SEAMS: '1' }, () => root.contentRoot()); // refused
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([expect.stringMatching(/^content seam refused \(.+\); reading data\/content$/)]);
    withEnv({ MAKRAI_CONTENT_ROOT: sibling, MAKRAI_TEST_SEAMS: '1' }, () => root.contentRoot()); // refused again
    withEnv({ MAKRAI_CONTENT_ROOT: join(tmp, 'no-such-dir'), MAKRAI_TEST_SEAMS: '1' }, () => root.contentRoot()); // and again
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

it('FR-CNT-01 NFR-SEC-17: the warning names why the seam was refused, and never the path', async () => {
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ MAKRAI_TEST_SEAMS: '1' }, /MAKRAI_CONTENT_ROOT is not set/],
    [{ MAKRAI_TEST_SEAMS: '1', MAKRAI_CONTENT_ROOT: join(process.cwd(), 'data') }, /outside __tests__\/fixtures\/content/],
    [{ MAKRAI_TEST_SEAMS: '1', MAKRAI_CONTENT_ROOT: join(tmp, 'no-such-dir') }, /cannot be resolved: ENOENT/],
  ];
  for (const [vars, reason] of cases) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const root = await freshRoot();
      withEnv(vars, () => expect(root.contentRoot()).toBe(DATA));
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toMatch(reason);
      expect(message).not.toContain(tmp);
    } finally {
      warn.mockRestore();
    }
  }
});
