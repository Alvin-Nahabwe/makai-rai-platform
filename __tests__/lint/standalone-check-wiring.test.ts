import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * NFR-SEC-17, NFR-MNT-01: H0's `scripts/check-standalone.mjs` runs on every build that ships or is tested.
 * H0 wired it into the `verify` job; the image is built by docker/Dockerfile's own `npm run build`, and the
 * `test-e2e` job builds again, so both are wired here. The Dockerfile's RUN line is executed, with the build
 * replaced, against a temporary `.next/standalone` tree: what is proved is the line's exit status, not its text.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'check-standalone.mjs');
/** Files the server loads at run time without importing them (check-standalone.mjs RUNTIME_FILES). */
const RUNTIME = [
  'lib/auth/passwordHashWorker.js', 'node_modules/bcryptjs/package.json', 'node_modules/bcryptjs/umd/index.js', 'node_modules/bcryptjs/umd/package.json',
  'lib/documents/render/pdfWorker.mjs', 'lib/documents/render/breakPoints.mjs', 'lib/http/stackFrames.mjs', 'node_modules/@react-pdf/renderer/package.json',
  'node_modules/react/jsx-runtime.js', 'node_modules/react/cjs/react-jsx-runtime.production.js',
  // What the PDF worker's imports resolve to in the image (Task 16 review M6, traced from an isolated copy of .next/standalone).
  'node_modules/react/index.js', 'node_modules/react/cjs/react.production.js', 'node_modules/@react-pdf/renderer/lib/react-pdf.js',
];
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const builderRun = (): string => {
  const df = readFileSync('docker/Dockerfile', 'utf8');
  const builder = df.split(/^FROM /m).find((b) => /\bAS builder\b/.test(b.split('\n')[0])) ?? '';
  return builder.split('\n').find((l) => l.startsWith('RUN ') && l.includes('npm run build')) ?? '';
};

/** The Dockerfile's builder RUN line, with `npm run build` replaced by `build`, run by `sh -c` over a tree. */
function runLine(build: string, tree: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'standalone-wiring-'));
  made.push(cwd);
  for (const f of [...RUNTIME, ...tree]) {
    mkdirSync(dirname(join(cwd, '.next', 'standalone', f)), { recursive: true });
    writeFileSync(join(cwd, '.next', 'standalone', f), 'x');
  }
  const line = builderRun()
    .replace(/^RUN /, '')
    .replace('npm run build', build)
    .replaceAll('/tmp/build.log', join(cwd, 'build.log'))
    .replace('node scripts/check-standalone.mjs', `node ${SCRIPT}`);
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  return spawnSync('sh', ['-c', line], { cwd, encoding: 'utf8', env });
}

describe('the standalone check on every build', () => {
  it('NFR-SEC-17: the Dockerfile builder stage checks the build log in the same RUN as the build, with no escape', () => {
    const run = builderRun();
    expect(run).toMatch(/npm run build > \/tmp\/build\.log 2>&1; status=\$\?;/);
    expect(run).toMatch(/test "\$status" -eq 0 && node scripts\/check-standalone\.mjs \/tmp\/build\.log\s*$/);
    expect(run).not.toMatch(/\|\|\s*(true|:)/);
  });

  it('NFR-SEC-17: that RUN line fails for a failed build, a whole-project trace and a leaked .env, and passes for a clean tree', () => {
    expect(runLine('echo built', ['server.js']).status).toBe(0);
    expect(runLine('false', ['server.js']).status, 'a failed build is not rescued by a clean tree').not.toBe(0);
    expect(runLine('echo "traced unintentionally"', ['server.js']).status).toBe(1);
    expect(runLine('echo built', ['server.js', '.env']).status).toBe(1);
  });

  it('NFR-SEC-17: the build output still reaches the image build log', () => {
    expect(runLine('echo BUILD-OUTPUT-MARKER', ['server.js']).stdout).toContain('BUILD-OUTPUT-MARKER');
  });

  it('NFR-SEC-17: the test-e2e job tees the build log and checks it right after the build; verify keeps its own check', () => {
    const ci = loadYaml(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
    };
    const steps = ci.jobs['test-e2e'].steps;
    const i = steps.findIndex((s) => s.name === 'Build');
    expect(steps[i].run).toBe('mkdir -p test-results && set -o pipefail && npm run build 2>&1 | tee test-results/build.log');
    expect(steps[i + 1]).toMatchObject({ name: 'Check the standalone output', run: 'node scripts/check-standalone.mjs test-results/build.log' });
    expect(ci.jobs.verify.steps.some((s) => s.run === 'node scripts/check-standalone.mjs test-results/build.log')).toBe(true);
  });
});
