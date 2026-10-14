import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';

/**
 * Service parameters and security.txt (G2-22, G2-10, M0-01).
 *
 * M0's first condition cannot be evaluated without a published patch window, so the Gate 2
 * values are published as `/service-parameters.json`, and the security contact as RFC 9116's
 * `/.well-known/security.txt`, whose `Contact` is a role address on the project domain rather
 * than a personal inbox (G2-10 (b)).
 *
 * Three obligations ride on these files:
 *   1. the JSON carries exactly the decided values;
 *   2. security.txt names the role contact and has an `Expires` that is valid today;
 *   3. a scheduled CI job keeps (2) true. RFC 9116 treats a file past its `Expires` as stale, and
 *      a date that is moved by hand lapses on the one day nobody remembers. The date arithmetic
 *      itself is proved in __tests__/unit/renew-security-txt.test.ts.
 *
 * Nothing in this file depends on today's date beyond validity: the file must not have expired
 * and must not claim more than a year.
 */

const REPO_ROOT = join(__dirname, '../..');
const CI = '.github/workflows/ci.yml';
const PARAMETERS = 'public/service-parameters.json';
const SECURITY_TXT = 'public/.well-known/security.txt';
const RENEW_SCRIPT = 'scripts/renew-security-txt.mjs';
const DAY = 86_400_000;

function read(rel: string): string {
  expect(existsSync(join(REPO_ROOT, rel)), `${rel} should exist`).toBe(true);
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

type Doc = Record<string, unknown>;
const isMapping = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);

