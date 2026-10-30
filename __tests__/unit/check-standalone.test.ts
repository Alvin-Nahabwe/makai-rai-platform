import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

/**
 * H-S11 (unit H0). `scripts/check-standalone.mjs <build-log>` fails the CI build job when a content
 * read made the build tracer pull in the whole project, or when the standalone output holds a file that
 * must never ship: a test, an `.env*` file or application source. It runs from the project root, so each
 * case writes a log and a `.next/standalone` tree into a temporary directory and runs the script there.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'check-standalone.mjs');
const made: string[] = [];

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runCheck(a: { log: string | null; tree: string[] | null }): { status: number | null; stdout: string; stderr: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'check-standalone-'));
  made.push(cwd);
  mkdirSync(join(cwd, 'test-results'), { recursive: true });
  if (a.log !== null) writeFileSync(join(cwd, 'test-results', 'build.log'), a.log);
  for (const f of a.tree ?? []) {
    const full = join(cwd, '.next', 'standalone', f);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, '');
  }
  if (a.tree !== null) mkdirSync(join(cwd, '.next', 'standalone'), { recursive: true });
  const r = spawnSync(process.execPath, [SCRIPT, 'test-results/build.log'], { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

it('NFR-SEC-17 (harness): check-standalone fails a whole-project trace and a leaked file', () => {
  const clean = runCheck({ log: 'Compiled successfully', tree: ['server.js', 'data/content/index.json', 'node_modules/x/__tests__/a.js'] });
  expect(clean.status).toBe(0);
  expect(clean.stdout).toContain('check-standalone: clean');

  for (const log of ['Warning: Dynamic filesystem access causes tracing of the whole project', 'WHOLE PROJECT traced', 'traced unintentionally'])
    expect(runCheck({ log, tree: ['server.js'] }), log).toMatchObject({ status: 1 });

  for (const leak of ['__tests__/fixtures/content/index.json', '.env', 'data/.env.local', 'app/api/t/route.ts', 'lib/content/root.ts', 'components/x.tsx'])
    expect(runCheck({ log: 'ok', tree: ['server.js', leak] }), leak).toMatchObject({ status: 1, stderr: expect.stringContaining(leak) });

  expect(runCheck({ log: null, tree: ['server.js'] }).status).toBe(1); // a missing log is a failure, not a pass
});

it('NFR-SEC-17 (harness): check-standalone fails when there is no standalone output to inspect', () => {
  const r = runCheck({ log: 'Compiled successfully', tree: null });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/^check-standalone: .*standalone.* not found/m);
});

it('NFR-SEC-17 (harness): check-standalone reports every finding, and lets compiled files and dependency test folders through', () => {
  const r = runCheck({
    log: 'traced unintentionally',
    tree: ['server.js', '.next/server/app/page.js', 'app/page.js', 'lib/content/root.js', 'node_modules/y/test/__tests__/b.js', '.env.production', 'lib/x.ts'],
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('traced unintentionally');
  expect(r.stderr).toContain('.env.production');
  expect(r.stderr).toContain('lib/x.ts');
  expect(r.stderr).not.toContain('app/page.js');
  expect(r.stderr).not.toContain('node_modules/y');
});
