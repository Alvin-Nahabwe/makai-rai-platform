import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The v0.6.0 operating text (unit RB): `docs/runbooks/deployment.md` 8.5 (the owner's steps),
 * 9.5 (when to roll back), 12.2 (no agent connects to the production host), 12.6 (erasure on a
 * controller's written instruction), the one rule added to `ops/host/README.md`, and the ten ADRs
 * of the specification's section 9.7.
 *
 * Every test reads the text a person will copy, so a property cannot be edited away without a
 * red test. The two helpers `unset_env` and the synthetic-journey pause are also RUN here, on
 * scratch copies, because a runbook line that was never executed is a claim, not a check. What no
 * test here can prove is the order of events on the real host: V-prog rehearses steps 5 to 13 and
 * 9.5 on a local copy with the release images, and the owner runs the real thing.
 */

const DEPLOYMENT = 'docs/runbooks/deployment.md';
const HOST_README = 'ops/host/README.md';

const md = (): string => readFileSync(DEPLOYMENT, 'utf8');
const flat = (t: string): string => t.replace(/\s+/g, ' ');

/** From the heading line that starts with `heading` to the next `##` or `###` heading. */
function section(heading: string): string {
  const lines = md().split('\n');
  const at = lines.findIndex((l) => l.startsWith(heading));
  expect(at, `${DEPLOYMENT} should have a heading starting ${JSON.stringify(heading)}`).toBeGreaterThan(-1);
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^#{2,3} /.test(l));
  return [lines[at], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

/** Lines inside ``` fences: what a reader copies and runs. */
function fenced(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) out.push(line);
  }
  return out;
}

const s85 = (): string => section('### 8.5');
const s95 = (): string => section('### 9.5');

/** The text between a `## 8.` heading and `### 8.1`: the rules and the once-per-session block. */
const sessionBlock = (): string => {
  const all = md();
  const from = all.indexOf('Set these once per session:');
  expect(from, 'the "Set these once per session" block should exist').toBeGreaterThan(-1);
  return all.slice(from, all.indexOf('### 8.1', from));
};

describe('deployment.md 8.5: the owner steps of the v0.6.0 deploy', () => {
  it("NFR-SEC-17: 8.5 lists the owner steps of SRS 13.8 in order, each marked as the owner's", () => {
    const ids = ['1.', '2.', '3.', '4.', '4a.', '4b.', '4c.', '4d.', '4f.', '5.', '6.', '7.', '8.', '9.', '10.', '11.', '11a.', '12.', '13.', '14.'];
    const at = ids.map((id) => s85().search(new RegExp(`^\\*\\*Step ${id.replace('.', '\\.')}\\*\\*`, 'm')));
    expect(at.every((i) => i > -1), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(flat(s85())).toContain("Every step here is the owner's, in the owner's own session (12.1), in a terminal outside any AI session");
  });

  it('NFR-SEC-14: each new secret is made on the host and checked by a count, never printed', () => {
    const code = fenced(s85()).map((l) => l.trim());
    const tokenLine = `( umask 077; printf 'REMINDER_JOB_TOKEN=%s\\n' "$(openssl rand -hex 32)" >> /srv/makrai/app/.env )`;
    const readLine = `read -rs -p 'HC_REMINDER_PING_URL: ' V && echo && ( umask 077; printf 'HC_REMINDER_PING_URL=%s\\n' "$V" >> /srv/makrai/app/.env ); unset V`;
    const newlineGuard = `[ "$(tail -c1 /srv/makrai/app/.env | wc -l)" = 1 ] || echo >> /srv/makrai/app/.env`;
    expect(code).toContain(tokenLine);
    expect(code).toContain(`grep -c '^REMINDER_JOB_TOKEN=[0-9a-f]\\{64\\}$' /srv/makrai/app/.env`);
    expect(code).toContain(readLine);
    expect(code).toContain(`grep -cE '^HC_REMINDER_PING_URL=https://hc-ping\\.com/[0-9a-f-]{36}$' /srv/makrai/app/.env`);
    // The one line that holds a pasted value is the read line, exactly; no other line may print or use $V.
    expect(code.filter((l) => /\$\{?V\b/.test(l))).toEqual([readLine]);
    const exempt = new Set([tokenLine, readLine, newlineGuard]);
    const printsValue = code.filter((l) => /\b(echo|cat|printf)\b.*\$\{?(V|REMINDER_JOB_TOKEN|HC_REMINDER_PING_URL)\b/.test(l) && !exempt.has(l));
    expect(printsValue).toEqual([]);
    expect(code.filter((l) => /grep\s+(?!-c)[^|]*(REMINDER_JOB_TOKEN|HC_REMINDER_PING_URL)/.test(l))).toEqual([]);
    // Every fenced line of 8.5 that names the server .env is one of these forms, so a new line that
    // prints the file (a tail, a cat, a sed that prints) cannot be added without this list changing.
    const forms: RegExp[] = [
      /^grep -cE? '[^']*' (\.\.\/\.env|\/srv\/makrai\/app\/\.env)$/,
      /^SLUG=\$\(sed -n 's\/\^SYNTHETIC_ORG_SLUG=\/\/p' \.\.\/\.env\)$/,
    ];
    const naming = code.filter((l) => l.includes('.env') && !exempt.has(l));
    expect(naming.filter((l) => !forms.some((f) => f.test(l)))).toEqual([]);
    // The order: the newline guard before the token is appended; a hidden read after a clean slate. The token
    // is made under umask 077 inside a subshell, so no bare `umask 077` is left standing in the owner's shell.
    expect(code.indexOf(newlineGuard)).toBeGreaterThan(-1);
    expect(code.indexOf(tokenLine)).toBeGreaterThan(code.indexOf(newlineGuard)); // 64 lowercase hex under umask 077 (contract route 40 row)
    expect(code.filter((l) => /^umask\b/.test(l)), 'no bare umask persists in the owner shell').toEqual([]);
    expect(code.indexOf(readLine)).toBeGreaterThan(code.indexOf('unset_env HC_REMINDER_PING_URL'));
    expect(code.indexOf('unset_env HC_REMINDER_PING_URL')).toBeGreaterThan(-1);
  });

  it('NFR-SEC-14 NFR-PRIV-05: the owner role name and the synthetic slug are read into variables and never printed', () => {
    // Step 2 reads two values from the server .env to build a count; neither reaches the terminal.
    // The role name is not a secret, but the rule for the runbook is the same one it keeps for a
    // password: a value is read into a variable and used, not echoed.
    const code = [...fenced(s85()), ...fenced(sessionBlock())].map((l) => l.trim());
    expect(code).toContain(`PGU=$(sed -n 's/^POSTGRES_USER=//p' ../.env)`);
    const echoes = code.filter((l) => /\b(echo|cat|printf)\b[^|;&]*\$\{?(PGU|SLUG)\b/.test(l));
    expect(echoes).toEqual([]);
    // Step 2 prints three numbers: a count of each of projects, assessments and evidence, and no row.
    const step2Text = s85().split(/^\*\*Step 3\.\*\*/m)[0].split(/^\*\*Step 2\.\*\*/m)[1];
    expect(step2Text, 'step 2 is in 8.5').toBeDefined();
    const step2 = fenced(step2Text).join(' ');
    for (const t of ['projects', 'assessments', 'evidence']) expect(step2, t).toContain(`from ${t} `);
    expect((step2.match(/\bselect\b/gi) ?? []).length, 'one outer select, three counts, and the administrator count').toBe(5);
    expect((step2.match(/count\(\*\)/g) ?? []).length).toBe(4);
    expect(step2, 'the administrator count').toContain("select count(*) from users where role = 'admin';");
    expect(step2, 'an SQL error stops psql and leaves a non-zero status').toContain('-v ON_ERROR_STOP=1');
    expect(flat(step2Text), 'anything but the expected lines is a stop').toContain('Anything else is a stop, as a count above zero is');
    expect(step2).not.toMatch(/select\s+\*/i);
    expect(step2).not.toMatch(/\b(name|email|filename|description)\b/i);
  });

  it('NFR-SEC-14: 8.5 step 8 removes the two retired settings and checks they are gone', () => {
    const code = fenced(s85()).map((l) => l.trim());
    expect(code).toContain('unset_env ALLOW_OPEN_REGISTRATION');
    expect(code).toContain('unset_env ORG_LIMIT_PER_USER');
    expect(code).toContain(`grep -cE '^(ALLOW_OPEN_REGISTRATION|ORG_LIMIT_PER_USER)=' ../.env`);
  });

  it('FR-ORG-04 NFR-REL-07: the failed-migration recovery stays on v0.5.0 and resolves only the owner-check migration', () => {
    const t = flat(s85());
    expect(t).toContain('$C --profile tools run --rm --no-deps migrator npx prisma migrate resolve --rolled-back 20261030000000_v060_00_owner_check');
    const anchor = t.indexOf('If the migrator stops on the owner check');
    expect(anchor, 'the recovery paragraph starts with its anchor sentence').toBeGreaterThan(-1);
    expect(t.indexOf('migrate resolve')).toBeGreaterThan(anchor);
    // The name in the command is the first v0.6.0 migration the repository holds, so a rename fails here.
    expect(readdirSync('prisma/migrations').filter((d) => /_v060_/.test(d)).sort()[0]).toBe('20261030000000_v060_00_owner_check');
    expect(t).toMatch(/Do not run 8\.3 step 5/);
    expect(t.match(/migrate resolve --rolled-back/g)).toHaveLength(1);
    // Both aborts of the first file are the owner check: the organisation one and the administrator count.
    const recovery = t.slice(anchor);
    expect(recovery).toContain('N accounts hold the platform role admin');
    expect(recovery).toContain('has no owner once the platform administrator');
    // The give-up branch returns the checkout and .env to PREV with 9.2's first three commands, and checks 8.4's SAME.
    const giveUp = recovery.slice(recovery.indexOf('If the correction cannot be made in this window'));
    expect(giveUp, 'the give-up branch exists').toContain('If the correction cannot be made in this window');
    expect(giveUp).toContain('the first three commands of 9.2');
    for (const c of ['checkout --detach', 'set_env WEB_IMAGE', 'set_env MIGRATOR_IMAGE']) expect(giveUp, c).toContain(c);
    expect(giveUp).toContain('must print SAME');
    expect(giveUp, 'on the later evening the failed row is resolved before 8.3 step 4').toContain('after 8.3 step 3 and before 8.3 step 4');
    // A promotion, never a deletion or a hand edit.
    expect(recovery).toContain('Never delete its project or edit rows by hand');
    // Any other migrator error: no resolve of another file, 9.2's first three commands, then 9.3 with BACKUP.
    const other = recovery.slice(recovery.indexOf('is not the owner check is not covered'));
    expect(other).toContain('Never resolve a file other than the owner check');
    expect(other).toContain('the first three commands of 9.2');
    expect(other).toContain('9.3 with BACKUP');
  });

  it('NFR-AVL-02: step 7 times the container swap', () => {
    expect(fenced(s85()).map((l) => l.trim())).toContain('time $C up -d --no-deps --wait --wait-timeout 120 nextjs');
  });

  it('NFR-MNT-02: step 4f tags only a candidate whose CI jobs finished within their limits', () => {
    expect(flat(s85())).toContain('the `verify` job within 15 minutes and the `test-e2e` job within 30 minutes');
  });

  it('NFR-REL-07: the v0.6.0 rollback page states the rule before and after the first real v1 record', () => {
    const t = flat(s95());
    expect(t).toContain('Before the first real v1 record');
    expect(t).toContain('After the first real v1 record: fix forward with v0.6.x');
    expect(t).toContain('cannot create or save assessments, accept invitations or delete an account');
    expect(fenced(s95()).map((l) => l.trim())).toContain(
      `$C exec -T postgres psql -U "$PGU" -d makrai -Atc 'select makrai_clear_consent_ip_addresses()'`,
    );
    expect(t).toMatch(/9\.2/);
    expect(t).toMatch(/9\.3/);
    // What makes a record real: the organisation, not a guess.
    expect(t).toContain('A real v1 record is any record in an organisation other than the synthetic one; the hourly journey and the step 13 smoke test are in the synthetic organisation');
    // After step 11 nothing is paused any more: both paths say to pause the journey again, with step 6's lines.
    const again = 'pause (it|the journey) again with the lines of 8\\.5 step 6 \\(they save the current crontab, because step 11 removed the saved copy\\) and pause the `makrai-synthetic` check';
    expect(t.match(new RegExp(again, 'g')), 'both the application rollback and the restore say it').toHaveLength(2);
    expect(t).not.toMatch(/leave both paused/);
  });
});

describe('deployment.md 8.5: the lines that change the host are the lines that were run here', () => {
  /** Runs a bash script in a scratch directory and asserts it exited 0; the output is never matched, only shown on failure. */
  function bash(script: string, cwd: string): void {
    const vars: Record<string, string> = { PATH: process.env.PATH ?? '', NO_COLOR: '1' };
    const env = vars as NodeJS.ProcessEnv; // Next's types make NODE_ENV required
    const r = spawnSync('bash', ['-c', script], { cwd, env, encoding: 'utf8' });
    expect(r.status, `${r.stderr}${r.error ?? ''}`).toBe(0);
  }

  it('FR-OPS-03 NFR-SEC-14: unset_env removes exactly the named key, nothing else, and keeps the file mode', () => {
    const fn = /^unset_env\(\) \{[\s\S]*?\}\s*$/m.exec(sessionBlock());
    expect(fn, 'the once-per-session block should define unset_env').not.toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'unset-env-'));
    try {
      const envFile = join(dir, '.env');
      writeFileSync(
        envFile,
        [
          'POSTGRES_USER=makrai',
          'ALLOW_OPEN_REGISTRATION=true',
          'ALLOW_OPEN_REGISTRATION_EXTRA=keep',
          '# ALLOW_OPEN_REGISTRATION=kept comment',
          'ORG_LIMIT_PER_USER=5',
          'NEXTAUTH_SECRET=a=b=c',
          '',
        ].join('\n'),
      );
      chmodSync(envFile, 0o640);
      // The function names /srv/makrai/app/.env; the scratch copy stands in for it.
      const body = fn![0].split('/srv/makrai/app/.env').join(envFile);
      bash(`${body}\nunset_env ALLOW_OPEN_REGISTRATION && unset_env ORG_LIMIT_PER_USER && unset_env NOT_THERE`, dir);
      expect(readFileSync(envFile, 'utf8')).toBe(
        ['POSTGRES_USER=makrai', 'ALLOW_OPEN_REGISTRATION_EXTRA=keep', '# ALLOW_OPEN_REGISTRATION=kept comment', 'NEXTAUTH_SECRET=a=b=c', ''].join('\n'),
      );
      expect(statSync(envFile).mode & 0o777).toBe(0o640);
      expect(readdirSync(dir).sort(), 'no .env.new is left behind').toEqual(['.env']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FR-OPS-01 NFR-AVL-03: the pause comments out exactly the synthetic journey's cron line, saves and restores only a non-empty crontab, and step 11 restores the saved crontab", () => {
    const code = fenced(s85()).map((l) => l.trim());
    const saved = '/root/makrai-stage/crontab.root.v060-pause';
    const paused = '/root/makrai-stage/crontab.root.v060-paused';
    const check = "crontab -l | grep -c '^#v060-pause '";
    const saveLine = `test -s ${saved} || { crontab -l > ${saved}.tmp && mv ${saved}.tmp ${saved}; }`;
    const restoreLine = `[ -s ${saved} ] && crontab ${saved}`;
    const pause = code.find((l) => l.startsWith('sed ') && l.includes('#v060-pause'));
    expect(pause, 'step 6 should pause the journey with a sed over the saved crontab').toBeDefined();
    // Step 6 saves root's crontab atomically and only when no non-empty copy exists, writes the paused crontab to a
    // file, and installs that file only when it holds exactly one commented line: an empty sed result never reaches `crontab`.
    expect(code).toContain(saveLine);
    expect(pause).toMatch(new RegExp(`${saved} > ${paused}$`));
    expect(code).toContain(`[ "$(grep -c '^#v060-pause ' ${paused})" = 1 ] && crontab ${paused}`);
    expect(code.filter((l) => /\| crontab -\s*$/.test(l)), 'no pipeline into `crontab -`').toEqual([]);
    expect(code).toContain(check);
    // Every line that installs the saved crontab runs only if the saved file is not empty, and a removal follows only a restore.
    const installs = code.filter((l) => new RegExp(`(^|&& |; )crontab ${saved}( |$)`).test(l));
    expect(installs.length, 'step 7 and step 11 restore the saved crontab').toBeGreaterThanOrEqual(2);
    expect(installs.filter((l) => !l.startsWith(`[ -s ${saved} ] && crontab ${saved}`))).toEqual([]);
    expect(code.filter((l) => l.includes(`rm -f ${saved}`) && l.includes(`crontab ${saved}`) && !l.includes(`crontab ${saved} && rm -f`))).toEqual([]);
    // Step 11 restores the exact saved crontab before the install chain, and removes both files after it.
    const step11 = fenced(s85().split(/^\*\*Step 11\.\*\*/m)[1].split(/^\*\*Step 11a\./m)[0]).map((l) => l.trim());
    expect(step11.indexOf(restoreLine), 'step 11 restores the saved crontab').toBeGreaterThan(-1);
    expect(step11.indexOf(`rm -f ${saved}`), 'step 11 removes the saved copy after the restore').toBeGreaterThan(step11.indexOf(restoreLine));
    expect(step11).toContain(`rm -f ${paused}`);
    expect(flat(s85())).toContain('Run the restore and the install chain together, outside the minutes :05 to :12');
    expect(flat(s85())).toContain('If the install or the hand run fails, pause the journey again with the lines of step 6 (the saved copy is still there), leave the check paused, and write down that it is paused');
    // The crontab line v0.5.0 shipped (step 6 runs on the previous release's live crontab, not on this release's file);
    // the sed must change that one line and no other.
    const v050 = [
      'MAILTO=""',
      '5 * * * * /usr/local/sbin/makrai-auditlog-ship.sh >> /var/log/makrai/auditlog-ship.log 2>&1',
      '7 * * * * /usr/local/sbin/makrai-synthetic.sh --ping >> /var/log/makrai/synthetic.log 2>&1',
      '0 2 * * * /usr/local/sbin/makrai-auditlog-reconcile.sh >> /var/log/makrai/auditlog-reconcile.log 2>&1',
      '30 2 * * * /usr/local/sbin/makrai-email-scan.sh --since -26h --ping >> /var/log/makrai/email-scan.log 2>&1',
      '',
    ].join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'pause-'));
    const inDir = (l: string): string => l.split('/root/makrai-stage').join(dir);
    try {
      writeFileSync(join(dir, 'crontab.root.v060-pause'), v050);
      bash(inDir(pause!), dir);
      const before = v050.split('\n');
      const after = readFileSync(join(dir, 'crontab.root.v060-paused'), 'utf8').split('\n');
      expect(after).toHaveLength(before.length);
      const changed = before.map((l, i) => [l, after[i]]).filter(([a, b]) => a !== b);
      expect(changed).toHaveLength(1);
      expect(changed[0][0]).toMatch(/^7 \* \* \* \* \/usr\/local\/sbin\/makrai-synthetic\.sh --ping /);
      expect(changed[0][1]).toBe(`#v060-pause ${changed[0][0]}`);
      expect(after.filter((l) => l.startsWith('#v060-pause '))).toHaveLength(1);
      // The save line, run with a crontab that works: the saved file equals the live crontab and no temporary file is left.
      rmSync(join(dir, 'crontab.root.v060-pause'));
      writeFileSync(join(dir, 'live.cron'), v050);
      bash(`crontab() { cat live.cron; }\n${inDir(saveLine)}`, dir);
      expect(readFileSync(join(dir, 'crontab.root.v060-pause'), 'utf8')).toBe(v050);
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
      // The save line, run with a `crontab -l` that fails: no saved file is left to be restored from later.
      rmSync(join(dir, 'crontab.root.v060-pause'));
      const failing = spawnSync('bash', ['-c', `crontab() { return 1; }\n${inDir(saveLine)}`], { cwd: dir });
      expect(failing.error).toBeUndefined();
      expect(failing.status, 'a failed save reports failure').toBe(1);
      expect(readdirSync(dir).filter((f) => f === 'crontab.root.v060-pause'), 'no saved file after a failed save').toEqual([]);
      // And when the saved file is empty or missing, the guarded restore installs nothing.
      writeFileSync(join(dir, 'crontab.root.v060-pause'), '');
      const restoreRun = spawnSync('bash', ['-c', `crontab() { echo INSTALLED > installed; }\n${inDir(restoreLine)}`], { cwd: dir });
      expect(restoreRun.error).toBeUndefined();
      expect(restoreRun.status, 'the restore guard refuses an empty saved file').toBe(1);
      expect(readdirSync(dir).includes('installed'), 'nothing was installed').toBe(false);
      // Nor does the install guard accept an empty paused crontab.
      rmSync(join(dir, 'crontab.root.v060-pause'));
      rmSync(join(dir, 'crontab.root.v060-paused'));
      const guard = spawnSync('bash', ['-c', `${inDir(pause!)}; [ "$(grep -c '^#v060-pause ' ${join(dir, 'crontab.root.v060-paused')})" = 1 ]`], { cwd: dir });
      expect(guard.error).toBeUndefined();
      expect(guard.status, 'the install guard refuses an empty paused crontab').toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('deployment.md 12.2 and ops/host/README.md: no agent connects to the production host', () => {
  it('NFR-SEC-17 NFR-PRIV-05: no runbook step lets an agent connect to the production host', () => {
    const all = md();
    expect(all).not.toContain('makrai-window.sock');
    expect(all).not.toMatch(/ControlMaster=yes/);
    expect(flat(all)).not.toMatch(/An (AI )?agent reaches the server/);
    expect(flat(all)).not.toMatch(/the agent can run it in a window/);
    const s122 = flat(section('### 12.2'));
    expect(s122).toContain('No agent connects to the production host, from v0.6.0 on (NFR-SEC-17)');
    expect(s122).toContain('the owner runs the access baseline below in their own session');
    for (const v of ['MAKRAI_TEST_SEAMS', 'MAKRAI_CONTENT_ROOT', 'MAKRAI_TEST_IDLE_SECONDS']) expect(all).not.toContain(v);
    const rules = readFileSync(HOST_README, 'utf8').split('\n## Rules\n')[1];
    expect(flat(rules)).toContain('From v0.6.0 no agent connects to the host (deployment.md 12.2, NFR-SEC-17)');
    // The owner states only their own decision; not a number, and not whether a count is zero.
    expect(flat(all)).toContain('The owner runs the count outside any AI session and tells the release team only their own decision');
    expect(flat(all)).toContain('never a number or whether it is zero');
    expect(flat(all)).not.toContain('reports only whether it is zero');
  });

  it('NFR-SEC-17: the whole runbook gives an agent no shell, window, socket or step of its own', () => {
    // The property is "no step lets an agent connect", and the test above names three strings that
    // carried it. This one reads the other shape it could come back in: a sentence that hands a
    // step to an agent. Words that name the agent as a refused party are allowed (12.2 says so);
    // the sentences that follow are not.
    const prose = flat(md());
    for (const re of [
      /\b(the|an) (AI )?agent'?s? (runs|sends|holds|checks|re-runs|starts|compares|stops|reaches|connects|rides)\b/i,
      /agent'?s? `?\$SSH/i,
      /riding the owner's window/i,
    ]) {
      expect(prose.match(re), String(re)).toBeNull();
    }
  });
});

describe('deployment.md 12.6: erasure on a controller\'s written instruction', () => {
  it('FR-EVD-05 FR-REV-08 NFR-SEC-17: 12.6 runs each erasure procedure as the owner, outside any AI session, then VACUUM', () => {
    const s = section('### 12.6');
    const t = flat(s);
    const code = fenced(s).map((l) => l.trim());
    expect(t).toContain("Run only on the controller's written instruction, in the owner's own session (12.1), in a terminal outside any AI session");
    const psql = '$C exec -T postgres psql -U "$PGU" -d makrai -Atc';
    const calls = [
      `${psql} "select erase_evidence_bytes('<org id>', '<evidence id>', '<erasure code>', '<instruction reference>')"`,
      `${psql} "select erase_text_field('<org id>', '<table>', '<row id>', '<field>', '<erasure code>', '<instruction reference>')"`,
      `${psql} "select erase_typed_field('<org id>', '<document id>', '<field id>', '<erasure code>', '<instruction reference>')"`,
    ];
    const vacuums = [
      `${psql} 'vacuum evidence_blobs, issued_documents'`,
      `${psql} 'vacuum <table>, issued_documents'`,
      `${psql} 'vacuum issued_documents, document_draft_fields'`,
    ];
    calls.forEach((c, i) => {
      expect(code).toContain(c);
      expect(code.indexOf(vacuums[i]), vacuums[i]).toBeGreaterThan(code.indexOf(c));
    });
    const countLine = `${psql} "select count(*) from tombstones where \\"instructionReference\\" = '<instruction reference>'"`;
    expect(code).toContain(countLine);
    // The only commands in 12.6 are the three calls, their three VACUUM lines and the count: nothing else
    // that touches the database can be added without this list changing.
    expect(code.filter((l) => l.startsWith('$C')).sort()).toEqual([...calls, ...vacuums, countLine].sort());
    const reads = code.filter((l) => /\bselect\b/i.test(l) && !/select (erase_|count\(\*\) from tombstones)/i.test(l));
    expect(reads).toEqual([]); // no step reads a record field, so nothing erased is printed (RB-S7)
    expect(t).toContain('valid; 1 field erased');
    expect(t).toContain('valid; 1 file erased');
    expect(t).toMatch(/30 days \(NFR-PRIV-07\)/);
  });

  it('FR-EVD-05 FR-REV-08: the argument names and order of 12.6 equal the functions the migrations define', () => {
    // The three calls are copied by hand into a runbook; the functions are defined in SQL. If K0a or
    // REV-b changes an argument list, or the erasure code and the instruction reference swap places
    // (the functions accept any non-empty text for both), the owner's copy-paste would be wrong on the
    // night, so the runbook's placeholders are compared, in order, with the migration's parameter names.
    // erase_typed_field is REV-b's and has not merged when RB does: it is compared once its migration exists.
    const defs = new Map<string, string[]>();
    let mentionsTyped = false;
    // Directories only (migration_lock.toml sits beside them); a directory without migration.sql throws.
    for (const dir of readdirSync('prisma/migrations', { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const sql = readFileSync(join('prisma/migrations', dir.name, 'migration.sql'), 'utf8');
      const code = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
      if (/erase_typed_field/.test(code)) mentionsTyped = true;
      for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?(erase_\w+)"?\s*\(([^)]*)\)/gi)) {
        defs.set(m[1], m[2].split(',').map((p) => p.trim().split(/\s+/)[0]));
      }
    }
    expect(defs.get('erase_evidence_bytes')).toEqual(['org_id', 'evidence_id', 'erasure_code', 'instruction_reference']);
    expect(defs.get('erase_text_field')).toEqual(['org_id', 'target_table', 'target_id', 'field', 'erasure_code', 'instruction_reference']);
    // A migration that uses erase_typed_field without a definition this test can read must not pass silently.
    if (mentionsTyped) expect(defs.has('erase_typed_field'), 'a migration names erase_typed_field but no definition was read').toBe(true);
    const code = fenced(section('### 12.6')).map((l) => l.trim());
    const paramOf = (placeholder: string): string => ({ table: 'target_table', 'row id': 'target_id' })[placeholder] ?? placeholder.replace(/ /g, '_');
    for (const [name, params] of defs) {
      const call = code.find((l) => l.includes(`select ${name}(`));
      expect(call, `12.6 calls ${name}`).toBeDefined();
      const args = /\(([^)]*)\)/.exec(call!.slice(call!.indexOf(`${name}(`)));
      const placeholders = args![1].split(',').map((a) => a.trim().replace(/^'<|>'$/g, ''));
      expect(placeholders.map(paramOf), `${name}: arguments in 12.6`).toEqual(params);
    }
  });
});

describe('docs/adr: the ten accepted section 9.7 decisions', () => {
  it('NFR-MNT-06: one accepted ADR per accepted section 9.7 candidate, each indexed', () => {
    const map: Record<string, string> = {
      '0011': 'C1',
      '0012': 'C2',
      '0013': 'C3',
      '0014': 'C5',
      '0015': 'C6',
      '0016': 'C7',
      '0017': 'C8',
      '0018': 'C9',
      '0019': 'C10',
      '0020': 'C11',
    };
    const files = readdirSync('docs/adr').filter((f) => /^00(1[1-9]|20)-/.test(f));
    expect(files.map((f) => f.slice(0, 4)).sort()).toEqual(Object.keys(map));
    const index = readFileSync('docs/adr/README.md', 'utf8');
    for (const f of files) {
      const t = readFileSync(`docs/adr/${f}`, 'utf8');
      expect(t, f).toMatch(/\*\*Status:\*\* Accepted/);
      for (const h of ['## Context', '## Decision', '## Consequences', '## Alternatives rejected', '## References']) expect(t, `${f} ${h}`).toContain(h);
      expect(t, f).toContain(`SRS 9.7 ADR-${map[f.slice(0, 4)]}`);
      expect(index, f).toContain(`[${f.slice(0, 4)}](${f})`);
    }
    expect(readdirSync('docs/adr').some((f) => /ADR-C4|public-verification/.test(f))).toBe(false);
  });
});
