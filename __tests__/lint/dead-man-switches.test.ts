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
 * (see "scheduled workflows" below). The two meet in one more rule: no check is used both by a
 * cron-run script and by a workflow, because then either sender keeps it green for the other.
 * Task 20b moved the hourly synthetic journey from synthetic.yml to root's crontab, where it has
 * its own check, `HC_SYNTHETIC_PING_URL`; synthetic.yml is manual-only now and pings nothing.
 *
 * The crontabs call their scripts by absolute path (`/usr/local/bin/...`), which
 * is not a path in this repository, so scripts are matched to `ops/host/` by
 * basename.
 */

const HOST_DIR = 'ops/host';
const WORKFLOWS_DIR = '.github/workflows';

/** A ping variable: `HEALTHCHECK_PING_URL` or `HC_<NAME>_PING_URL`. */
const PING_VAR = /(HEALTHCHECK|HC_[A-Z0-9_]+)_PING_URL/g;

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

/** Each script an `ops/host/crontab.*` runs, with the ping variables its code (comments aside) names. */
function cronJobs(): { crontab: string; script: string; vars: string[] }[] {
  const jobs: { crontab: string; script: string; vars: string[] }[] = [];
  for (const crontab of readdirSync(HOST_DIR).filter((f) => f.startsWith('crontab.'))) {
    for (const script of cronScripts(readFileSync(path.join(HOST_DIR, crontab), 'utf8'))) {
      const file = path.join(HOST_DIR, script);
      const vars = existsSync(file)
        ? [...new Set([...notComment(readFileSync(file, 'utf8')).matchAll(PING_VAR)].map((m) => m[0]))]
        : [];
      jobs.push({ crontab, script, vars });
    }
  }
  return jobs;
}

/** Each `secrets.HC_*` a workflow reads (comments aside), upper-cased, with the workflow files that read it. */
function workflowChecks(): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const f of readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const yaml = notComment(readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8'));
    // GitHub reads a secret's name without regard to case, so `secrets.hc_ci_audit_ping_url` is the same check.
    for (const m of yaml.matchAll(/secrets\.(HC_[A-Z0-9_]+)/gi)) {
      const name = m[1].toUpperCase();
      owners.set(name, [...(owners.get(name) ?? []), f]);
    }
  }
  return owners;
}

