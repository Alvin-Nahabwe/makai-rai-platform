import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
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
      { code: 1, stdout: 'status=500' },
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

  describe('the node program the wrapper runs in the container', () => {
    // The wrapper's $JS, run by node against an in-process server, the URL's port substituted.
    const JS = (): string => /\nJS='([\s\S]*?)\n'\n/.exec(readFileSync(path.join(HOST, REMINDERS), 'utf8'))?.[1] ?? '';
    const TOKEN = 'a'.repeat(64);
    async function runJs(answer: (req: http.IncomingMessage, res: http.ServerResponse) => void, token: string | null = TOKEN) {
      const seen: { authorization?: string; method?: string; url?: string }[] = [];
      const server = http.createServer((req, res) => {
        seen.push({ authorization: req.headers.authorization, method: req.method, url: req.url });
        answer(req, res);
      });
      await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
      const port = (server.address() as { port: number }).port;
      const js = JS().replace('127.0.0.1:3000', `127.0.0.1:${port}`);
      expect(js, 'the program names the container-local address').not.toBe(JS());
      const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', PATH: process.env.PATH };
      if (token !== null) env.REMINDER_JOB_TOKEN = token;
      const child = spawn('node', ['-e', js], { env });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      const code = await new Promise<number | null>((ok) => child.on('close', ok));
      server.close();
      return { code, out: out.trim(), seen };
    }
    const json = (status: number, body: unknown) => (_q: http.IncomingMessage, res: http.ServerResponse) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    it('NFR-OBS-02 FR-OPS-02: a 200 with no failed send prints the numbers and exits 0, with a Bearer POST to route 40', async () => {
      const r = await runJs(json(200, { attempted: 2, sent: 2, failed: 0, optedOut: 1, skippedLocked: false }));
      expect(r).toMatchObject({ code: 0, out: 'status=200 attempted=2 sent=2 failed=0 opted_out=1 skipped_locked=0' });
      expect(r.seen).toEqual([{ authorization: `Bearer ${TOKEN}`, method: 'POST', url: '/api/internal/reminders' }]);
    });

    it('NFR-OBS-02 FR-OPS-02: a 200 with a failed send, a 500, a 401 and a bad body each exit 1', async () => {
      expect(await runJs(json(200, { attempted: 2, sent: 1, failed: 1, optedOut: 0, skippedLocked: false }))).toMatchObject({
        code: 1,
        out: 'status=200 attempted=2 sent=1 failed=1 opted_out=0 skipped_locked=0',
      });
      expect(await runJs(json(500, { error: 'x' }))).toMatchObject({ code: 1, out: 'status=500' });
      expect(await runJs(json(401, {}))).toMatchObject({ code: 1, out: 'status=401' });
      expect(await runJs(json(200, '{"attempted":"two"}'))).toMatchObject({ code: 1, out: 'status=200 reason=bad_body' });
      expect(await runJs(json(200, 'not json'))).toMatchObject({ code: 1, out: 'status=200 reason=bad_body' });
    });

    it('NFR-OBS-02: a missing token exits 1 without sending anything', async () => {
      const r = await runJs(json(200, {}), null);
      expect(r).toMatchObject({ code: 1, out: 'status=0 reason=no_token' });
      expect(r.seen).toEqual([]);
    });

    it('NFR-OBS-02 NFR-SEC-14: nothing the server answers is printed beyond the numbers', async () => {
      const r = await runJs(json(200, { attempted: 1, sent: 1, failed: 0, optedOut: 0, skippedLocked: false, email: 'someone@example.test' }));
      expect(r.out).not.toContain('someone@example.test');
    });
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
  // journald, through logger: records argv.
  logger: `
{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/logger"`,
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
      logged: read('logger').split('CALL\n').filter(Boolean).map((c) => c.split('\n').filter(Boolean)),
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

  it('NFR-REL-03: each size failure also leaves a line in journald, so a failed email still leaves a trace', () => {
    const over = runBackupCheck({ dbBytes: '2500000000' });
    expect(over.logged).toHaveLength(1);
    expect(over.logged[0].slice(0, 3)).toEqual(['-p', 'user.err', '-t']);
    expect(over.logged[0].join(' ')).toMatch(/DATABASE ABOVE 2 GB size=2500000000 limit=2000000000/);
    const bad = runBackupCheck({ dockerFail: true });
    expect(bad.logged).toHaveLength(1);
    expect(bad.logged[0].join(' ')).toMatch(/DATABASE SIZE UNREADABLE/);
    // Nothing but the figures and the fixed words: no database or role name.
    expect(over.logged[0].join(' ') + bad.logged[0].join(' ')).not.toMatch(/owner_role|app_db/);
    expect(runBackupCheck({ dbBytes: '2000000000' }).logged).toEqual([]);
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

// ---------------------------------------------------------------------------------------------
// Task 2: the restore test's seal check and growth figures (NFR-INT-07, NFR-REL-03)
// ---------------------------------------------------------------------------------------------

const RESTORE = 'makrai-restore-test.sh';
const WEB_IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const PG_IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const SEAL_MJS = '/ops/ops/host/seal-check.mjs';

const RESTORE_STUBS: Record<string, string> = {
  // The live and the throwaway Postgres, and the offline seal-check container. Every call is recorded in
  // $REC/docker (CALL, then one argument a line); the seal-check calls also record their stdin.
  docker: `
# One write, so the two ends of a pipe (docker exec | docker run) cannot interleave their records.
( flock 8; { echo CALL; printf '%s\\n' "$@"; } >> "$REC/docker" ) 8>"$REC/docker.lock"
all="$*"
case "$1" in
  inspect)
    case "$all" in *docker-nextjs-1*) echo "${WEB_IMAGE_ID}" ;; *) echo "${PG_IMAGE_ID}" ;; esac ;;
  run)
    case "$all" in
      *${SEAL_MJS}*)
        mode=\${!#}
        cat > "$REC/seal-$mode-stdin"
        # A check that never ends and ignores TERM, as node does as PID 1 without --init.
        [ "\${STUB_SEAL_HANG:-}" != "$mode" ] || { trap '' TERM; exec /usr/bin/sleep 30; }
        [ "$mode" = plan ] && { echo "SELECT 'plan-stand-in';"; exit "\${STUB_PLAN_RC:-0}"; }
        [ -z "\${STUB_SEAL_OUT:-}" ] || echo "$STUB_SEAL_OUT"
        exit "\${STUB_SEAL_RC:-0}" ;;
      *) echo stand-in-container-id ;;
    esac ;;
  rm) ;;
  exec)
    case "$all" in "exec -i "*) cat > "$REC/exec-stdin-$$" ;; esac
    case "$all" in
      *pg_isready*) ;;
      *'count(*) FROM seals'*) echo "\${STUB_SEAL_COUNT-0}" ;;
      *'FROM seals'*) printf '%s' "\${STUB_ORG_IDS-}"; [ -z "\${STUB_ORG_IDS-}" ] || echo ;;
      *'-f -'*) cp "$REC/exec-stdin-$$" "$REC/rows-plan-stdin" 2>/dev/null; printf '%s\\n' "\${STUB_ROWS-ROWS-FROM-RESTORED-COPY}"; [ "\${STUB_ROWS_RC:-0}" = 0 ] || exit "$STUB_ROWS_RC" ;;
      *pg_policies*) echo 5 ;;
      *_prisma_migrations*) echo 3 ;;
      *'FROM users'*) echo 2 ;;
      *'FROM organizations o'*) printf '%s\\n' "\${STUB_PER_ORG-}" ;;
      *'FROM organizations'*) echo 1 ;;
      *pg_database_size*) echo "\${STUB_DB_BYTES-0}" ;;
      *evidence*) echo "\${STUB_UNATTACHED-0}" ;;
    esac ;;
esac
exit 0`,
  rsync: `
{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/rsync"
for a in "$@"; do case "$a" in --list-only) echo "-rw-------  1,234 2026/11/04 01:00:00 makrai-20261104-000000.sql.gz.gpg"; exit 0 ;; esac; done
dest=\${!#}; src=\${@:$#-1:1}
: > "$dest/\${src##*:}"
exit 0`,
  // Records what the script asked for, then runs the real timeout with a short fuse, whatever the script asked for.
  timeout: `
printf '%s\\n' "$*" >> "$REC/timeout"
if [ "\${1#--kill-after=}" != "$1" ]; then shift; fi
shift
exec /usr/bin/timeout --kill-after=1 "\${STUB_FUSE:-2}" "$@"`,
  gpg: `echo "SELECT 1;"`,
  gunzip: `cat`,
  curl: `
{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/curl-argv"
{ echo CALL; cat; } >> "$REC/curl-stdin"
printf '\\n200'`,
};

type RestoreOpts = {
  sealCheck?: { code: number; stdout: string };
  orgIds?: string;
  sizes?: { db?: string; unattached?: string; perOrg?: string };
  planRc?: number;
  rowsRc?: number;
  hang?: 'plan' | 'check';
  sealCount?: string;
};

function runRestore(o: RestoreOpts = {}) {
  const { dir, d } = makeBox('ops-host-rt-', [RESTORE], RESTORE_STUBS);
  try {
    // The script and the library name three absolute paths of the server. The sandbox rewrites exactly
    // those, in its own copies, so the script that runs is the committed one with a different root.
    const app = path.join(dir, 'app');
    mkdirSync(path.join(app, 'prisma', 'migrations', '0001_init'), { recursive: true });
    writeFileSync(path.join(app, 'prisma', 'migrations', '0001_init', 'migration.sql'), 'CREATE ROLE makrai_app;\n');
    writeFileSync(
      path.join(app, '.env'),
      [
        'OFFSITE_TARGET=box@example.test:',
        'POSTGRES_USER=owner_role',
        'POSTGRES_DB=app_db',
        'BACKUP_PASSPHRASE=passphrase-sentinel',
        `HC_RESTORE_PING_URL=${PING}`,
        'RESEND_API_KEY=key-sentinel',
        'ADMIN_EMAIL=admin@example.test',
        'EMAIL_FROM_ADDRESS=from@example.test',
        '',
      ].join('\n'),
    );
    const log = path.join(dir, 'restore-test.log');
    for (const [file, from, to] of [
      [RESTORE, '/srv/makrai/restore-test.log', log],
      [RESTORE, '/srv/makrai/app/prisma', path.join(app, 'prisma')],
      [LIB, '/srv/makrai/app/.env', path.join(app, '.env')],
    ]) {
      const p = path.join(d.host, file);
      const text = readFileSync(p, 'utf8');
      expect(text, `${file} names ${from}`).toContain(from);
      writeFileSync(p, text.replaceAll(from, to));
    }
    for (const f of [RESTORE, LIB]) expect(notComment(readFileSync(path.join(d.host, f), 'utf8'))).not.toContain('/srv/makrai');
    const sizes = o.sizes ?? {};
    const r = spawnSync('bash', [path.join(d.host, RESTORE)], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        PATH: `${d.bin}:/usr/bin:/bin`,
        HOME: dir,
        REC: d.rec,
        STUB_SEAL_RC: String(o.sealCheck?.code ?? 0),
        STUB_SEAL_OUT: o.sealCheck?.stdout ?? 'seals=0 valid=0 mismatched=0 erased_fields=0 erased_files=0',
        STUB_ORG_IDS: o.orgIds ?? 'o1\no2',
        STUB_PLAN_RC: String(o.planRc ?? 0),
        STUB_SEAL_COUNT: o.sealCount ?? /^seals=(\d+)/.exec(o.sealCheck?.stdout ?? 'seals=0')?.[1] ?? '0',
        ...(o.hang ? { STUB_SEAL_HANG: o.hang } : {}),
        STUB_ROWS_RC: String(o.rowsRc ?? 0),
        STUB_DB_BYTES: sizes.db ?? '1048576',
        STUB_UNATTACHED: sizes.unattached ?? '0',
        STUB_PER_ORG: sizes.perOrg ?? 'o1|5000|2048',
      },
    });
    const read = (f: string): string => (existsSync(path.join(d.rec, f)) ? readFileSync(path.join(d.rec, f), 'utf8') : '');
    const calls = read('docker')
      .split('CALL\n')
      .filter(Boolean)
      .map((c) => c.split('\n').filter(Boolean));
    return {
      code: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      log: existsSync(log) ? readFileSync(log, 'utf8') : '',
      calls,
      pings: read('curl-stdin').split('CALL\n').filter(Boolean).map((c) => /url = "([^"]*)"/.exec(c)?.[1]).filter(Boolean),
      sealStdin: { plan: read('seal-plan-stdin'), check: read('seal-check-stdin') },
      rowsStdin: read('rows-plan-stdin'),
      timeouts: read('timeout').split('\n').filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('makrai-restore-test.sh seal check and sizes (Task 2)', () => {
  const OK_SEALS = 'seals=3 valid=3 mismatched=0 erased_fields=1 erased_files=0';

  it('NFR-INT-07: one tampered seal makes the restore test fail with field seals', () => {
    const r = runRestore({
      sealCheck: {
        code: 1,
        stdout: 'seals=3 valid=2 mismatched=1 erased_fields=0 erased_files=0\nseal=s1 result=mismatch first_difference=decisions[Q-PP-01].reason',
      },
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('RESTORE MISMATCH seals\n');
    expect(r.log).toMatch(/Restore test FAILED: seals$/m);
    expect(r.log).toContain('seal=s1 result=mismatch first_difference=decisions[Q-PP-01].reason');
    expect(r.pings).toEqual([`${PING}/fail`]);
  });

  it('NFR-INT-07: with every seal valid the last log line reads Restore test PASSED', () => {
    const r = runRestore({ sealCheck: { code: 0, stdout: OK_SEALS } });
    expect(r.code, r.log).toBe(0);
    expect(r.stdout).toBe('RESTORE MATCH\n');
    expect(r.log.trimEnd().split('\n').at(-1)).toMatch(/Restore test PASSED$/);
    expect(r.log).toContain(OK_SEALS);
    expect(r.pings).toEqual([PING]);
  });

  it("NFR-INT-07: the seal check runs offline from root's installed copies", () => {
    const runs = runRestore({ sealCheck: { code: 0, stdout: OK_SEALS } }).calls.filter((c) => c.includes(SEAL_MJS));
    expect(runs.map((c) => c.at(-1))).toEqual(['plan', 'check']);
    for (const run of runs) {
      const line = run.join(' ');
      for (const flag of ['--network none', '--read-only', '--cap-drop ALL', '--pull never', '--security-opt no-new-privileges', '--entrypoint node']) {
        expect(line).toContain(flag);
      }
      // H10: node is PID 1 of the container and has no SIGTERM handler, so tini (--init) forwards the signal
      // timeout sends; the name lets the cleanup remove a container the signal did not stop.
      expect(line).toContain('--init');
      expect(line).toMatch(/--name makrai-restore-test-\d+-seal /);
      // --mount type=bind, not -v: a missing source fails at once and creates nothing on the host (CR-2).
      expect(line).not.toMatch(/ -v /);
      expect(line).toContain('--mount type=bind,src=/usr/local/lib/makrai/seal-check.mjs,dst=/ops/ops/host/seal-check.mjs,readonly');
      expect(line).toContain('--mount type=bind,src=/usr/local/lib/makrai/integrity,dst=/ops/lib/integrity,readonly');
      // sealCheck.mjs imports ../findings/state.mjs (deriveFindingState): the one import outside lib/integrity/.
      expect(line).toContain('--mount type=bind,src=/usr/local/lib/makrai/findings,dst=/ops/lib/findings,readonly');
      expect(line).toContain(WEB_IMAGE_ID);
      expect(line).not.toContain('/srv/makrai/app');
    }
  });

  it('NFR-INT-07: the organisation ids reach the plan, the plan reaches psql, and psql\'s rows reach the check', () => {
    const r = runRestore({ orgIds: 'o1\no2', sealCheck: { code: 0, stdout: OK_SEALS } });
    expect(r.sealStdin.plan).toBe('o1\no2\n');
    expect(r.rowsStdin).toContain("SELECT 'plan-stand-in';");
    expect(r.sealStdin.check).toContain('ROWS-FROM-RESTORED-COPY');
    const ids = r.calls.find((c) => c.join(' ').includes('DISTINCT "orgId" FROM seals'))!;
    expect(ids).toContain('SELECT DISTINCT "orgId" FROM seals ORDER BY 1');
    const rows = r.calls.find((c) => c.includes('-f') && c.includes('ON_ERROR_STOP=1') && c.includes('-i'))!;
    expect(rows.slice(rows.indexOf('-X'))).toEqual(['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-']);
  });

  it('NFR-INT-07: a database with no seals still runs the check, on empty input, and passes', () => {
    const r = runRestore({ orgIds: '', sealCheck: { code: 0, stdout: 'seals=0 valid=0 mismatched=0 erased_fields=0 erased_files=0' } });
    expect(r.code, r.log).toBe(0);
    expect(r.sealStdin.plan).toBe('');
    expect(r.log).toContain('seals=0 valid=0');
  });

  it('NFR-INT-07 H10: every step of the seal check is bounded at 300 seconds', () => {
    const src = notComment(readFileSync(path.join(HOST, RESTORE), 'utf8'));
    const seals = src.slice(src.indexOf('STAGE=seals'), src.indexOf('STAGE=sizes'));
    expect(seals).not.toBe('');
    const calls = seals.split('\n').filter((l) => /docker (exec|run)|SEAL_RUN/.test(l) && !/^\s*SEAL_RUN=/.test(l));
    expect(calls.length).toBeGreaterThanOrEqual(4);
    // --kill-after: a process that ignores the first signal is killed ten seconds later (makrai-synthetic.sh does the same).
    for (const l of calls) expect(l, l).toMatch(/timeout --kill-after=10 300 /);
  });

  it('NFR-INT-07 H10: a check that never ends and ignores TERM fails the run with field seals within the bound, and its container is removed', () => {
    for (const hang of ['check', 'plan'] as const) {
      const t0 = Date.now();
      const r = runRestore({ hang, sealCheck: { code: 0, stdout: OK_SEALS } });
      expect(r.stdout, hang).toBe('RESTORE MISMATCH seals\n');
      expect(Date.now() - t0, `${hang}: the stand-in's fuse is 2 s and 1 s more to kill`).toBeLessThan(20_000);
      expect(r.timeouts.some((l) => /^--kill-after=10 300 docker run /.test(l)), hang).toBe(true);
      // The cleanup removes the seal container by name, whether or not the signal stopped it.
      expect(r.calls.some((c) => c[0] === 'rm' && c.includes('-f') && c.some((a) => /^makrai-restore-test-\d+-seal$/.test(a))), hang).toBe(true);
    }
  }, 60_000);

  it("NFR-INT-07 CR-4: the check must see every row of seals, or the run fails with field seals and the difference", () => {
    const ok = runRestore({ sealCheck: { code: 0, stdout: OK_SEALS }, sealCount: '3' });
    expect(ok.code, ok.log).toBe(0);
    expect(ok.log).toContain('seal_rows=3');
    const short = runRestore({ sealCheck: { code: 0, stdout: OK_SEALS }, sealCount: '5' });
    expect(short.stdout).toBe('RESTORE MISMATCH seals\n');
    expect(short.log).toMatch(/seals: .*5 .*3|seals: .*3 .*5/);
    const none = runRestore({ sealCheck: { code: 0, stdout: 'seals=0 valid=0 mismatched=0 erased_fields=0 erased_files=0' }, sealCount: '2' });
    expect(none.stdout, 'a row with a NULL or empty orgId is in the count and not in the check').toBe('RESTORE MISMATCH seals\n');
}, 30_000);

  it('NFR-INT-07: a seal check that times out fails the run with field seals', () => {
    const r = runRestore({ sealCheck: { code: 124, stdout: '' } });
    expect(r.stdout).toBe('RESTORE MISMATCH seals\n');
    expect(r.pings).toEqual([`${PING}/fail`]);
  });

  it('NFR-INT-07: a failed plan or a failed row export each fail the run with field seals', () => {
    for (const o of [{ planRc: 2 }, { rowsRc: 1 }]) {
      const r = runRestore(o);
      expect(r.stdout, JSON.stringify(o)).toBe('RESTORE MISMATCH seals\n');
    }
  });

  it('NFR-INT-07 NFR-PRIV-03: the rows from the restored copy reach the log and stdout nowhere', () => {
    const r = runRestore({ sealCheck: { code: 0, stdout: OK_SEALS } });
    expect(r.stdout + r.stderr + r.log).not.toContain('ROWS-FROM-RESTORED-COPY');
    expect(r.stdout).toBe('RESTORE MATCH\n');
  });

  it('NFR-REL-03: the restore log records the database size and the held and unattached bytes per organisation id', () => {
    const r = runRestore({ sizes: { db: '1048576', unattached: '2048', perOrg: 'o1|5000|2048' } });
    expect(r.log).toMatch(/db_bytes=1048576/);
    expect(r.log).toMatch(/unattached_bytes=2048/);
    expect(r.log).toMatch(/org=o1 held_bytes=5000 unattached_bytes=2048/);
    expect(r.log.trimEnd().split('\n').at(-1)).toMatch(/Restore test PASSED$/);
  });

  it('NFR-REL-03: a size query that returns something else than numbers fails the run with field sizes', () => {
    const r = runRestore({ sizes: { db: 'not-a-number' } });
    expect(r.stdout).toBe('RESTORE MISMATCH sizes\n');
  });
});

// ---------------------------------------------------------------------------------------------
// Task 5: install map and install text for the owner (NFR-OBS-02, NFR-INT-07, NFR-INT-08)
// ---------------------------------------------------------------------------------------------

describe('ops/host/README.md for the v0.6.0 host scripts (Task 5)', () => {
  const README = readFileSync(path.join(HOST, 'README.md'), 'utf8');
  const section = (heading: string): string => {
    const at = README.indexOf(`\n${heading}\n`);
    expect(at, `${heading} is a heading of the README`).toBeGreaterThan(-1);
    return README.slice(at + 1).split('\n## ')[0];
  };
  const flat = (t: string): string => t.replace(/\s+/g, ' ');

  it('NFR-OBS-02 NFR-INT-07 NFR-INT-08: the install map lists every new host file once, with its host path', () => {
    const map = README.split('## Install map')[1].split('\n## ')[0];
    const rows = (f: string): string[] => map.split('\n').filter((l) => l.startsWith(`| \`${f}\``));
    const want: Record<string, string> = {
      'ops/host/makrai-reminders.sh': '/usr/local/bin/makrai-reminders.sh',
      'ops/host/seal-check.mjs': '/usr/local/lib/makrai/seal-check.mjs',
      'lib/integrity/canonical.mjs': '/usr/local/lib/makrai/integrity/',
      'lib/integrity/sealCheck.mjs': '/usr/local/lib/makrai/integrity/',
      'lib/findings/state.mjs': '/usr/local/lib/makrai/findings/',
    };
    for (const [f, host] of Object.entries(want)) {
      expect(rows(f), f).toHaveLength(1);
      expect(rows(f)[0], f).toContain(host);
    }
    expect(rows('ops/host/makrai-reminders.sh')[0]).toContain('0755');
    expect(rows('lib/integrity/sealCheck.mjs')[0]).toContain('0644');
  });

  it('NFR-OBS-02: the reminder section names the check, the .env key, the cron line, the first run and the rollback', () => {
    const s = flat(section('## Hourly reminder job (v0.6.0)'));
    for (const t of ['period 1 hour', 'grace 2 hours', 'HC_REMINDER_PING_URL', 'setenv_secret', 'crontab.operator', '20 * * * * /usr/local/bin/makrai-reminders.sh', 'result=pass', '/srv/makrai/reminders.log', 'Rollback']) {
      expect(s, t).toContain(t);
    }
  });

  it('NFR-OBS-02: the reminder rollback pauses the cron line with the same comment-out and count pair as the synthetic journey', () => {
    const s = section('## Hourly reminder job (v0.6.0)');
    const block = [...s.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => b.includes('#v060-pause 20 '));
    expect(block, 'a fenced pause block').toBeDefined();
    expect(block).toContain("sed 's|^20 \\* \\* \\* \\* /usr/local/bin/makrai-reminders.sh|#v060-pause 20 * * * * /usr/local/bin/makrai-reminders.sh|'");
    expect(block).toContain("[ \"$(grep -c '^#v060-pause ' ");
    expect(block).toContain("crontab -u <operator> -l | grep -c '^#v060-pause '");
    expect(flat(s)).toContain('prints `1`');
  });

  it('NFR-INT-07: the seal-check section tells the owner to reinstall the copies on every deploy, so they never drift from the image', () => {
    const s = flat(section('## Seal check in the restore test (v0.6.0)'));
    expect(s).toContain('on every deploy');
    expect(s).toContain('never drift');
    expect(s).toContain('install the three files before the script');
  });

  it('NFR-INT-08: the audit-ship section gives the owner the command that shows the trusted unit field', () => {
    const s = flat(section('## Seal lines in the audit ship (v0.6.0)'));
    expect(s).toContain('_SYSTEMD_UNIT=docker.service');
    expect(s).toContain('journalctl -o verbose -n 1 CONTAINER_TAG=makrai/docker-nextjs-1');
  });

  it('NFR-INT-07: the seal-check section names the files, the line that shows the check ran and the rollback', () => {
    const s = flat(section('## Seal check in the restore test (v0.6.0)'));
    for (const t of ['/usr/local/lib/makrai/seal-check.mjs', '/usr/local/lib/makrai/integrity/', '/usr/local/lib/makrai/findings/', 'seals=', 'Restore test PASSED', 'sha256sum -c --strict', 'Rollback']) {
      expect(s, t).toContain(t);
    }
  });

  it('NFR-INT-08: the audit-ship section names the ship, the 65-minute off-site check and the rollback', () => {
    const s = flat(section('## Seal lines in the audit ship (v0.6.0)'));
    for (const t of ['makrai-auditlog-ship.sh', 'SEAL_CREATED', '65 minutes', 'sha256sum -c --strict', 'Rollback']) {
      expect(s, t).toContain(t);
    }
  });

  it('NFR-SEC-14: the new README sections hold no secret value', () => {
    expect(README).not.toMatch(/HC_REMINDER_PING_URL=https?:\/\//);
    expect(README).not.toMatch(/REMINDER_JOB_TOKEN=[A-Za-z0-9]/);
  });
});
