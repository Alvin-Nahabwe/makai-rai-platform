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
    expect(code).toContain(`printf 'REMINDER_JOB_TOKEN=%s\\n' "$(openssl rand -hex 32)" >> /srv/makrai/app/.env`);
    expect(code).toContain(`grep -c '^REMINDER_JOB_TOKEN=[0-9a-f]\\{64\\}$' /srv/makrai/app/.env`);
    expect(code.some((l) => /^read -rs -p 'HC_REMINDER_PING_URL: ' V\b/.test(l))).toBe(true);
    expect(code).toContain(`grep -cE '^HC_REMINDER_PING_URL=https://hc-ping\\.com/[0-9a-f-]{36}$' /srv/makrai/app/.env`);
    const printsValue = code.filter(
      (l) => /\b(echo|cat|printf)\b.*\$(V|REMINDER_JOB_TOKEN|HC_REMINDER_PING_URL)\b/.test(l) && !l.includes('>> /srv/makrai/app/.env'),
    );
    expect(printsValue).toEqual([]);
    expect(code.filter((l) => /grep\s+(?!-c)[^|]*(REMINDER_JOB_TOKEN|HC_REMINDER_PING_URL)/.test(l))).toEqual([]);
    const umaskAt = code.indexOf('umask 077');
    const tokenAt = code.indexOf(`printf 'REMINDER_JOB_TOKEN=%s\\n' "$(openssl rand -hex 32)" >> /srv/makrai/app/.env`);
    expect(umaskAt).toBeGreaterThan(-1);
    expect(tokenAt).toBeGreaterThan(umaskAt); // 64 lowercase hex, made after umask 077 (contract route 40 row)
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
    const step2 = fenced(s85().split(/^\*\*Step 3\.\*\*/m)[0].split(/^\*\*Step 2\.\*\*/m)[1] ?? '').join(' ');
    for (const t of ['projects', 'assessments', 'evidence']) expect(step2, t).toContain(`from ${t} `);
    expect((step2.match(/\bselect\b/gi) ?? []).length, 'one outer select and three counts').toBe(4);
    expect((step2.match(/count\(\*\)/g) ?? []).length).toBe(3);
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
    expect(t.indexOf('migrate resolve')).toBeGreaterThan(t.indexOf('If the migrator stops on the owner check'));
    expect(t).toMatch(/Do not run 8\.3 step 5/);
    expect(t.match(/migrate resolve --rolled-back/g)).toHaveLength(1);
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
  });
});

describe('deployment.md 8.5: the lines that change the host are the lines that were run here', () => {
  /** Runs a bash script in a scratch directory; asserts only on files and the exit status, never on output text. */
  function bash(script: string, cwd: string): number {
    const r = spawnSync('bash', ['-c', script], { cwd, env: { PATH: process.env.PATH ?? '', NO_COLOR: '1' }, encoding: 'utf8' });
    return r.status ?? -1;
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
      expect(bash(`${body}\nunset_env ALLOW_OPEN_REGISTRATION && unset_env ORG_LIMIT_PER_USER && unset_env NOT_THERE`, dir)).toBe(0);
      expect(readFileSync(envFile, 'utf8')).toBe(
        ['POSTGRES_USER=makrai', 'ALLOW_OPEN_REGISTRATION_EXTRA=keep', '# ALLOW_OPEN_REGISTRATION=kept comment', 'NEXTAUTH_SECRET=a=b=c', ''].join('\n'),
      );
      expect(statSync(envFile).mode & 0o777).toBe(0o640);
      expect(readdirSync(dir).sort(), 'no .env.new is left behind').toEqual(['.env']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FR-OPS-01 NFR-AVL-03: the pause comments out exactly the synthetic journey's cron line, and step 11 restores the saved crontab", () => {
    const code = fenced(s85()).map((l) => l.trim());
    const pause = code.find((l) => l.startsWith('sed ') && l.includes('#v060-pause'));
    expect(pause, 'step 6 should pause the journey with a sed over the saved crontab').toBeDefined();
    expect(code).toContain('crontab -l > /root/makrai-stage/crontab.root.v060-pause');
    expect(code).toContain("crontab -l | grep -c '^#v060-pause '");
    // Step 11 restores the exact saved crontab before the install chain, and removes the copy after it.
    const restoreAt = code.indexOf('crontab /root/makrai-stage/crontab.root.v060-pause');
    const removeAt = code.indexOf('rm -f /root/makrai-stage/crontab.root.v060-pause');
    expect(restoreAt, 'step 11 restores the saved crontab').toBeGreaterThan(code.indexOf("crontab -l | grep -c '^#v060-pause '"));
    expect(removeAt, 'step 11 removes the saved copy after the install chain').toBeGreaterThan(restoreAt);
    // Run the sed over the crontab the repository ships: it must change one line and only that line,
    // so a later edit to the 7-past line in ops/host/crontab.root fails here and not on the host.
    const dir = mkdtempSync(join(tmpdir(), 'pause-'));
    try {
      const shipped = readFileSync('ops/host/crontab.root', 'utf8');
      writeFileSync(join(dir, 'saved'), shipped);
      expect(pause).toMatch(/\| crontab -$/);
      const script = pause!.replace(/\s*\| crontab -$/, '').replace('/root/makrai-stage/crontab.root.v060-pause', join(dir, 'saved')) + ` > ${join(dir, 'paused')}`;
      expect(bash(script, dir)).toBe(0);
      const before = shipped.split('\n');
      const after = readFileSync(join(dir, 'paused'), 'utf8').split('\n');
      expect(after).toHaveLength(before.length);
      const changed = before.map((l, i) => [l, after[i]]).filter(([a, b]) => a !== b);
      expect(changed).toHaveLength(1);
      expect(changed[0][0]).toMatch(/^7 \* \* \* \* \/usr\/local\/sbin\/makrai-synthetic\.sh --ping /);
      expect(changed[0][1]).toBe(`#v060-pause ${changed[0][0]}`);
      expect(after.filter((l) => l.startsWith('#v060-pause '))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

