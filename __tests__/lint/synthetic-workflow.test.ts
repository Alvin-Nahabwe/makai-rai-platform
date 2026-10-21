import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';

/**
 * Task 20b (RL 2.3): .github/workflows/synthetic.yml is a manual, off-host smoke test of the sign-in, save and
 * read-back journey against production (scripts/synthetic-journey.mjs). The hourly run is not here: it is
 * ops/host/makrai-synthetic.sh, run from root's crontab on the host, with its own dead-man check. This workflow
 * answers one question during an incident, "is it the host or the world?", and never pings anything.
 *
 * The checks that hold for every workflow are made elsewhere and apply to this one the moment it exists:
 * release-and-deploy.test.ts (top-level `permissions`, only release.yml#release may write, actions pinned by SHA,
 * no U+0085/U+2028/U+2029) and dead-man-switches.test.ts (a scheduled workflow pings its own check, and no check is
 * used by both a crontab script and a workflow). This file holds what only this workflow must do:
 *
 *   - it runs by hand and on nothing else. A schedule would put a second hourly sender beside the host's, and a
 *     push or pull_request trigger would run a job that holds a production password on code from a branch or a
 *     fork;
 *   - it refers to no dead-man check: the file does not so much as name a `HC_` variable, so a run of it, passing
 *     or failing, can neither keep a check green nor turn it red;
 *   - it can only read the repository, queue behind itself and stop after five minutes;
 *   - it points at production, and the password and the account reach only the step that signs in, from no level
 *     above it (the workflow, the job) and from no other step, and no secret other than those four is read;
 *   - no `${{ }}` expression sits inside a `run:` script, where it would be pasted into the shell text.
 *
 * What no test here can prove is that the run succeeds against makrai.org. A manual run is that proof.
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

const source = (): string => readFileSync(join(REPO_ROOT, FILE), 'utf8');

function load(): Doc {
  expect(existsSync(join(REPO_ROOT, FILE)), `${FILE} should exist`).toBe(true);
  const doc = loadYaml(source(), { filename: FILE });
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

/** The trigger names, whichever of the three YAML spellings `on:` is written in. */
function triggers(): string[] {
  const on = load().on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String).sort();
  expect(typeof on === 'object' && on !== null, '`on:` should name its triggers').toBe(true);
  return Object.keys(on as Doc).sort();
}

// GitHub reads the `secrets` context name, a secret's name and the expression functions (`toJson`, `toJSON`) without
// regard to case, so every match below ignores it too, and a name is upper-cased before it is compared.
const secretsIn = (step: Step): string[] =>
  Object.values(step.env ?? {})
    .flatMap((v) => [...String(v).matchAll(/secrets\.([A-Za-z0-9_]+)/gi)].map((m) => m[1].toUpperCase()))
    .sort();

describe('synthetic.yml', () => {
  it('runs by hand and on no other trigger', () => {
    // Exactly `workflow_dispatch`: a `schedule` would be a second hourly sender beside the host's crontab, and a
    // push or pull_request trigger would run a job that holds the production password on code from a branch.
    expect(triggers()).toEqual(['workflow_dispatch']);
  });

  it('never pings: the file refers to no dead-man check, in the workflow or in a comment', () => {
    // The hourly check belongs to the host (ops/host/makrai-synthetic.sh, `HC_SYNTHETIC_PING_URL` in the server
    // .env). A reference here, even in a comment, is how a second sender gets back in. The whole text is searched,
    // comments included, in any case: GitHub reads secret names without regard to case.
    expect(source().match(/HC_/gi) ?? [], 'a reference to an HC_ variable').toEqual([]);
    expect(source().match(/hc-ping/gi) ?? [], 'a healthchecks ping URL').toEqual([]);
    // And no step does what a ping step does.
    const scripts = job().steps.flatMap((s) => (s.run === undefined ? [] : [s.run]));
    expect(scripts.filter((r) => /\bcurl\b|\bwget\b/.test(r)), 'a step that sends a request').toEqual([]);
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
    // The journey step has a limit of its own, shorter than the job's: a step that times out is a failed step with
    // its own name in the log, where a job that times out is cancelled as a whole.
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
    // production password to every step, including the third-party actions.
    const synthetic = (env: unknown) =>
      secretsIn({ env: (env ?? {}) as Record<string, string> }).filter((n) => n.startsWith('SYNTHETIC_'));
    expect(synthetic(doc.env), 'workflow-level env').toEqual([]);
    expect(synthetic(job().env), 'job-level env').toEqual([]);
    for (const step of steps.filter((s) => s !== journey)) {
      expect(synthetic(step.env), step.name ?? step.run ?? step.uses).toEqual([]);
    }

    // And nowhere else in the parsed file: not in a step's `with:`, a `defaults:` block, a container or a
    // service. Exactly four references to SYNTHETIC_* secrets exist, the four above, in any spelling of case, and
    // they are the only secrets the file reads at all. Reading the whole secrets context would sidestep that
    // count, so any `secrets` that is not followed by `.name` is refused, anywhere in the file: `toJson(secrets)`,
    // `secrets['NAME']`, `secrets.*`, `format('{0}', secrets)`, `secrets: inherit`.
    const text = JSON.stringify(doc);
    expect(text.match(/secrets\.SYNTHETIC_[A-Z0-9_]+/gi) ?? [], 'every reference to a SYNTHETIC_* secret').toHaveLength(4);
    expect(
      (text.match(/secrets\.[A-Za-z0-9_]+/gi) ?? []).filter((m) => !/^secrets\.SYNTHETIC_/i.test(m)),
      'a secret other than the four',
    ).toEqual([]);
    expect(text.match(/\bsecrets\b(?!\.[A-Za-z0-9_])/gi) ?? [], 'a read of the whole secrets context').toEqual([]);
  });

  it('keeps expressions out of run: scripts, so a value cannot become shell text', () => {
    const scripts = job().steps.filter((s) => s.run !== undefined);
    expect(scripts.length, 'no run: step found').toBeGreaterThan(0);
    expect(scripts.filter((s) => s.run!.includes('${{')).map((s) => s.name ?? s.run)).toEqual([]);
  });

  it('lets a failed step fail the run: no continue-on-error anywhere, and no shell or defaults override', () => {
    // `continue-on-error` on the journey step or the job would leave a run green after a failed journey, and the
    // run going red is the only signal a manual run gives. A `shell:` on a step, or `defaults.run.shell` at the
    // workflow or job level, replaces the default `bash -e {0}`. Read from the parsed file, so a comment cannot
    // trip it and a flow-style or aliased key cannot slip past it.
    const doc = load();
    expect(JSON.stringify(doc), 'continue-on-error at the workflow, a job or a step').not.toMatch(/continue-on-error/i);
    expect(doc, 'workflow-level defaults').not.toHaveProperty('defaults');
    expect(job(), 'job-level defaults').not.toHaveProperty('defaults');
    for (const step of job().steps) {
      expect(step, `${step.name ?? step.run ?? step.uses} declares a shell`).not.toHaveProperty('shell');
    }
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
