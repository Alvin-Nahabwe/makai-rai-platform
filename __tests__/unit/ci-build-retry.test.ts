import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { afterEach, expect, it } from 'vitest';

/**
 * NFR-MNT-03 (harness), the stop-gap for CI run 41073773967. Google's stylesheet for Source Sans 3 sometimes carries a font
 * URL with `&`, which Turbopack 16.4.2 splits: the build then stops with "next/font/google queries have exactly one entry"
 * once per @font-face rule, though nothing in the repository changed. `scripts/ci/build-retrying-font.sh` runs the build,
 * and when, and only when, the build fails with that signature in its output it deletes `.next` and builds again, at most
 * twice. These cases run it with a fake build in a scratch directory.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'ci', 'build-retrying-font.sh');
const SIGNATURE = 'next/font/google queries have exactly one entry';
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The output is matched as text, so any escape that arrives is removed first.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * A scratch directory with a stale `.next` and a fake build that answers according to `script`, one entry per call:
 * `sig` fails with the signature, `ok` succeeds, `other` fails with a type error, `exit<N>` fails with status N and no
 * text. It records, for every call, whether `.next` existed when it started.
 */
function scratch(script: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-build-retry-'));
  made.push(dir);
  mkdirSync(join(dir, '.next'));
  writeFileSync(join(dir, '.next', 'stale'), 'left by an earlier build');
  writeFileSync(join(dir, 'script.txt'), `${script.join('\n')}\n`);
  writeFileSync(join(dir, 'calls.txt'), '');
  writeFileSync(
    join(dir, 'fake-build.sh'),
    `#!/usr/bin/env bash
n=$(wc -l < calls.txt)
n=$((n + 1))
if [ -d .next ]; then echo "call $n: .next present" >> calls.txt; else echo "call $n: .next absent" >> calls.txt; fi
mkdir -p .next && echo "built by call $n" > ".next/from-call-$n"
step=$(sed -n "\${n}p" script.txt)
case "$step" in
  sig)    echo "Error: ${SIGNATURE}"; exit 1 ;;
  other)  echo "Type error: Property 'x' does not exist on type 'Y'."; exit 2 ;;
  exit*)  exit "\${step#exit}" ;;
  ok)     echo "Compiled successfully"; exit 0 ;;
esac
echo "script ran out at call $n"; exit 99
`,
  );
  chmodSync(join(dir, 'fake-build.sh'), 0o755);
  const run = (args: string[] = ['./fake-build.sh']) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
    delete env.FORCE_COLOR;
    const r = spawnSync('bash', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env, timeout: 30_000 });
    return {
      status: r.status,
      out: `${r.stdout}${r.stderr}`.replace(ANSI, ''),
      calls: readFileSync(join(dir, 'calls.txt'), 'utf8').split('\n').filter(Boolean),
      dir,
    };
  };
  return { run, dir };
}

it('NFR-MNT-03 (harness): the signature twice and then a good build passes, deleting .next and saying so before each retry', () => {
  const r = scratch(['sig', 'sig', 'ok']).run();
  expect(r.status, r.out).toBe(0);
  expect(r.calls).toEqual(['call 1: .next present', 'call 2: .next absent', 'call 3: .next absent']); // deleted before each retry
  expect(r.out.match(/retry \d of 2/g)).toEqual(['retry 1 of 2', 'retry 2 of 2']);
  expect(r.out).toContain('Compiled successfully');
  // Only the last build's output is in .next: the failed attempts' leftovers were deleted.
  expect(existsSync(join(r.dir, '.next', 'from-call-3'))).toBe(true);
  expect(existsSync(join(r.dir, '.next', 'from-call-1'))).toBe(false);
  expect(existsSync(join(r.dir, '.next', 'stale'))).toBe(false);
});

