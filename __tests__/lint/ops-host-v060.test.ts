import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The v0.6.0 host scripts (unit OPS-HOST): the hourly reminder wrapper, the audit ship's seal lines,
 * the backup check's size alert, and the restore test's seal check. Each runs in a sandbox with the
 * script and makrai-lib.sh side by side, stand-ins for every outside tool first on PATH recording their
 * argv and stdin, and a .env written here (the pattern of ops-host-scripts.test.ts). Nothing here
 * touches a production host: what the stand-ins cannot show (the real journal, the real container, the
 * healthchecks service) is the owner's install check in ops/host/README.md.
 */

const HOST = path.resolve('ops/host');
const LIB = 'makrai-lib.sh';

const notComment = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

const STUB_BODY = (body: string): string => `#!/usr/bin/env bash\n${body}\n`;

function makeBox(prefix: string, scripts: string[], stubs: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const d = { host: path.join(dir, 'host'), bin: path.join(dir, 'bin'), rec: path.join(dir, 'rec'), state: path.join(dir, 'state') };
  for (const x of Object.values(d)) mkdirSync(x);
  for (const f of [...scripts, LIB]) copyFileSync(path.join(HOST, f), path.join(d.host, f));
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(path.join(d.bin, name), STUB_BODY(body));
    chmodSync(path.join(d.bin, name), 0o755);
  }
  return { dir, d };
}

// ---------------------------------------------------------------------------------------------
// Task 3: the hourly reminder wrapper (NFR-OBS-02, FR-OPS-02)
// ---------------------------------------------------------------------------------------------

const REMINDERS = 'makrai-reminders.sh';
const PING = 'https://hc.example/ping/abc';
const TOKEN_SENTINEL = 'f'.repeat(64);

const REMINDER_STUBS: Record<string, string> = {
  // The web container: prints STUB_EXEC_OUT, exits STUB_EXEC_RC (a missing container prints on stderr).
  docker: `
{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/docker"
[ -z "\${STUB_EXEC_ERR:-}" ] || echo "$STUB_EXEC_ERR" >&2
[ -z "\${STUB_EXEC_OUT:-}" ] || echo "$STUB_EXEC_OUT"
exit "\${STUB_EXEC_RC:-0}"`,
  curl: `
{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/curl-argv"
{ echo CALL; cat; } >> "$REC/curl-stdin"
exit "\${STUB_CURL_RC:-0}"`,
};

type Exec = { code: number; stdout?: string; stderr?: string };

