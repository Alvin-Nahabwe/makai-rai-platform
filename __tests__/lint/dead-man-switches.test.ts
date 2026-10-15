import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';

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
 * Workflows follow the same rule: one `secrets.HC_*_PING_URL` per scheduled workflow, none shared
 * (see "scheduled workflows" below). Task 20 added the hourly synthetic journey, synthetic.yml, and
 * its check, `HC_SYNTHETIC_PING_URL`.
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

/** Each active line of a crontab: its schedule, the command it runs, and the rest of the line. */
function cronLines(crontab: string): { schedule: string; command: string; rest: string }[] {
  const out: { schedule: string; command: string; rest: string }[] = [];
  for (const raw of crontab.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) continue; // MAILTO="" and friends
    const fields = line.split(/\s+/);
    const at = line.startsWith('@') ? 1 : 5;
    if (fields[at]) out.push({ schedule: fields.slice(0, at).join(' '), command: fields[at], rest: fields.slice(at + 1).join(' ') });
  }
  return out;
}

/** The script basename each active line of a crontab runs. */
function cronScripts(crontab: string): string[] {
  return cronLines(crontab).map((l) => path.basename(l.command));
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

  it("schedules root's jobs from crontab.root: the hourly ship and synthetic journey, the nightly reconcile and the email scan", () => {
    // Task 22 (RL 7.13). Root runs the first, third and fourth because they read the whole journal and
    // /etc/makrai. Task 20b: root runs the synthetic journey because GitHub's `schedule` is hours late or
    // dropped, and the published commitment is hourly ("syntheticJourneyInterval": "PT1H").
    expect(crontabs, 'no ops/host/crontab.root').toContain('crontab.root');
    const root = cronLines(readFileSync(path.join(HOST_DIR, 'crontab.root'), 'utf8'));
    expect(root.map((l) => `${l.schedule} ${path.basename(l.command)}`)).toEqual([
      '5 * * * * makrai-auditlog-ship.sh',
      '7 * * * * makrai-synthetic.sh',
      '0 2 * * * makrai-auditlog-reconcile.sh',
      '30 2 * * * makrai-email-scan.sh',
    ]);
    expect(root.find((l) => l.command.endsWith('makrai-email-scan.sh'))?.rest).toMatch(/^--since -26h --ping\b/);
    // Only a cron run pings; a run by hand says nothing about whether the schedule is alive.
    expect(root.find((l) => l.command.endsWith('makrai-synthetic.sh'))?.rest).toMatch(/^--ping\b/);
  });

  it("calls every script by absolute path, because cron's own PATH has no /usr/local/sbin", () => {
    // F-23. cron runs jobs with PATH=/usr/bin:/bin, so a bare `makrai-email-scan.sh` is
    // "command not found", which cron reports only by mail, which nobody reads (F-15).
    const relative: string[] = [];
    for (const crontab of crontabs) {
      for (const l of cronLines(readFileSync(path.join(HOST_DIR, crontab), 'utf8'))) {
        if (!/^\/usr\/local\/s?bin\/[\w.-]+$/.test(l.command)) relative.push(`${crontab}: ${l.command}`);
      }
    }
    expect(relative).toEqual([]);
  });

  it('keeps each root job\'s output in a log of its own in /var/log/makrai, since cron mail is not read', () => {
    // F-15: root's mail delivery is unverified, so a counts line that went to cron's mail
    // would be lost. Each job appends both streams to its own log; the reconcile's and the
    // email scan's end in their counts line, which Task 25 reads with tail -n1, and the synthetic
    // journey's ends in its `result=` line.
    const text = readFileSync(path.join(HOST_DIR, 'crontab.root'), 'utf8');
    expect(text.split('\n')).toContain('MAILTO=""');
    const logs = cronLines(text).map((l) => [path.basename(l.command), / >> (\/var\/log\/makrai\/[\w.-]+\.log) 2>&1$/.exec(` ${l.rest}`)?.[1]]);
    expect(logs).toEqual([
      ['makrai-auditlog-ship.sh', '/var/log/makrai/auditlog-ship.log'],
      ['makrai-synthetic.sh', '/var/log/makrai/synthetic.log'],
      ['makrai-auditlog-reconcile.sh', '/var/log/makrai/auditlog-reconcile.log'],
      ['makrai-email-scan.sh', '/var/log/makrai/email-scan.log'],
    ]);
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

  it('no two workflows share a check', () => {
    const owners = new Map<string, string[]>();
    for (const f of readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
      const yaml = notComment(readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8'));
      // GitHub reads a secret's name without regard to case, so `secrets.hc_ci_audit_ping_url` is the same check.
      for (const m of yaml.matchAll(/secrets\.(HC_[A-Z_]+)/gi)) {
        const name = m[1].toUpperCase();
        owners.set(name, [...(owners.get(name) ?? []), f]);
      }
    }
    // Not vacuous: the scan found the checks that exist today, the synthetic journey's among them.
    expect([...owners.keys()], 'the checks the workflows ping').toEqual(
      expect.arrayContaining(['HC_CI_AUDIT_PING_URL', 'HC_IMAGESCAN_PING_URL', 'HC_SYNTHETIC_PING_URL']),
    );
    const shared = [...owners].filter(([, files]) => new Set(files).size > 1);
    expect(
      shared.map(([v, files]) => `${v} is used by ${[...new Set(files)].join(' and ')}`),
      'a shared check stays green while one of the two workflows has stopped',
    ).toEqual([]);
  });

  describe('synthetic.yml (Task 20)', () => {
    const FILE = path.join(WORKFLOWS_DIR, 'synthetic.yml');
    type Step = { name?: string; if?: string; run?: string; env?: Record<string, string> };
    const steps = (): Step[] => {
      expect(existsSync(FILE), `${FILE} should exist`).toBe(true);
      const doc = loadYaml(readFileSync(FILE, 'utf8')) as { jobs: Record<string, { steps: Step[] }> };
      return Object.values(doc.jobs).flatMap((j) => j.steps);
    };

    it('is scheduled, so the dead-man rule above applies to it', () => {
      expect(isScheduled(readFileSync(FILE, 'utf8'))).toBe(true);
    });

    it('reports to its own check from one step, last in the job, on scheduled runs only', () => {
      const all = steps();
      const journey = all.findIndex((s) => /\bnode scripts\/synthetic-journey\.mjs\b/.test(s.run ?? ''));
      expect(journey, 'a step runs scripts/synthetic-journey.mjs').toBeGreaterThanOrEqual(0);

      // One step holds the check's URL. Two steps (success() and failure()) would send /fail after a success
      // ping that failed, because failure() is true once any earlier step has failed.
      const pings = all.filter((s) => /secrets\.hc_synthetic_ping_url/i.test(JSON.stringify(s.env ?? {})));
      expect(pings, 'exactly one step reports to HC_SYNTHETIC_PING_URL').toHaveLength(1);
      const ping = pings[0];
      expect(all.at(-1), 'the ping is the last step, so job.status covers every step before it').toBe(ping);
      expect(all.indexOf(ping)).toBeGreaterThan(journey);

      // Scheduled runs only: a manual run says nothing about whether the schedule is alive. always() so it also
      // runs after a failed or cancelled step.
      expect(ping.if).toBe("always() && github.event_name == 'schedule'");

      // The URL is the check's secret: it reaches the script as an environment variable, never in the script text.
      expect(ping.env).toEqual({ HC_URL: '${{ secrets.HC_SYNTHETIC_PING_URL }}', JOB_STATUS: '${{ job.status }}' });
      expect(ping.run).toContain('"$HC_URL"');
      expect(ping.run).toContain('"$HC_URL/fail"');
      expect(ping.run).toMatch(/curl -fsS -m 10 --retry 3 -o \/dev\/null "\$url"/);
    });
  });
});
