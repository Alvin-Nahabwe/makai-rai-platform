import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';

/**
 * Task 20 (RL 2.3): .github/workflows/synthetic.yml runs the hourly sign-in, save and read-back
 * against production (scripts/synthetic-journey.mjs).
 *
 * The checks that hold for every workflow are made elsewhere and apply to this one the moment it
 * exists: release-and-deploy.test.ts (top-level `permissions`, only release.yml#release may write,
 * actions pinned by SHA, no U+0085/U+2028/U+2029) and dead-man-switches.test.ts (a scheduled workflow
 * pings its own check). This file holds what only this workflow must do:
 *
 *   - it runs on the hour schedule and by hand, and on nothing else. A push or pull_request trigger
 *     would run a job that holds a production password on code from a branch or a fork;
 *   - it can only read the repository, queue behind itself and stop after five minutes;
 *   - it points at production, and the password and the account reach only the step that signs in, from
 *     no level above it (the workflow, the job) and from no other step;
 *   - one step reports to the dead-man check, last, on scheduled runs only, and its script sends exactly
 *     one ping, to the check for a passing job and to /fail for any other status. The script is run here
 *     with a stand-in for curl;
 *   - no `${{ }}` expression sits inside a `run:` script, where it would be pasted into the shell text.
 *
 * What no test here can prove is that the run succeeds against makrai.org. The first run is that proof.
 */

const REPO_ROOT = join(__dirname, '../..');
const FILE = '.github/workflows/synthetic.yml';
const SCRIPT = 'scripts/synthetic-journey.mjs';

type Doc = Record<string, unknown>;
interface Step {
  name?: string;
  'timeout-minutes'?: number;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  'runs-on'?: string;
  'timeout-minutes'?: number;
  permissions?: unknown;
  env?: Record<string, string>;
  steps: Step[];
}

function load(): Doc {
  expect(existsSync(join(REPO_ROOT, FILE)), `${FILE} should exist`).toBe(true);
  const doc = loadYaml(readFileSync(join(REPO_ROOT, FILE), 'utf8'), { filename: FILE });
  expect(typeof doc === 'object' && doc !== null && !Array.isArray(doc), `${FILE} should parse to a mapping`).toBe(true);
  return doc as Doc;
}

function jobs(): Record<string, Job> {
  return load().jobs as Record<string, Job>;
}

/** The only job, whatever it is called. */
function job(): Job {
  const all = Object.values(jobs());
  expect(all, 'one job: the journey').toHaveLength(1);
  return all[0];
}