it('NFR-MNT-03 (harness): the signature three times fails with the build\'s own status, after exactly two retries', () => {
  const r = scratch(['sig', 'sig', 'sig', 'ok']).run();
  expect(r.status).toBe(1);
  expect(r.calls).toHaveLength(3); // the fourth, good build is never reached
  expect(r.out.match(/retry \d of 2/g)).toEqual(['retry 1 of 2', 'retry 2 of 2']);
  expect(r.out).toMatch(/gave up|giving up/i);
  expect(r.out).not.toContain('Compiled successfully');
});

it('NFR-MNT-03 (harness): any other failure fails at once, with its status, without a retry and without touching .next', () => {
  const r = scratch(['other', 'ok']).run();
  expect(r.status).toBe(2);
  expect(r.calls).toEqual(['call 1: .next present']);
  expect(r.out).toContain("Type error: Property 'x'");
  expect(r.out).not.toMatch(/retry/i);
  expect(existsSync(join(r.dir, '.next', 'stale'))).toBe(true);
  // A failure with no text at all is no signature either, and its status is kept.
  const silent = scratch(['exit7', 'ok']).run();
  expect(silent.status).toBe(7);
  expect(silent.calls).toHaveLength(1);
});

it('NFR-MNT-03 (harness): a different failure on a retry fails at once, and a good first build runs once', () => {
  const r = scratch(['sig', 'other', 'ok']).run();
  expect(r.status).toBe(2);
  expect(r.calls).toHaveLength(2);
  expect(r.out.match(/retry \d of 2/g)).toEqual(['retry 1 of 2']);
  const ok = scratch(['ok']).run();
  expect(ok.status).toBe(0);
  expect(ok.calls).toEqual(['call 1: .next present']); // a good build leaves .next alone
  expect(ok.out).not.toMatch(/retry/i);
});

it('NFR-MNT-03 (harness): with no arguments it runs `npm run build`, and every line of the build is on its stdout for the tee', () => {
  const s = scratch(['ok']);
  const bin = join(s.dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), '#!/usr/bin/env bash\necho "npm was called with: $*"\n');
  chmodSync(join(bin, 'npm'), 0o755);
  const r = spawnSync('bash', [SCRIPT], { cwd: s.dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: '1' } });
  expect(r.status).toBe(0);
  expect(r.stdout.replace(ANSI, '')).toContain('npm was called with: run build');
});

interface CiStep {
  name?: string;
  run?: string;
}

it('NFR-MNT-03 (harness): the verify job and the e2e job both build through the wrapper, and the verify job keeps pipefail and the tee check-standalone reads', () => {
  const jobs = (loadYaml(readFileSync('.github/workflows/ci.yml', 'utf8')) as { jobs: Record<string, { steps: CiStep[] }> }).jobs;
  const verify = jobs.verify.steps.find((s) => s.name === 'Build');
  expect(verify?.run?.trim()).toBe('mkdir -p test-results && set -o pipefail && scripts/ci/build-retrying-font.sh 2>&1 | tee test-results/build.log');
  const e2e = jobs['test-e2e'].steps.find((s) => s.name === 'Build');
  expect(e2e?.run?.trim()).toBe('scripts/ci/build-retrying-font.sh');
  // No other step runs the build bare.
  for (const [name, job] of Object.entries(jobs))
    for (const step of job.steps) expect(step.run ?? '', `${name}: ${step.name}`).not.toMatch(/(^|[\s;&|])npm run build(\s|$)/);
});

it('NFR-MNT-03 (harness): the wrapper is executable, retries on the one signature and no looser pattern, and app/layout.tsx is untouched', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  expect(src).toContain(SIGNATURE);
  expect(src).toMatch(/MAX_RETRIES=2/);
  expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
  expect(spawnSync('test', ['-x', SCRIPT]).status).toBe(0);
  expect(readFileSync('app/layout.tsx', 'utf8')).toContain("Source_Sans_3({"); // the real fix (local fonts) waits for the owner
});
