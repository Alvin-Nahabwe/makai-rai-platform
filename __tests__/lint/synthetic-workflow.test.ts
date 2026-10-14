import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
 *   - it points at production, and the password and the account reach only the step that signs in;
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
    const steps = job().steps;
    const journey = steps.find((s) => /synthetic-journey\.mjs/.test(s.run ?? ''))!;
    expect(journey.env).toMatchObject({
      SYNTHETIC_EMAIL: '${{ secrets.SYNTHETIC_EMAIL }}',
      SYNTHETIC_PASSWORD: '${{ secrets.SYNTHETIC_PASSWORD }}',
      SYNTHETIC_ORG_SLUG: '${{ secrets.SYNTHETIC_ORG_SLUG }}',
      SYNTHETIC_ASSESSMENT_ID: '${{ secrets.SYNTHETIC_ASSESSMENT_ID }}',
    });
    expect(secretsIn(journey)).toEqual(['SYNTHETIC_ASSESSMENT_ID', 'SYNTHETIC_EMAIL', 'SYNTHETIC_ORG_SLUG', 'SYNTHETIC_PASSWORD']);
    for (const step of steps.filter((s) => s !== journey)) {
      expect(secretsIn(step).filter((n) => n.startsWith('SYNTHETIC_')), step.name ?? step.run ?? step.uses).toEqual([]);
    }
    expect(job().env ?? {}, 'no secret at job level, where every step would see it').not.toHaveProperty('SYNTHETIC_PASSWORD');
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
});