const secretsIn = (step: Step): string[] =>
  Object.values(step.env ?? {})
    .flatMap((v) => [...String(v).matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
    .sort();

describe('synthetic.yml', () => {
  it('runs hourly at :07 and by hand, and on no other trigger', () => {
    const on = load().on as Doc;
    expect(Object.keys(on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(on.schedule).toEqual([{ cron: '7 * * * *' }]);
  });

  it('can only read the repository, at the workflow level and on its job', () => {
    expect(load().permissions).toEqual({ contents: 'read' });
    expect(job().permissions, 'the job takes the workflow default').toBeUndefined();
  });

  it('queues behind a run in progress instead of cancelling it, and stops after five minutes', () => {
    const concurrency = load().concurrency;
    const group = typeof concurrency === 'string' ? concurrency : (concurrency as Doc | undefined)?.group;
    expect(group).toBe('synthetic');
    if (typeof concurrency === 'object') {
      expect((concurrency as Doc)['cancel-in-progress'] ?? false, 'a running probe is not cancelled').toBe(false);
    }
    expect(job()['timeout-minutes']).toBe(5);
    // The journey step has a limit of its own, shorter than the job's. A job that times out is cancelled and its
    // later steps may not run, so the failure() ping would never fire; a step that times out is a failed step.
    const journey = job().steps.find((s) => /synthetic-journey\.mjs/.test(s.run ?? ''))!;
    expect(journey['timeout-minutes'], 'the journey step has its own timeout').toBeLessThan(5);
  });

  it('runs scripts/synthetic-journey.mjs against production, and the script is in the repository', () => {
    expect(existsSync(join(REPO_ROOT, SCRIPT)), `${SCRIPT} should exist`).toBe(true);
    const journey = job().steps.filter((s) => /\bnode scripts\/synthetic-journey\.mjs\b/.test(s.run ?? ''));
    expect(journey, 'one step runs the journey').toHaveLength(1);
    // BASE_URL may sit on the step or on the job.
    expect({ ...job().env, ...journey[0].env }.BASE_URL).toBe('https://makrai.org');
  });

  it('gives the account and the password to the journey step alone', () => {
    const doc = load();
    const steps = job().steps;
    const journey = steps.find((s) => /synthetic-journey\.mjs/.test(s.run ?? ''))!;
    expect(journey.env).toMatchObject({
      SYNTHETIC_EMAIL: '${{ secrets.SYNTHETIC_EMAIL }}',
      SYNTHETIC_PASSWORD: '${{ secrets.SYNTHETIC_PASSWORD }}',
      SYNTHETIC_ORG_SLUG: '${{ secrets.SYNTHETIC_ORG_SLUG }}',
      SYNTHETIC_ASSESSMENT_ID: '${{ secrets.SYNTHETIC_ASSESSMENT_ID }}',
    });
    const FOUR = ['SYNTHETIC_ASSESSMENT_ID', 'SYNTHETIC_EMAIL', 'SYNTHETIC_ORG_SLUG', 'SYNTHETIC_PASSWORD'];
    expect(secretsIn(journey)).toEqual(FOUR);

    // No level above the step carries any of them: a workflow-level or job-level `env:` would hand the
    // production password to every step, including the third-party actions and the curl steps.
    const synthetic = (env: unknown) =>
      secretsIn({ env: (env ?? {}) as Record<string, string> }).filter((n) => n.startsWith('SYNTHETIC_'));
    expect(synthetic(doc.env), 'workflow-level env').toEqual([]);
    expect(synthetic(job().env), 'job-level env').toEqual([]);
    for (const step of steps.filter((s) => s !== journey)) {
      expect(synthetic(step.env), step.name ?? step.run ?? step.uses).toEqual([]);
    }

    // And nowhere else in the parsed file: not in a step's `with:`, a `defaults:` block, a container or a
    // service. Exactly four references to SYNTHETIC_* secrets exist, the four above. Reading the whole
    // secrets context (`secrets[...]`, `toJSON(secrets)`, `secrets: inherit`) would sidestep the count, so it is refused.
    const text = JSON.stringify(doc);
    expect(text.match(/secrets\.SYNTHETIC_[A-Z_]+/g) ?? [], 'every reference to a SYNTHETIC_* secret').toHaveLength(4);
    expect(text, 'the whole secrets context is never read').not.toMatch(/secrets\s*(\[|\}\})|toJSON\(\s*secrets|secrets["']?\s*:\s*["']?inherit/);
  });

  it('keeps expressions out of run: scripts, so a value cannot become shell text', () => {
    const scripts = job().steps.filter((s) => s.run !== undefined);
    expect(scripts.length, 'no run: step found').toBeGreaterThan(1);
    expect(scripts.filter((s) => s.run!.includes('${{')).map((s) => s.name ?? s.run)).toEqual([]);
  });

  it('checks out without leaving the token in .git/config, and sets up the Node in .nvmrc', () => {
    const steps = job().steps;
    const checkout = steps.find((s) => /^actions\/checkout@/.test(s.uses ?? ''));
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    const node = steps.find((s) => /^actions\/setup-node@/.test(s.uses ?? ''));
    expect(node?.with?.['node-version-file']).toBe('.nvmrc');
    expect(steps.indexOf(checkout!), 'checkout comes first').toBe(0);
    expect(steps.indexOf(node!), 'Node is set up before the journey runs').toBeLessThan(steps.findIndex((s) => /synthetic-journey/.test(s.run ?? '')));
  });

  describe('the dead-man ping step', () => {
    const HC_URL = 'https://hc-ping.example.invalid/synthetic-check';
    const scratch: string[] = [];
    afterAll(() => {
      for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
    });

    const pingStep = (): Step => {
      const steps = job().steps.filter((s) => JSON.stringify(s.env ?? {}).includes('secrets.HC_SYNTHETIC_PING_URL'));
      expect(steps, 'exactly one step reports to HC_SYNTHETIC_PING_URL').toHaveLength(1);
      return steps[0];
    };

    /** Runs the step's script the way a runner does (`bash -eo pipefail`), with a curl that only records its arguments. */
    function runPing(jobStatus: string | undefined): { status: number | null; curlCalls: string[] } {
      const dir = mkdtempSync(join(tmpdir(), 't20-ping-'));
      scratch.push(dir);
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const log = join(dir, 'curl.log');
      writeFileSync(join(bin, 'curl'), '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$FAKE_LOG"\n');
      chmodSync(join(bin, 'curl'), 0o755);
      const env: Record<string, string> = { PATH: `${bin}:/usr/bin:/bin`, HC_URL, FAKE_LOG: log };
      if (jobStatus !== undefined) env.JOB_STATUS = jobStatus;
      const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', pingStep().run!], { env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
      const curlCalls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
      return { status: r.status, curlCalls };
    }

    it('runs on scheduled runs only, and after a failed or cancelled step', () => {
      expect(pingStep().if).toBe("always() && github.event_name == 'schedule'");
    });

    it.each([
      ['success', HC_URL],
      ['failure', `${HC_URL}/fail`],
      ['cancelled', `${HC_URL}/fail`],
      ['skipped', `${HC_URL}/fail`],
      ['', `${HC_URL}/fail`],
    ])('sends exactly one ping for a job that is %j: to %s', (jobStatus, url) => {
      const { status, curlCalls } = runPing(jobStatus);
      expect(status).toBe(0);
      expect(curlCalls, 'one curl call').toEqual([`-fsS -m 10 --retry 3 -o /dev/null ${url}`]);
    });

    it('reports /fail when the job status is not set at all, rather than a pass', () => {
      const { curlCalls } = runPing(undefined);
      expect(curlCalls).toEqual([`-fsS -m 10 --retry 3 -o /dev/null ${HC_URL}/fail`]);
    });
  });
});