function runReminders(o: { exec: Exec; env?: Record<string, string>; dotenv?: string | null }) {
  const { dir, d } = makeBox('ops-host-rem-', [REMINDERS], REMINDER_STUBS);
  try {
    const envFile = path.join(dir, '.env');
    // The token is in the server .env too, as in production; the wrapper must never read it.
    if (o.dotenv !== null) writeFileSync(envFile, o.dotenv ?? `HC_REMINDER_PING_URL=${PING}\nREMINDER_JOB_TOKEN=${TOKEN_SENTINEL}\n`);
    const log = path.join(dir, 'reminders.log');
    const r = spawnSync('bash', [path.join(d.host, REMINDERS)], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        NODE_ENV: 'test',
        PATH: `${d.bin}:/usr/bin:/bin`,
        HOME: dir,
        REC: d.rec,
        MAKRAI_ENV_FILE: envFile,
        MAKRAI_REMINDERS_LOG: log,
        STUB_EXEC_RC: String(o.exec.code),
        STUB_EXEC_OUT: o.exec.stdout ?? '',
        STUB_EXEC_ERR: o.exec.stderr ?? '',
        ...o.env,
      },
    });
    const rec = (f: string): string[][] => {
      const p = path.join(d.rec, f);
      if (!existsSync(p)) return [];
      const out: string[][] = [];
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (line === 'CALL') out.push([]);
        else if (line !== '') out[out.length - 1].push(line);
      }
      return out;
    };
    return {
      code: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      log: existsSync(log) ? readFileSync(log, 'utf8') : '',
      logMode: existsSync(log) ? statSync(log).mode & 0o777 : null,
      calls: rec('docker'),
      pings: rec('curl-stdin').map((c) => /url = "([^"]*)"/.exec(c.join('\n'))?.[1]),
      curlArgv: rec('curl-argv').flat(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('makrai-reminders.sh (Task 3)', () => {
  const OK_OUT = 'status=200 attempted=2 sent=2 failed=0 opted_out=0 skipped_locked=0';

  it('NFR-OBS-02 FR-OPS-02: a run whose sends all succeed exits 0 and pings the check', () => {
    const r = runReminders({ exec: { code: 0, stdout: OK_OUT } });
    expect(r.code).toBe(0);
    expect(r.pings).toEqual([PING]);
    expect(r.log).toContain(OK_OUT);
    expect(r.log.trimEnd().split('\n').at(-1)).toMatch(/^result=pass at=\d{4}-\d\d-\d\dT/);
    expect(r.logMode).toBe(0o600);
  });

  it('NFR-OBS-02 FR-OPS-02: a failed send exits 1 and pings /fail', () => {
    const r = runReminders({ exec: { code: 1, stdout: 'status=200 attempted=2 sent=1 failed=1 opted_out=0 skipped_locked=0' } });
    expect(r.code).toBe(1);
    expect(r.pings).toEqual([`${PING}/fail`]);
    expect(r.log.trimEnd().split('\n').at(-1)).toMatch(/^result=fail at=/);
  });

  it('NFR-OBS-02: a refused route, a timeout and a missing container each exit non-zero and ping /fail', () => {
    for (const exec of [
      { code: 1, stdout: 'status=401' },
      { code: 124, stdout: '' },
      { code: 1, stdout: '', stderr: 'No such container' },
    ]) {
      const r = runReminders({ exec });
      expect(r.code, JSON.stringify(exec)).not.toBe(0);
      expect(r.pings, JSON.stringify(exec)).toEqual([`${PING}/fail`]);
    }
  });

  it('NFR-OBS-02: a docker exec exit of 0 with no result line is a failure, not a pass', () => {
    const r = runReminders({ exec: { code: 0, stdout: '' } });
    expect(r.code).not.toBe(0);
    expect(r.pings).toEqual([`${PING}/fail`]);
  });

  it('FR-OPS-02 NFR-REL-08: a run the job skipped because another holds the lock is a pass', () => {
    const r = runReminders({ exec: { code: 0, stdout: 'status=200 attempted=0 sent=0 failed=0 opted_out=0 skipped_locked=1' } });
    expect(r.code).toBe(0);
    expect(r.pings).toEqual([PING]);
  });

  it('FR-OPS-02 NFR-SEC-14: the wrapper never puts the token or the ping URL in argv', () => {
    const r = runReminders({ exec: { code: 0, stdout: OK_OUT } });
    const argv = r.calls.flat().join(' ');
    expect(argv).toContain('docker-nextjs-1');
    expect(argv).not.toMatch(/hc\.example|REMINDER_JOB_TOKEN=|Bearer [A-Za-z0-9]/);
    expect(argv).not.toContain(TOKEN_SENTINEL);
    expect(r.curlArgv.join(' ')).not.toMatch(/hc\.example/);
    expect(r.log + r.stdout + r.stderr).not.toContain(TOKEN_SENTINEL);
    expect(notComment(readFileSync(path.join(HOST, REMINDERS), 'utf8'))).not.toMatch(/\$\{?REMINDER_JOB_TOKEN/);
    expect(notComment(readFileSync(path.join(HOST, REMINDERS), 'utf8'))).not.toMatch(/read_env[^\n]*REMINDER_JOB_TOKEN/);
  });

  it('NFR-OBS-02: the one docker exec is bounded at 900 seconds and runs node in the web container', () => {
    const r = runReminders({ exec: { code: 0, stdout: OK_OUT } });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].slice(0, 3)).toEqual(['exec', 'docker-nextjs-1', 'node']);
    expect(notComment(readFileSync(path.join(HOST, REMINDERS), 'utf8'))).toMatch(/timeout 900 docker exec docker-nextjs-1 node -e/);
  });

  it('NFR-OBS-02: a missing HC_REMINDER_PING_URL still runs the job and exits non-zero', () => {
    const r = runReminders({ exec: { code: 0, stdout: OK_OUT }, dotenv: 'SOMETHING_ELSE=1\n' });
    expect(r.code).not.toBe(0);
  });

  it('NFR-OBS-02: the operator crontab runs the wrapper hourly', () => {
    expect(readFileSync(path.join(HOST, 'crontab.operator'), 'utf8')).toMatch(/^20 \* \* \* \* \/usr\/local\/bin\/makrai-reminders\.sh$/m);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 4: the backup check's size alert (NFR-REL-03)
// ---------------------------------------------------------------------------------------------

const BACKUP_CHECK = 'makrai-backup-check.sh';

const BACKUP_CHECK_STUBS: Record<string, string> = {
  // The live database container: answers the size query with STUB_DB_BYTES, or fails as asked.
  docker: `
{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/docker"
[ -z "\${STUB_DOCKER_FAIL:-}" ] || { echo "Error: No such container" >&2; exit 1; }
echo "\${STUB_DB_BYTES-}"`,
  // Resend: records argv (the payload is in -d, the key on stdin).
  curl: `
{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/curl-argv"
{ echo CALL; cat; } >> "$REC/curl-stdin"
printf '\\n200'`,
};

function runBackupCheck(o: { dbBytes?: string; env?: Record<string, string>; dockerFail?: boolean }) {
  const { dir, d } = makeBox('ops-host-bc-', [BACKUP_CHECK], BACKUP_CHECK_STUBS);
  try {
    const backups = path.join(dir, 'backups');
    const app = path.join(dir, 'app');
    mkdirSync(backups);
    mkdirSync(app);
    writeFileSync(path.join(backups, 'makrai-20261104-000000.sql.gz.gpg'), 'x'.repeat(2000));
    writeFileSync(
      path.join(app, '.env'),
      ['RESEND_API_KEY=key-sentinel', 'ADMIN_EMAIL=admin@example.test', 'EMAIL_FROM_ADDRESS=from@example.test', 'POSTGRES_USER=owner_role', 'POSTGRES_DB=app_db'].join('\n') + '\n',
    );
    const r = spawnSync('bash', [path.join(d.host, BACKUP_CHECK)], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        NODE_ENV: 'test',
        PATH: `${d.bin}:/usr/bin:/bin`,
        HOME: dir,
        REC: d.rec,
        BACKUP_DIR: backups,
        APP_DIR: app,
        STUB_DB_BYTES: o.dbBytes ?? '1000',
        ...(o.dockerFail ? { STUB_DOCKER_FAIL: '1' } : {}),
        ...o.env,
      },
    });
    const read = (f: string): string => (existsSync(path.join(d.rec, f)) ? readFileSync(path.join(d.rec, f), 'utf8') : '');
    const argv = read('curl-argv');
    const payloads = [...argv.matchAll(/^(\{.*\})$/gm)].map((m) => JSON.parse(m[1]) as { subject: string; text: string });
    return {
      code: r.status,
      stderr: r.stderr,
      alerts: payloads.map((p) => p.subject),
      bodies: payloads.map((p) => p.text),
      dockerCalls: read('docker').split('CALL\n').filter(Boolean).map((c) => c.split('\n').filter(Boolean)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('makrai-backup-check.sh size alert (Task 4)', () => {
  it('NFR-REL-03: the backup check alerts when the database is above 2 GB, and not at it', () => {
    const over = runBackupCheck({ dbBytes: '2000000001' });
    expect(over.code).toBe(1);
    expect(over.alerts).toHaveLength(1);
    expect(over.alerts[0]).toMatch(/^\[makrai\] DATABASE ABOVE 2 GB/);
    const at = runBackupCheck({ dbBytes: '2000000000' });
    expect(at.code).toBe(0);
    expect(at.alerts).toEqual([]);
  });

  it('NFR-REL-03 H9: the one query is a size SELECT and the alert carries the size and the limit only', () => {
    const r = runBackupCheck({ dbBytes: '2500000000' });
    expect(r.dockerCalls).toHaveLength(1);
    expect(r.dockerCalls[0]).toEqual(['exec', 'docker-postgres-1', 'psql', '-U', 'owner_role', '-d', 'app_db', '-Atc', 'SELECT pg_database_size(current_database())']);
    expect(r.bodies[0]).toContain('2500000000');
    expect(r.bodies[0]).toContain('2000000000');
    expect(r.alerts[0] + r.bodies[0]).not.toMatch(/owner_role|app_db/);
  });

  it('NFR-REL-03: MAX_DB_BYTES moves the limit, so a test can make the alert fire', () => {
    const r = runBackupCheck({ dbBytes: '5000', env: { MAX_DB_BYTES: '4999' } });
    expect(r.code).toBe(1);
    expect(r.bodies[0]).toContain('4999');
  });

  it('NFR-REL-03: a size that cannot be read is an alert and a failure, not a pass', () => {
    for (const o of [{ dockerFail: true }, { dbBytes: '' }, { dbBytes: 'not a number' }]) {
      const r = runBackupCheck(o);
      expect(r.code, JSON.stringify(o)).toBe(1);
      expect(r.alerts, JSON.stringify(o)).toHaveLength(1);
      expect(r.alerts[0], JSON.stringify(o)).toMatch(/^\[makrai\] DATABASE SIZE UNREADABLE/);
    }
  });
});
