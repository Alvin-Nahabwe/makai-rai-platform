import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Every scheduled job reports to a dead-man check of its own.
 *
 * A job that fails loudly is the easy case. The failure that goes unseen is the
 * job that stops running: a deleted crontab line, a full disk, a workflow
 * GitHub quietly disables after 60 days without a push. All of those produce
 * nothing, and nothing looks exactly like healthy. A dead-man check inverts it:
 * the job pings a URL on success and the service alarms on the absence of a ping.
 *
 * It only works if each job has its own. Two jobs sharing one URL cover for each
 * other: the one that still runs keeps the check green while the other is dead.
 * So the rule here is one ping variable per cron-run script, and no variable used
 * by two scripts.
 *
 * The crontabs call their scripts by absolute path (`/usr/local/bin/...`), which
 * is not a path in this repository, so scripts are matched to `ops/host/` by
 * basename.
 */

const HOST_DIR = 'ops/host';
const WORKFLOWS_DIR = '.github/workflows';

/** A ping variable: `HEALTHCHECK_PING_URL` or `HC_<NAME>_PING_URL`. */
const PING_VAR = /(HEALTHCHECK|HC_[A-Z]+)_PING_URL/g;

/**
 * Scripts that run from cron and deliberately have no check of their own, each
 * with its reason. Adding an entry is a decision to review, not a default.
 */
const NO_DEADMAN: Record<string, string> = {
  'makrai-backup-check.sh': 'checks the backup, whose own check alerts on absence',
};

const notComment = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

/** The script basename each active line of a crontab runs. */
function cronScripts(crontab: string): string[] {
  const out: string[] = [];
  for (const raw of crontab.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) continue; // MAILTO="" and friends
    const fields = line.split(/\s+/);
    const command = line.startsWith('@') ? fields[1] : fields[5];
    if (command) out.push(path.basename(command));
  }
  return out;
}

/** True when a workflow has an active (not commented) `schedule:` trigger. */
function isScheduled(yaml: string): boolean {
  return /^\s*schedule:\s*$/m.test(notComment(yaml));
}

describe('cron-run scripts', () => {
  const crontabs = readdirSync(HOST_DIR).filter((f) => f.startsWith('crontab.'));

  const jobs: { crontab: string; script: string; vars: string[] }[] = [];
  for (const crontab of crontabs) {
    for (const script of cronScripts(readFileSync(path.join(HOST_DIR, crontab), 'utf8'))) {
      const file = path.join(HOST_DIR, script);
      const vars = existsSync(file)
        ? [...new Set([...notComment(readFileSync(file, 'utf8')).matchAll(PING_VAR)].map((m) => m[0]))]
        : [];
      jobs.push({ crontab, script, vars });
    }
  }

  it('finds the crontab and the jobs in it, so a parser failure cannot pass vacuously', () => {
    expect(crontabs.length, `no ${HOST_DIR}/crontab.* found`).toBeGreaterThan(0);
    expect(jobs.length, 'no cron-run script found in the crontab').toBeGreaterThanOrEqual(4);
    const names = jobs.map((j) => j.script);
    for (const expected of ['makrai-backup.sh', 'makrai-offsite-copy.sh', 'makrai-restore-test.sh']) {
      expect(names, `${expected} is not scheduled`).toContain(expected);
    }
  });

  it('each cron-run script is tracked in ops/host', () => {
    const untracked = jobs.filter((j) => !existsSync(path.join(HOST_DIR, j.script)));
    expect(
      untracked.map((j) => `${j.crontab} runs ${j.script}`),
      'the crontab runs a script that is not in ops/host/, so the repository cannot say what runs',
    ).toEqual([]);
  });

  it('each cron-run script pings its own check', () => {
    const wrong: string[] = [];
    for (const { script, vars } of jobs) {
      if (script in NO_DEADMAN) continue;
      if (vars.length !== 1) {
        wrong.push(`${script} uses ${vars.length} ping variables (${vars.join(', ') || 'none'}); it needs exactly one`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('no two scripts share a check', () => {
    const owners = new Map<string, string[]>();
    for (const { script, vars } of jobs) {
      for (const v of vars) owners.set(v, [...(owners.get(v) ?? []), script]);
    }
    const shared = [...owners].filter(([, scripts]) => new Set(scripts).size > 1);
    expect(
      shared.map(([v, s]) => `${v} is used by ${[...new Set(s)].join(' and ')}`),
      'a shared check stays green while one of the two jobs is dead',
    ).toEqual([]);
  });

  it('every exemption names a script that is scheduled and says why', () => {
    for (const [script, reason] of Object.entries(NO_DEADMAN)) {
      expect(jobs.map((j) => j.script), `${script} is exempt but not scheduled: remove the exemption`).toContain(script);
      expect(reason.length, `${script} needs a reason`).toBeGreaterThan(10);
    }
  });
});

describe('scheduled workflows', () => {
  it('recognises a schedule trigger and ignores a comment about one', () => {
    expect(isScheduled('on:\n  push:\n  schedule:\n    - cron: "1 2 * * *"\n')).toBe(true);
    expect(isScheduled('on:\n  push:\n# schedule:\n  # schedule:\n')).toBe(false);
  });

  it('every scheduled workflow pings a dead-man check', () => {
    const files = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length, `no workflow found in ${WORKFLOWS_DIR}`).toBeGreaterThan(0);
    const silent = files.filter((f) => {
      const yaml = readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8');
      return isScheduled(yaml) && !/secrets\.HC_/.test(notComment(yaml));
    });
    // No exemption: a schedule GitHub stops firing is reported only by an absent ping.
    expect(silent, `scheduled workflows with no \`secrets.HC_*\` ping: ${silent.join(', ')}`).toEqual([]);
  });
});