describe('public/service-parameters.json', () => {
  it('publishes the Gate 2 values', () => {
    const values = JSON.parse(read(PARAMETERS)) as Doc;
    delete values.published; // a publication date may ride along; the decided values are everything else
    expect(values).toEqual({
      version: '1.0.0',
      source: 'Gate 2 decision G2-22',
      criticalPatchWindowDays: 7,
      restoreTest: 'after every backup rotation',
      syntheticJourneyInterval: 'PT1H',
      incidentNoticeToControllersHours: 48,
      logRetentionDays: 90,
      availabilityObjective: { target: 0.995, window: 'rolling 30 days' },
    });
  });

  it('dates its publication as a plain calendar date, when it carries one', () => {
    const { published } = JSON.parse(read(PARAMETERS)) as Doc;
    if (published !== undefined) {
      expect(published).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${published as string}T00:00:00Z`))).toBe(false);
    }
  });
});

/** security.txt as RFC 9116 reads it: `Field: value` lines; `#` lines are comments. */
function fields(text: string): [string, string][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map((l) => {
      const at = l.indexOf(':');
      expect(at, `a security.txt line that is neither a comment nor Field: value: ${JSON.stringify(l)}`).toBeGreaterThan(0);
      return [l.slice(0, at).trim().toLowerCase(), l.slice(at + 1).trim()];
    });
}

describe('public/.well-known/security.txt', () => {
  const text = () => read(SECURITY_TXT);
  const values = (name: string) => fields(text()).filter(([k]) => k === name).map(([, v]) => v);

  it('has a role contact and a valid Expires', () => {
    expect(values('contact'), 'one Contact, the role address on the project domain (G2-10 (b))').toEqual(['mailto:security@makrai.org']);
    expect(values('preferred-languages')).toEqual(['en']);
    expect(values('canonical')).toEqual(['https://makrai.org/.well-known/security.txt']);

    const expires = values('expires');
    expect(expires, 'RFC 9116: exactly one Expires').toHaveLength(1);
    expect(expires[0], 'an RFC 3339 date-time in UTC').toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const when = Date.parse(expires[0]);
    expect(Number.isNaN(when), 'Expires parses as a date').toBe(false);
    expect(when, 'Expires is in the future: the file is not stale').toBeGreaterThan(Date.now());
    expect(when, 'Expires is at most 365 days away: RFC 9116 asks for under a year').toBeLessThanOrEqual(Date.now() + 365 * DAY);
  });

  it('points at the service parameters', () => {
    expect(text()).toContain('# Service parameters: https://makrai.org/service-parameters.json');
  });

  it('keeps a personal address out of a public file (G2-10)', () => {
    expect(text()).not.toMatch(/@(gmail|googlemail|outlook|hotmail|yahoo)\./i);
  });

  it('is plain ASCII with no byte-order mark', () => {
    // RFC 9116 asks for UTF-8; a BOM before the first field is read by some parsers as part of its name.
    expect(text()).toMatch(/^[\x09\x0A\x0D\x20-\x7E]*$/);
  });
});

// ---------------------------------------------------------------------------
// The scheduled renewal job

const JOB = 'security-txt-renewal';

/**
 * Any expression that reads a credential: `secrets.X`, `secrets['X']`, `toJSON(secrets)`, `github.token` and
 * `github['token']`, with whatever whitespace. `GITHUB_TOKEN` is the secret's name and appears after `secrets.`,
 * so it is covered by the first alternative.
 */
const CREDENTIAL_READ = /\bsecrets\b|\bgithub\s*\.\s*token\b|\bgithub\s*\[\s*['"]token['"]\s*\]/i;

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  'continue-on-error'?: unknown;
}

function workflow() {
  const doc = loadYaml(read(CI), { filename: CI });
  expect(isMapping(doc) && isMapping(doc.jobs), `${CI} should parse to a mapping with jobs`).toBe(true);
  return doc as Doc & { jobs: Record<string, Doc>; on: Doc };
}

function renewalJob(): Doc & { steps: Step[] } {
  const job = workflow().jobs[JOB];
  expect(job, `${CI} should have a \`${JOB}\` job`).toBeDefined();
  expect(Array.isArray(job.steps), 'the job has steps').toBe(true);
  return job as Doc & { steps: Step[] };
}

describe('ci.yml says truthfully what it can write', () => {
  /** The comment block directly above the top-level `permissions:` line. */
  function permissionsComment(): string {
    const lines = read(CI).split('\n');
    const at = lines.findIndex((l) => l === 'permissions:');
    expect(at, 'ci.yml has a top-level permissions: line').toBeGreaterThan(0);
    const block: string[] = [];
    for (let i = at - 1; i >= 0 && lines[i].startsWith('#'); i -= 1) block.unshift(lines[i]);
    expect(block.length, 'a comment sits above the workflow-level permissions').toBeGreaterThan(0);
    return block.join(' ').replace(/#\s*/g, '').replace(/\s+/g, ' ');
  }

  it('does not claim the workflow never pushes or opens PRs: one job does', () => {
    const comment = permissionsComment();
    expect(comment).not.toMatch(/never pushes/i);
    expect(comment, 'names the job that holds the write grant').toContain('security-txt-renewal');
    expect(comment, 'says the default is read-only').toMatch(/read-only/);
    expect(comment, 'says the grant is that job\u2019s own, at job level').toMatch(/job-level/);
  });
});

describe('the credential matcher used below', () => {
  it.each([
    '${{ secrets.GITHUB_TOKEN }}',
    "${{ secrets['GITHUB_TOKEN'] }}",
    '${{ toJSON(secrets) }}',
    '${{ github.token }}',
    '${{ github . token }}',
    "${{ github['token'] }}",
    '${{ GITHUB.TOKEN }}',
  ])('sees a read in %s', (expr) => {
    expect(CREDENTIAL_READ.test(JSON.stringify({ env: { X: expr } }))).toBe(true);
  });

  it.each(['${{ github.ref_name }}', '${{ github.event_name }}', 'public/.well-known/security.txt', 'github-actions[bot]'])(
    'does not see one in %s',
    (text) => {
      expect(CREDENTIAL_READ.test(JSON.stringify({ env: { X: text } }))).toBe(false);
    },
  );
});

describe('a scheduled job renews Expires', () => {
  it('runs on the daily schedule only, with the two write scopes it needs and nothing else', () => {
    const doc = workflow();
    expect(Object.keys(doc.on), 'the daily schedule this rides on (Task 10) is still there').toContain('schedule');
    const job = renewalJob();
    expect(job.if).toBe("github.event_name == 'schedule'");
    expect(job.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
    expect(doc.permissions, 'the workflow default stays read-only').toEqual({ contents: 'read' });
    expect(job.needs, 'it does not wait on the verify job: a red audit must not stop the date moving').toBeUndefined();
  });

  it('has no job-level container, services, env, uses, defaults or other key that could reroute where its steps run or what they hold', () => {
    const job = renewalJob();
    // A `container:` or `services:` would run the steps (the PR step, with the token) inside an image this repository does
    // not control; a job-level `env:` would hand the token to the script step; `uses:` would make the whole job someone else's;
    // `defaults:` can change the shell every step runs under. The key set is pinned, so a new key is a decision made here.
    for (const key of ['container', 'services', 'env', 'uses', 'defaults', 'strategy', 'needs', 'outputs', 'environment', 'concurrency', 'with', 'secrets']) {
      expect(Object.keys(job), `the renewal job has no \`${key}:\``).not.toContain(key);
    }
    expect(Object.keys(job).sort()).toEqual(['if', 'name', 'permissions', 'runs-on', 'steps', 'timeout-minutes']);
    expect(job['runs-on'], 'a GitHub-hosted runner, not a label this repository or anyone else controls').toBe('ubuntu-latest');
  });

  it('runs no code but the repository default branch and a SHA-pinned actions/checkout while it holds the write token', () => {
    const { steps } = renewalJob();
    const uses = steps.flatMap((s) => (s.uses ? [s.uses] : []));
    expect(uses, 'exactly one action, and it is checkout, pinned by full SHA with a version comment').toHaveLength(1);
    expect(uses[0]).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    // Checkout would otherwise leave the token in .git/config, readable by the step that runs the script.
    expect(steps.find((s) => s.uses)?.with).toEqual({ 'persist-credentials': false });

    for (const s of steps.filter((x) => x.run)) {
      expect(s.run, `step "${s.name}" installs or fetches nothing`).not.toMatch(/\b(npm|npx|pnpm|yarn|pip|curl|wget)\b/);
      expect(s.run, `step "${s.name}" interpolates no expression into a script`).not.toContain('${{');
    }
  });

  it('runs the renewal script, then opens a PR with gh using GITHUB_TOKEN passed through env', () => {
    const { steps } = renewalJob();
    const renew = steps.findIndex((s) => s.run?.trim() === 'node scripts/renew-security-txt.mjs');
    const open = steps.findIndex((s) => /\bgh pr create\b/.test(s.run ?? ''));
    expect(renew, 'a step that runs exactly `node scripts/renew-security-txt.mjs`').toBeGreaterThan(0);
    expect(open, 'a step that runs `gh pr create`').toBeGreaterThan(renew);
    expect(existsSync(join(REPO_ROOT, RENEW_SCRIPT)), `${RENEW_SCRIPT} exists`).toBe(true);

    expect(steps[open].env).toEqual({ GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}', BASE_BRANCH: '${{ github.ref_name }}' });
    // The token reaches the one step that needs it. The script step runs repository code and gets none.
    // Every way a step can read a credential counts, wherever in the step it sits (env, with, run, if): the secrets
    // context in any spelling, the github.token expression, and the token spelled as a property of github.
    const readsCredential = (step: Step) => CREDENTIAL_READ.test(JSON.stringify(step));
    expect(steps.filter(readsCredential).map((s) => s.name)).toEqual([steps[open].name]);
    expect(steps[renew].env ?? {}).toEqual({});
  });

  it('is loud when it fails: nothing is allowed to fail quietly', () => {
    const job = renewalJob();
    expect(job['continue-on-error'], 'job').toBeUndefined();
    for (const s of job.steps) {
      expect(s['continue-on-error'], `step "${s.name}"`).toBeUndefined();
      expect(s.run ?? '', `step "${s.name}" does not swallow a failure`).not.toMatch(/\|\|\s*(true|:|exit 0)\b/);
    }
    // A failed scheduled run of this workflow is what Task 33's red-main issue watches. The job
    // is in the CI workflow on purpose, and not in a workflow of its own that nothing watches.
    expect(job['timeout-minutes'], 'a hang fails loudly too').toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// The pull-request step, run against a scratch repository and a stub `gh`

describe('the pull-request step opens a PR only when the file changed', () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  const GIT_ENV = {
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    LC_ALL: 'C',
  };

  /** `spawnSync` wants a full `ProcessEnv`; a scratch environment is deliberately small. */
  const envOf = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

  function sh(cwd: string, cmd: string, args: string[], env: Record<string, string> = {}) {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: envOf({ PATH: process.env.PATH ?? '', HOME: cwd, ...GIT_ENV, ...env }) });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  }

  /** A bare remote, a clone of it on `main`, and a `gh` that records its arguments and answers `pr list` from a file. */
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 't19-pr-'));
    scratch.push(root);
    const remote = join(root, 'remote.git');
    const clone = join(root, 'clone');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    sh(root, 'git', ['init', '--bare', '-b', 'main', remote]);
    sh(root, 'git', ['clone', remote, clone]);
    sh(clone, 'git', ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    mkdirSync(join(clone, 'public/.well-known'), { recursive: true });
    writeFileSync(join(clone, SECURITY_TXT), 'Contact: mailto:security@makrai.org\nExpires: 2026-10-20T00:00:00Z\n');
    writeFileSync(join(clone, 'unrelated.txt'), 'one\n');
    sh(clone, 'git', ['add', '.']);
    sh(clone, 'git', ['commit', '-m', 'initial']);
    sh(clone, 'git', ['push', 'origin', 'main']);
    const calls = join(root, 'gh-calls.log');
    const open = join(root, 'gh-open-pr.txt');
    writeFileSync(open, '');
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\nif [ "$1 $2" = "pr list" ]; then cat "${open}"; fi\n`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    return { root, remote, clone, bin, calls, open };
  }

  function step() {
    const s = renewalJob().steps.find((x) => /\bgh pr create\b/.test(x.run ?? ''))!;
    return s.run!;
  }

  function runStep(f: ReturnType<typeof fixture>) {
    // What GitHub runs for `run:` with the default shell on Linux.
    return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step()], {
      cwd: f.clone,
      encoding: 'utf8',
      env: envOf({ PATH: `${f.bin}:${process.env.PATH ?? ''}`, HOME: f.clone, BASE_BRANCH: 'main', ...GIT_ENV }),
    });
  }

  const calls = (f: ReturnType<typeof fixture>) => (existsSync(f.calls) ? readFileSync(f.calls, 'utf8').trim().split('\n').filter(Boolean) : []);
  const remoteBranches = (f: ReturnType<typeof fixture>) => sh(f.remote, 'git', ['branch', '--format=%(refname:short)']).split('\n').filter(Boolean).sort();

  it('with the file unchanged: no branch, no push, no gh call, exit 0', () => {
    const f = fixture();
    const r = runStep(f);
    expect(r.status, r.stderr).toBe(0);
    expect(calls(f)).toEqual([]);
    expect(remoteBranches(f)).toEqual(['main']);
    expect(sh(f.clone, 'git', ['branch', '--show-current'])).toBe('main');
  });

  it('with the file changed: pushes one commit of that file alone to a renewal branch and opens a PR against the base', () => {
    const f = fixture();
    writeFileSync(join(f.clone, SECURITY_TXT), 'Contact: mailto:security@makrai.org\nExpires: 2027-10-14T00:00:00Z\n');
    writeFileSync(join(f.clone, 'unrelated.txt'), 'two\n'); // a stray change elsewhere must not ride along
    const r = runStep(f);
    expect(r.status, r.stderr).toBe(0);

    expect(remoteBranches(f)).toEqual(['chore/renew-security-txt', 'main']);
    expect(sh(f.remote, 'git', ['rev-list', '--count', 'main..chore/renew-security-txt'])).toBe('1');
    expect(sh(f.remote, 'git', ['diff', '--name-only', 'main', 'chore/renew-security-txt'])).toBe(SECURITY_TXT);

    expect(calls(f), 'git is given the token through gh, before the push').toContain('auth setup-git --hostname github.com');
    const made = calls(f).filter((c) => c.startsWith('pr create'));
    expect(made).toHaveLength(1);
    expect(made[0]).toMatch(/--base main\b/);
    expect(made[0]).toMatch(/--head chore\/renew-security-txt\b/);
  });

  it('with a renewal PR already open: moves its branch to today and does not open a second PR', () => {
    const f = fixture();
    writeFileSync(join(f.clone, SECURITY_TXT), 'Contact: mailto:security@makrai.org\nExpires: 2027-10-14T00:00:00Z\n');
    expect(runStep(f).status).toBe(0);
    // The next day's run starts from a fresh checkout of main; `gh pr list` now reports PR 7 on the branch.
    sh(f.clone, 'git', ['switch', 'main']);
    sh(f.clone, 'git', ['branch', '-D', 'chore/renew-security-txt']);
    writeFileSync(f.open, '7\n');
    rmSync(f.calls);
    writeFileSync(join(f.clone, SECURITY_TXT), 'Contact: mailto:security@makrai.org\nExpires: 2027-10-15T00:00:00Z\n');
    const r = runStep(f);
    expect(r.status, r.stderr).toBe(0);
    expect(calls(f).filter((c) => c.startsWith('pr create'))).toEqual([]);
    expect(sh(f.remote, 'git', ['show', 'chore/renew-security-txt:' + SECURITY_TXT])).toContain('2027-10-15T00:00:00Z');
  });

  it('fails, and does not report success, when the push is refused', () => {
    const f = fixture();
    writeFileSync(join(f.clone, SECURITY_TXT), 'Contact: mailto:security@makrai.org\nExpires: 2027-10-14T00:00:00Z\n');
    sh(f.clone, 'git', ['remote', 'set-url', 'origin', join(f.root, 'does-not-exist.git')]);
    const r = runStep(f);
    expect(r.status).not.toBe(0);
    expect(calls(f).filter((c) => c.startsWith('pr create'))).toEqual([]);
  });
});