describe('cron-run scripts', () => {
  const crontabs = readdirSync(HOST_DIR).filter((f) => f.startsWith('crontab.'));
  const jobs = cronJobs();

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

  it("schedules the operator's jobs from crontab.operator: the nightly backup chain, the backup check and the hourly reminders", () => {
    // OPS-HOST (NFR-OBS-02): the reminder job runs at 20 past, off the synthetic journey's 7 past and the
    // ship's 5 past, and its own check (HC_REMINDER_PING_URL) is the only one the wrapper pings.
    const operator = cronLines(readFileSync(path.join(HOST_DIR, 'crontab.operator'), 'utf8'));
    expect(operator.map((l) => `${l.schedule} ${path.basename(l.command)}`)).toEqual([
      '0 0 * * * makrai-backup.sh',
      '30 0 * * * makrai-offsite-copy.sh',
      '0 1 * * * makrai-restore-test.sh',
      '0 6 * * * makrai-backup-check.sh',
      '20 * * * * makrai-reminders.sh',
    ]);
    const vars = cronJobs().find((j) => j.script === 'makrai-reminders.sh')?.vars;
    expect(vars, 'the reminder wrapper pings exactly one check').toEqual(['HC_REMINDER_PING_URL']);
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
    const owners = workflowChecks();
    // Not vacuous: the scan found the checks that exist today. The synthetic journey's is not among them: since
    // Task 20b it is the host's, and synthetic.yml pings nothing.
    expect([...owners.keys()], 'the checks the workflows ping').toEqual(
      expect.arrayContaining(['HC_CI_AUDIT_PING_URL', 'HC_IMAGESCAN_PING_URL']),
    );
    const shared = [...owners].filter(([, files]) => new Set(files).size > 1);
    expect(
      shared.map(([v, files]) => `${v} is used by ${[...new Set(files)].join(' and ')}`),
      'a shared check stays green while one of the two workflows has stopped',
    ).toEqual([]);
  });

  it("ci.yml and image-scan.yml say why their daily checks are Simple with a 36 h grace, not a cron time (Task 20b)", () => {
    // GitHub's schedule is best-effort with no bound on the delay: ci.yml's 04:23 slot has landed between
    // 09:35 and 12:09 UTC. A cron-kind check with 2 h grace alerts on every late day; Simple, period 1 day,
    // grace 36 h absorbs a late run and one dropped day, and still reports a dead schedule within the 7-day
    // critical patch window. The setting is in the healthchecks dashboard, so the workflow says what it is.
    for (const f of ['ci.yml', 'image-scan.yml']) {
      // The comment block directly above the ping step, so the explanation cannot drift away from the setting
      // it explains.
      const lines = readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8').split('\n');
      const step = lines.findIndex((l) => /^\s*- name: Ping the dead-man check\s*$/.test(l));
      expect(step, `${f} has the ping step`).toBeGreaterThan(-1);
      const block: string[] = [];
      for (let i = step - 1; i >= 0 && lines[i].trim().startsWith('#'); i--) block.unshift(lines[i].trim().replace(/^#\s?/, ''));
      const comments = block.join(' ').replace(/\s+/g, ' ');
      expect(comments, f).toContain('Simple, period 1 day, grace 36 h, not a cron time');
      expect(comments, f).toContain("GitHub's schedule is best-effort");
      expect(comments, f).toContain('the 36 h grace absorbs');
    }
  });

  describe('synthetic.yml (Task 20b)', () => {
    const FILE = path.join(WORKFLOWS_DIR, 'synthetic.yml');
    const text = (): string => {
      expect(existsSync(FILE), `${FILE} should exist`).toBe(true);
      return readFileSync(FILE, 'utf8');
    };

    it('is manual-only, so the dead-man rule above has nothing to ask of it', () => {
      // A schedule here would put a second sender beside the host's hourly run.
      expect(isScheduled(text())).toBe(false);
      const doc = loadYaml(text()) as { on: Record<string, unknown> };
      expect(Object.keys(doc.on)).toEqual(['workflow_dispatch']);
    });

    it("pings nothing: it reads no HC_ secret, and the hourly check is the host script's", () => {
      expect(text().match(/secrets\.HC_/gi) ?? [], 'a workflow secret that is a check URL').toEqual([]);
      // The check the workflow used to ping is pinged by the host job that replaced it, and only with --ping.
      const root = cronLines(readFileSync(path.join(HOST_DIR, 'crontab.root'), 'utf8'));
      expect(root.find((l) => path.basename(l.command) === 'makrai-synthetic.sh')?.rest, 'the host runs the journey with --ping').toMatch(/^--ping\b/);
      const script = notComment(readFileSync(path.join(HOST_DIR, 'makrai-synthetic.sh'), 'utf8'));
      expect([...new Set([...script.matchAll(PING_VAR)].map((m) => m[0]))]).toEqual(['HC_SYNTHETIC_PING_URL']);
    });
  });

  it('no check is used both by a cron-run script and by a workflow (Task 20b)', () => {
    // Task 20b moved the hourly synthetic journey off GitHub because GitHub's schedule is late or dropped. A check
    // with a sender on each side is the failure the move must not leave behind: the workflow's ping would keep the
    // check green while the host's job was dead, or the host's would while the schedule was dead.
    const fromScripts = new Map<string, string[]>();
    for (const { script, vars } of cronJobs()) {
      for (const v of vars.filter((v) => v.startsWith('HC_'))) fromScripts.set(v, [...(fromScripts.get(v) ?? []), script]);
    }
    const fromWorkflows = workflowChecks();
    // Not vacuous: both scans found the checks that exist today, each on its own side of the line.
    expect([...fromScripts.keys()], 'the checks the cron-run scripts ping').toEqual(
      expect.arrayContaining(['HC_AUDITSHIP_PING_URL', 'HC_SYNTHETIC_PING_URL']),
    );
    expect([...fromWorkflows.keys()], 'the checks the workflows ping').toEqual(
      expect.arrayContaining(['HC_CI_AUDIT_PING_URL', 'HC_IMAGESCAN_PING_URL']),
    );
    const both = [...fromScripts].filter(([v]) => fromWorkflows.has(v));
    expect(
      both.map(([v, scripts]) => `${v} is used by ${[...new Set(scripts)].join(' and ')} and by ${[...new Set(fromWorkflows.get(v))].join(' and ')}`),
      'a check with a sender on each side stays green while one of them is dead',
    ).toEqual([]);
  });
});
