import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
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

/**
 * H-S11's CI clause: the check only protects the image if the job that builds runs it right after the build,
 * on the log of that build, and cannot pass without it. `standaloneGateProblems` reads `.github/workflows/ci.yml`
 * and lists what is wrong; the cases below run it on the real file and on scratch copies that each break one part.
 */
interface CiStep {
  name?: string;
  run?: string;
  if?: unknown;
  'continue-on-error'?: unknown;
}

const CHECK_RUN = 'node scripts/check-standalone.mjs test-results/build.log';

function standaloneGateProblems(ci: string): string[] {
  const steps = (loadYaml(ci) as { jobs: { verify: { steps: CiStep[] } } }).jobs.verify.steps;
  const at = steps.findIndex((s) => s.name === 'Build');
  if (at < 0) return ['the verify job has no Build step'];
  const problems: string[] = [];
  const build = steps[at];
  if (!build.run?.includes('set -o pipefail')) problems.push('the Build step does not set pipefail, so a failed build behind tee would pass');
  if (!build.run?.includes('tee test-results/build.log')) problems.push('the Build step does not tee test-results/build.log');
  if ('continue-on-error' in build) problems.push('the Build step has continue-on-error');
  const check = steps[at + 1];
  if (check?.name !== 'Check the standalone output') {
    problems.push(`the step after Build is ${JSON.stringify(check?.name)}, not "Check the standalone output"`);
  } else {
    if (check.run?.trim() !== CHECK_RUN) problems.push(`the check step runs ${JSON.stringify(check.run)}, not ${CHECK_RUN}`);
    if ('continue-on-error' in check) problems.push('the check step has continue-on-error');
    if ('if' in check) problems.push('the check step has a condition');
  }
  return problems;
}

const CI = readFileSync('.github/workflows/ci.yml', 'utf8');
const CHECK_STEP = `      - name: Check the standalone output\n        run: ${CHECK_RUN}\n`;

/** A scratch copy of ci.yml; the edit must change it, or the case below would pass for nothing. */
function scratch(edit: (ci: string) => string): string {
  const out = edit(CI);
  expect(out).not.toBe(CI);
  return out;
}

it('NFR-SEC-17 (harness): the verify job runs check-standalone right after the build, on the build log, and cannot skip it', () => {
  expect(CI).toContain(CHECK_STEP);
  expect(standaloneGateProblems(CI)).toEqual([]);
});

it('NFR-SEC-17 (harness): the CI gate check names each way the standalone check can be dropped', () => {
  expect(standaloneGateProblems(scratch((c) => c.replace(CHECK_STEP, '')))).toEqual([
    expect.stringContaining('the step after Build is'),
  ]);
  expect(standaloneGateProblems(scratch((c) => c.replace('set -o pipefail && ', '')))).toEqual([expect.stringContaining('pipefail')]);
  expect(standaloneGateProblems(scratch((c) => c.replace('tee test-results/build.log', 'tee /dev/null')))).toEqual([
    expect.stringContaining('tee test-results/build.log'),
  ]);
  expect(standaloneGateProblems(scratch((c) => c.replace(CHECK_STEP, `${CHECK_STEP}        continue-on-error: true\n`)))).toEqual([
    expect.stringContaining('continue-on-error'),
  ]);
  expect(standaloneGateProblems(scratch((c) => c.replace(CHECK_STEP, `${CHECK_STEP}        if: false\n`)))).toEqual([
    expect.stringContaining('condition'),
  ]);
  expect(standaloneGateProblems(scratch((c) => c.replace(CHECK_RUN, 'node scripts/check-standalone.mjs other.log')))).toEqual([
    expect.stringContaining('check step runs'),
  ]);
  // Moved: the check before the build is not "right after" it.
  expect(
    standaloneGateProblems(scratch((c) => c.replace(CHECK_STEP, '').replace('      - name: Build\n        run: mkdir', `${CHECK_STEP}      - name: Build\n        run: mkdir`))),
  ).toEqual([expect.stringContaining('the step after Build is')]);
});
