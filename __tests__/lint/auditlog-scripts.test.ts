import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { entryHash } from '../../ops/host/integrity-hash.mjs';

/**
 * The three Task 22 host scripts (RL 7.12, 7.13), run with every outside tool replaced by a
 * stand-in that records how it was called:
 *
 *   makrai-auditlog-ship.sh       hourly: journal -> gzip -> spool -> Storage Box, then prune
 *   makrai-auditlog-reconcile.sh  nightly: shipped files + integrity_log -> auditlog.mjs
 *   makrai-prefix-export.sh       once: the journal before R, scrubbed, one file per day
 *
 * `docker run ... node /ops/auditlog.mjs` is stood in for by the local node running the real
 * ops/host/auditlog.mjs, so the reconcile's verdict here is the real one. The Storage Box is a
 * directory. What these tests cannot show is that the real journal, rsync, Storage Box and
 * psql answer as the stand-ins do: step 4 of Task 22, on the server, does that.
 *
 * Every value is synthetic: 203.0.113.0/24 and 192.0.2.0/24 addresses, example.test mail, a
 * fingerprint of one repeated letter, and a ping URL that is not one.
 */

const HOST = path.resolve('ops/host');
const SHIP = 'makrai-auditlog-ship.sh';
const RECONCILE = 'makrai-auditlog-reconcile.sh';
const EXPORT = 'makrai-prefix-export.sh';
const MJS = path.join(HOST, 'auditlog.mjs');

const FP = `SHA256:${'A'.repeat(43)}`;
const IMAGE = `ghcr.io/example/web@sha256:${'c'.repeat(64)}`;
const TARGET = 'sub-user@box.example.test:';
const SHIP_PING = 'https://hc.example.test/ship-sentinel';
const RECONCILE_PING = 'https://hc.example.test/reconcile-sentinel';
const OWNER = 'owner@example.test';

type Sandbox = {
  dir: string;
  host: string;
  bin: string;
  rec: string;
  state: string;
  etc: string;
  remote: string;
  tmp: string;
};

function calls(file: string): string[][] {
  if (!existsSync(file)) return [];
  const out: string[][] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === 'CALL') out.push([]);
    else if (line !== '') out[out.length - 1].push(line);
  }
  return out;
}

const STUBS: Record<string, string> = {
  // The journal: export bytes from $STUB_JOURNAL; a cursor written where asked; for the
  // pre-fix export, the oldest entry and one JSON file per day.
  journalctl: `{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/journalctl"
[ -z "\${STUB_JOURNAL_FAIL:-}" ] || { echo "journalctl: stand-in failure" >&2; exit 1; }
cursor= since= oldest=
prev=
for a in "$@"; do
  case "$a" in
    --cursor-file=*) cursor=\${a#--cursor-file=} ;;
    --since=*) since=\${a#--since=} ;;
    +1) [ "$prev" = -n ] && oldest=1 ;;
  esac
  prev=$a
done
if [ -n "$oldest" ]; then
  [ -n "\${STUB_OLDEST_US:-}" ] && printf '{"__REALTIME_TIMESTAMP":"%s","_BOOT_ID":"b"}\\n' "$STUB_OLDEST_US"
  exit 0
fi
if [ -n "\${STUB_DAYS:-}" ]; then
  f="$STUB_DAYS/\${since:0:10}.json"
  [ -f "$f" ] && cat "$f"
  exit 0
fi
[ -n "\${STUB_JOURNAL:-}" ] && cat "$STUB_JOURNAL"
[ -n "$cursor" ] && printf 's=stand-in;i=%s\\n' "$RANDOM" > "$cursor"
exit 0`,

  // The Storage Box: --list-only lists $REMOTE; a remote source fetches the --include names
  // from it; a remote destination receives the local files given.
  rsync: `{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/rsync"
mode=push
for a in "$@"; do case "$a" in --list-only) mode=list ;; esac; done
dest=\${!#}
if [ "$mode" = push ] && [[ $dest != *:* ]]; then mode=fetch; fi
[ "\${STUB_RSYNC_FAIL:-}" != "$mode" ] || { echo "rsync: stand-in $mode failure" >&2; exit 23; }
case "$mode" in
  list)
    echo "drwx------          4,096 2026/10/15 01:05:02 ."
    for f in "$REMOTE"/*; do [ -f "$f" ] && echo "-rw-------          1,234 2026/10/15 01:05:02 $(basename "$f")"; done ;;
  fetch)
    for a in "$@"; do
      case "$a" in --include=*) n=\${a#--include=}; [ -f "$REMOTE/$n" ] && cp "$REMOTE/$n" "$dest" ;; esac
    done ;;
  push)
    for a in "$@"; do [ "$a" != "$dest" ] && [ -f "$a" ] && cp "$a" "$REMOTE/" ; done ;;
esac
exit 0`,

  // ssh to the box: only \`rm <path>\` is expected.
  ssh: `{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/ssh"
[ -z "\${STUB_SSH_FAIL:-}" ] || exit 255
n=$#
[ "\${@:n-1:1}" = rm ] || { echo "ssh stand-in: unexpected command" >&2; exit 9; }
rm -f "$REMOTE/$(basename "\${!n}")"`,

  // docker exec: psql, answering with $STUB_ROWS. docker run: the local node, on the real
  // auditlog.mjs, with the mount mapped to the repository.
  docker: `{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/docker"
case "$1" in
  exec)
    cat > "$REC/psql-stdin"
    [ -z "\${STUB_PSQL_FAIL:-}" ] || { echo "psql: FATAL: stand-in" >&2; exit 2; }
    cat "$STUB_ROWS" ;;
  run)
    shift
    while [ $# -gt 0 ] && [ "$1" != /ops/auditlog.mjs ]; do shift; done
    [ $# -gt 0 ] || { echo "docker stand-in: no /ops/auditlog.mjs" >&2; exit 125; }
    shift
    exec "$NODE" "$MJS" "$@" ;;
  *) exit 9 ;;
esac`,

  curl: `{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/curl-argv"
for a in "$@"; do [ "$a" = "--config" ] && { cat >> "$REC/curl-stdin"; echo >> "$REC/curl-stdin"; }; done
case "$*" in *'%{http_code}'*) printf '\\n200' ;; esac`,
};

function sandbox(): Sandbox {
  const dir = mkdtempSync(path.join(tmpdir(), 't22-scripts-'));
  const s = {
    dir,
    host: path.join(dir, 'host'),
    bin: path.join(dir, 'bin'),
    rec: path.join(dir, 'rec'),
    state: path.join(dir, 'state'),
    etc: path.join(dir, 'etc'),
    remote: path.join(dir, 'remote'),
    tmp: path.join(dir, 'tmp'),
  };
  for (const d of [s.host, s.bin, s.rec, s.state, s.etc, s.remote, s.tmp]) mkdirSync(d);
  for (const f of [SHIP, RECONCILE, EXPORT, 'email-shape.regex']) copyFileSync(path.join(HOST, f), path.join(s.host, f));
  // The real library, with only load_env replaced: the real one reads the server's .env.
  writeFileSync(
    path.join(s.host, 'makrai-lib.sh'),
    `. "${path.join(HOST, 'makrai-lib.sh')}"\nload_env() { export POSTGRES_USER=owner_role POSTGRES_DB=app_db; }\n`,
  );
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(path.join(s.bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path.join(s.bin, name), 0o755);
  }
  return s;
}

type Run = { status: number; stdout: string; stderr: string; journalctl: string[][]; rsync: string[][]; ssh: string[][]; docker: string[][]; curl: string; psqlStdin: string };

function run(s: Sandbox, script: string, args: string[] = [], env: Record<string, string> = {}): Run {
  const r = spawnSync('bash', [path.join(s.host, script), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    cwd: s.dir,
    env: {
      NODE_ENV: 'test',
      PATH: `${s.bin}:/usr/local/bin:/usr/bin:/bin`,
      HOME: s.dir,
      TMPDIR: s.tmp,
      REC: s.rec,
      REMOTE: s.remote,
      NODE: process.execPath,
      MJS,
      MAKRAI_STATE_DIR: s.state,
      MAKRAI_ETC_DIR: s.etc,
      OFFSITE_AUDIT_TARGET: TARGET,
      WEB_IMAGE: IMAGE,
      HC_AUDITSHIP_PING_URL: SHIP_PING,
      HC_RECONCILE_PING_URL: RECONCILE_PING,
      RESEND_API_KEY: 'k'.repeat(24),
      ADMIN_EMAIL: 'admin-sentinel@example.test',
      EMAIL_FROM_ADDRESS: 'sender-sentinel@example.test',
      ...env,
    },
  });
  const read = (f: string) => (existsSync(path.join(s.rec, f)) ? readFileSync(path.join(s.rec, f), 'utf8') : '');
  return {
    status: r.status ?? -1,
    stdout: r.stdout,
    stderr: r.stderr,
    journalctl: calls(path.join(s.rec, 'journalctl')),
    rsync: calls(path.join(s.rec, 'rsync')),
    ssh: calls(path.join(s.rec, 'ssh')),
    docker: calls(path.join(s.rec, 'docker')),
    curl: read('curl-stdin'),
    psqlStdin: read('psql-stdin'),
  };
}

function withSandbox<T>(fn: (s: Sandbox) => T): T {
  const s = sandbox();
  try {
    return fn(s);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
}

/** journalctl -o export, text fields only. */
function exportRecords(records: Record<string, string>[]): string {
  return records.map((r) => Object.entries(r).map(([k, v]) => `${k}=${v}`).join('\n') + '\n\n').join('');
}
const usAt = (iso: string) => String(Date.parse(iso) * 1000);
/** A shipped file's name for a time, as the ship writes it. */
const shippedName = (d: Date) => `auditlog-${d.toISOString().slice(0, 19).replace(/:/g, '')}Z.journal.gz`;

describe('makrai-auditlog-ship.sh', () => {
  const JOURNAL = exportRecords([
    { __CURSOR: 's=x;i=1', __REALTIME_TIMESTAMP: usAt('2026-10-15T00:30:00Z'), _PID: '4242', _COMM: 'sshd', MESSAGE: 'Accepted keyboard-interactive/pam for root from 203.0.113.7 port 50022 ssh2' },
  ]);

  it('exports the audit sources since 26 h ago on the first run, ships the file, empties the spool and pings', () => {
    withSandbox((s) => {
      writeFileSync(path.join(s.dir, 'journal'), JOURNAL);
      const r = run(s, SHIP, [], { STUB_JOURNAL: path.join(s.dir, 'journal') });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);

      expect(r.journalctl).toHaveLength(1);
      const argv = r.journalctl[0];
      // Each source as its own argv element, OR-ed with "+", exactly as the brief lists them.
      const terms = argv.slice(argv.indexOf('export') + 1);
      expect(terms).toEqual([
        '_COMM=sshd', '+', '_COMM=sshd-session', '+', '_COMM=sudo', '+', '_COMM=login', '+',
        '_COMM=passwd', '+', '_COMM=chpasswd', '+', 'SYSLOG_IDENTIFIER=makrai-break-glass',
      ]);
      expect(argv).toContain('--since=-26h');
      expect(argv.find((a) => a.startsWith('--cursor-file='))).toMatch(new RegExp(`^--cursor-file=${s.state}/auditlog\\.cursor`));

      // One file on the box, named by its UTC time, holding the export unchanged.
      const shipped = readdirSync(s.remote);
      expect(shipped).toHaveLength(1);
      expect(shipped[0]).toMatch(/^auditlog-\d{4}-\d{2}-\d{2}T\d{6}Z\.journal\.gz$/);
      expect(gunzipSync(readFileSync(path.join(s.remote, shipped[0]))).toString()).toBe(JOURNAL);
      expect(r.rsync.find((c) => c.includes(TARGET) && !c.includes('--list-only'))).toEqual(
        expect.arrayContaining(['-e', 'ssh -p 23 -i /root/.ssh/makrai_auditlog -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/root/.ssh/known_hosts']),
      );

      expect(readdirSync(path.join(s.state, 'auditlog-spool')), 'the spool is emptied after a good copy').toEqual([]);
      expect(readFileSync(path.join(s.state, 'auditlog.cursor'), 'utf8')).toMatch(/^s=stand-in;/);
      expect(r.curl).toBe(`url = "${SHIP_PING}"\n\n`);
      expect(r.stdout).toBe('shipped=1 deleted=0\n');
    });
  });

  it('reads on from the cursor afterwards, without --since', () => {
    withSandbox((s) => {
      writeFileSync(path.join(s.state, 'auditlog.cursor'), 's=earlier;i=1\n');
      const r = run(s, SHIP);
      expect(r.status).toBe(0);
      expect(r.journalctl[0].filter((a) => a.startsWith('--since'))).toEqual([]);
      // Nothing new still ships a file: the box shows the ship ran, and the reconcile can
      // tell a quiet hour from a dead ship.
      expect(readdirSync(s.remote)).toHaveLength(1);
    });
  });

  it('keeps the spool when the copy fails, and sends both files next time', () => {
    withSandbox((s) => {
      writeFileSync(path.join(s.dir, 'journal'), JOURNAL);
      const env = { STUB_JOURNAL: path.join(s.dir, 'journal') };
      const failedRun = run(s, SHIP, [], { ...env, STUB_RSYNC_FAIL: 'push' });
      expect(failedRun.status).not.toBe(0);
      expect(readdirSync(path.join(s.state, 'auditlog-spool'))).toHaveLength(1);
      expect(failedRun.curl).toContain(`url = "${SHIP_PING}/fail"`);
      expect(failedRun.curl).toContain('audit log ship failed');
      expect(readdirSync(s.remote)).toEqual([]);

      // A second later, so the two names differ.
      spawnSync('sleep', ['1.1']);
      const next = run(s, SHIP, [], env);
      expect(next.status).toBe(0);
      expect(readdirSync(s.remote)).toHaveLength(2);
      expect(readdirSync(path.join(s.state, 'auditlog-spool'))).toEqual([]);
    });
  });

  it('does not move the cursor, or leave a part file, when the export fails', () => {
    withSandbox((s) => {
      writeFileSync(path.join(s.state, 'auditlog.cursor'), 's=earlier;i=1\n');
      const r = run(s, SHIP, [], { STUB_JOURNAL_FAIL: '1' });
      expect(r.status).not.toBe(0);
      expect(readFileSync(path.join(s.state, 'auditlog.cursor'), 'utf8')).toBe('s=earlier;i=1\n');
      expect(readdirSync(path.join(s.state, 'auditlog-spool'))).toEqual([]);
      expect(readdirSync(s.state).filter((f) => f.includes('next') || f.includes('part'))).toEqual([]);
      expect(r.curl).toContain(`url = "${SHIP_PING}/fail"`);
    });
  });

  it('deletes from the box only the files expiredNames() names, by exact name', () => {
    withSandbox((s) => {
      const old = 'auditlog-2020-01-01T000500Z.journal.gz';
      const oldPrefix = 'pre-fix-2020-01-01.json.gz';
      const recent = shippedName(new Date());
      const stranger = 'notes-2020-01-01.txt';
      for (const f of [old, oldPrefix, recent, stranger]) writeFileSync(path.join(s.remote, f), 'x');
      const r = run(s, SHIP);
      expect(r.status).toBe(0);
      const left = readdirSync(s.remote);
      expect(left).not.toContain(old);
      expect(left).not.toContain(oldPrefix);
      expect(left).toEqual(expect.arrayContaining([recent, stranger]));
      expect(r.ssh.map((c) => c.slice(-3))).toEqual([
        ['sub-user@box.example.test', 'rm', old],
        ['sub-user@box.example.test', 'rm', oldPrefix],
      ]);
      expect(r.stdout).toBe('shipped=1 deleted=2\n');
      // The node that chose them ran in the web image, offline, with ops/host read-only.
      const dockerRun = r.docker.find((c) => c[0] === 'run') as string[];
      expect(dockerRun).toEqual(expect.arrayContaining(['--rm', '-i', '--network', 'none', '-v', '/srv/makrai/app/ops/host:/ops:ro', '--entrypoint', 'node', IMAGE, '/ops/auditlog.mjs', 'expired']));
    });
  });

  it('deletes nothing, and fails, when more files expire at once than a clock error would explain', () => {
    withSandbox((s) => {
      for (let i = 0; i < 61; i += 1) writeFileSync(path.join(s.remote, `auditlog-2020-01-01T${String(i).padStart(4, '0')}00Z.journal.gz`), 'x');
      const r = run(s, SHIP);
      expect(r.status).not.toBe(0);
      expect(r.ssh).toEqual([]);
      expect(readdirSync(s.remote).length).toBe(62);
      expect(r.curl).toContain('audit log ship failed');
    });
  });

  it('ships first, then fails loudly when WEB_IMAGE is empty or not pinned, since it cannot prune', () => {
    for (const image of ['', 'ghcr.io/example/web:latest']) {
      withSandbox((s) => {
        const r = run(s, SHIP, [], { WEB_IMAGE: image });
        expect(r.status).not.toBe(0);
        expect(readdirSync(s.remote), 'the hour was still shipped').toHaveLength(1);
        expect(r.docker).toEqual([]);
        expect(r.curl).toContain(`url = "${SHIP_PING}/fail"`);
        expect(r.stderr).toContain('WEB_IMAGE');
      });
    }
  });

  it('refuses a target that is not user@host: or user@host:dir/', () => {
    withSandbox((s) => {
      const r = run(s, SHIP, [], { OFFSITE_AUDIT_TARGET: 'box.example.test:/abs' });
      expect(r.status).not.toBe(0);
      expect(r.rsync).toEqual([]);
    });
  });
});

describe('makrai-auditlog-reconcile.sh', () => {
  const now = Date.now();
  const ago = (h: number) => new Date(now - h * 3_600_000);
  const iso = (d: Date) => d.toISOString();

  /** A console break-glass login 3 h ago, its row and shipped line, and a two-factor SSH login. */
  function arrange(s: Sandbox, o: { rows?: unknown[]; extra?: Record<string, string>[]; files?: boolean } = {}) {
    const loginAt = ago(3);
    const rowAt = new Date(loginAt.getTime() + 2_000);
    const r = { seq: 7, prevHash: 'd'.repeat(64), atUtc: iso(rowAt), kind: 'break_glass.open', actorRef: 'console:root', detailText: '{"tty": "tty1", "channel": "hetzner-console"}' };
    const row = { ...r, hash: entryHash(r) };
    const journal = exportRecords([
      { __CURSOR: 'c1', __REALTIME_TIMESTAMP: usAt(iso(loginAt)), _PID: '900', _COMM: 'login', SYSLOG_IDENTIFIER: 'login', MESSAGE: 'pam_unix(login:session): session opened for user root(uid=0) by root(uid=0)' },
      { __CURSOR: 'c2', __REALTIME_TIMESTAMP: usAt(iso(new Date(rowAt.getTime() + 15_000))), _PID: '901', _COMM: 'logger', SYSLOG_IDENTIFIER: 'makrai-break-glass', MESSAGE: `entry=0f8fad5b-d9cb-469f-a165-70867728950e seq=7 hash=${row.hash} notice=sent` },
      { __CURSOR: 'c3', __REALTIME_TIMESTAMP: usAt(iso(ago(2))), _PID: '4242', _COMM: 'sshd', SYSLOG_IDENTIFIER: 'sshd', MESSAGE: `Partial publickey for root from 203.0.113.7 port 50022 ssh2: ED25519 ${FP}` },
      { __CURSOR: 'c4', __REALTIME_TIMESTAMP: usAt(iso(new Date(ago(2).getTime() + 9_000))), _PID: '4242', _COMM: 'sshd', SYSLOG_IDENTIFIER: 'sshd', MESSAGE: 'Accepted keyboard-interactive/pam for root from 203.0.113.7 port 50022 ssh2' },
      ...(o.extra ?? []),
    ]);
    if (o.files !== false) {
      // The journal split over two shipped files, as two hourly runs would; and the same
      // records shipped twice (a run that died after the copy and before moving the cursor),
      // which must not count twice. An old file outside the window is never fetched.
      writeFileSync(path.join(s.remote, shippedName(ago(2.5))), gzipSync(journal));
      writeFileSync(path.join(s.remote, shippedName(ago(1))), gzipSync(journal));
      writeFileSync(path.join(s.remote, shippedName(ago(40))), gzipSync('not even export data'));
    }
    writeFileSync(path.join(s.dir, 'rows.json'), `${JSON.stringify(o.rows ?? [row])}\n`);
    writeFileSync(path.join(s.etc, 'allowed-keys.fp'), `${FP} operator\n`);
    writeFileSync(path.join(s.etc, 'ssh-two-factor-since'), '2026-10-14T09:35:12Z\n');
    return { STUB_ROWS: path.join(s.dir, 'rows.json') };
  }

  const COUNTS = /^records=\d+ rows=\d+ matched=\d+ consoleLoginsWithoutEntry=\d+ entriesWithoutLogin=\d+ unknownKeyLogins=\d+ singleFactorLogins=\d+ chainBreaks=\d+ hashMismatches=\d+ noticeFailures=\d+ sudoToRoot=\d+ operatorSessions=\d+ rootPasswordChanges=\d+ rowsWithoutShipped=\d+$/;

  it('passes a clean window, pings, mails the two counts, and ends with the counts line', () => {
    withSandbox((s) => {
      const r = run(s, RECONCILE, [], arrange(s));
      expect(r.status, r.stderr).toBe(0);
      const last = r.stdout.trimEnd().split('\n').at(-1) as string;
      expect(last).toMatch(COUNTS);
      expect(last).toContain('records=4 rows=1 matched=1 consoleLoginsWithoutEntry=0 entriesWithoutLogin=0 unknownKeyLogins=0 singleFactorLogins=0');
      expect(last).toContain('operatorSessions=1 rootPasswordChanges=0 rowsWithoutShipped=0');
      expect(r.stdout.trimEnd().split('\n'), 'stdout is the counts line and nothing else').toHaveLength(1);
      expect(r.curl).toContain(`url = "${RECONCILE_PING}"\n`);
      expect(r.curl).not.toContain('/fail');
      // The daily mail carries the two counts the owner reviews (F-30), and no other data.
      expect(r.curl).toContain('audit reconcile passed: operatorSessions=1 rootPasswordChanges=0');
      expect(r.curl).not.toContain('203.0.113');
      expect(r.curl).not.toContain(FP);
    });
  });

  it('fetches only the shipped files from the last 26 h, and asks psql for the same window', () => {
    withSandbox((s) => {
      const r = run(s, RECONCILE, [], arrange(s));
      expect(r.status, r.stderr).toBe(0);
      const fetch = r.rsync.find((c) => c.some((a) => a.startsWith('--include='))) as string[];
      expect(fetch.filter((a) => a.startsWith('--include=')).sort()).toEqual(
        [shippedName(ago(2.5)), shippedName(ago(1))].map((n) => `--include=${n}`).sort(),
      );
      expect(fetch).toContain("--exclude=*");
      // psql reads the rows with the to_char rendering the hash covers, between the same
      // two instants the journal lines are cut to.
      expect(r.psqlStdin).toContain(`to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
      expect(r.psqlStdin).toContain('detail::text');
      expect(r.psqlStdin).toMatch(/at >= :'since'::timestamptz and at < :'until'::timestamptz/);
      const exec = r.docker.find((c) => c[0] === 'exec') as string[];
      const since = exec.find((a) => a.startsWith('since='))?.slice(6) as string;
      const until = exec.find((a) => a.startsWith('until='))?.slice(6) as string;
      expect(Math.abs(Date.parse(since) - (now - 26 * 3_600_000))).toBeLessThan(120_000);
      // The window ends where the shipped evidence ends: the newest file's time.
      expect(until).toBe(`${ago(1).toISOString().slice(0, 19)}Z`);
      const run_ = r.docker.find((c) => c[0] === 'run') as string[];
      expect(run_).toEqual(expect.arrayContaining(['--network', 'none', '-v', '/srv/makrai/app/ops/host:/ops:ro', '--entrypoint', 'node', IMAGE, '/ops/auditlog.mjs', 'reconcile']));
    });
  });

  it('fails on a finding: /fail, an alert with the two counts, and the counts line last', () => {
    withSandbox((s) => {
      // The row is gone: the console login and the shipped line have nothing to meet.
      const r = run(s, RECONCILE, [], arrange(s, { rows: [] }));
      expect(r.status).toBe(1);
      expect(r.stdout.trimEnd().split('\n').at(-1)).toMatch(COUNTS);
      expect(r.stdout).toContain(' consoleLoginsWithoutEntry=1 ');
      expect(r.curl).toContain(`url = "${RECONCILE_PING}/fail"`);
      expect(r.curl).toContain('audit reconcile FAILED: operatorSessions=1 rootPasswordChanges=0');
    });
  });

  it('reports root password changes and counts sessions in the mail, without failing', () => {
    withSandbox((s) => {
      const extra = [{ __CURSOR: 'c9', __REALTIME_TIMESTAMP: usAt(iso(ago(1.5))), _PID: '950', _COMM: 'chpasswd', SYSLOG_IDENTIFIER: 'chpasswd', MESSAGE: 'pam_unix(chpasswd:chauthtok): password changed for root' }];
      const r = run(s, RECONCILE, [], arrange(s, { extra }));
      expect(r.status, r.stderr).toBe(0);
      expect(r.curl).toContain('audit reconcile passed: operatorSessions=1 rootPasswordChanges=1');
    });
  });

  it('reads the switch as absent when its file is', () => {
    withSandbox((s) => {
      const env = arrange(s);
      rmSync(path.join(s.etc, 'ssh-two-factor-since'));
      const r = run(s, RECONCILE, [], env);
      expect(r.status, r.stderr).toBe(0);
    });
  });

  it.each([
    ['WEB_IMAGE is empty', { WEB_IMAGE: '' }, 'WEB_IMAGE'],
    ['WEB_IMAGE is a tag, not a digest', { WEB_IMAGE: 'ghcr.io/example/web:latest' }, 'WEB_IMAGE'],
    ['the box cannot be listed', { STUB_RSYNC_FAIL: 'list' }, 'list'],
    ['the files cannot be fetched', { STUB_RSYNC_FAIL: 'fetch' }, 'fetch'],
    ['psql fails', { STUB_PSQL_FAIL: '1' }, 'integrity_log'],
  ])('fails loudly, never silently, when %s', (_name, env, says) => {
    withSandbox((s) => {
      const r = run(s, RECONCILE, [], { ...arrange(s), ...env });
      expect(r.status).toBe(3);
      expect(r.stdout, 'no counts: nothing was reconciled').toBe('');
      expect(r.stderr).toContain(says);
      expect(r.curl).toContain(`url = "${RECONCILE_PING}/fail"`);
      expect(r.curl).toContain('audit reconcile could not run');
      expect(r.stderr).not.toContain('FATAL');
    });
  });

  it('fails when no file was shipped in the last 26 h, rather than pass on nothing', () => {
    withSandbox((s) => {
      const env = arrange(s, { files: false });
      writeFileSync(path.join(s.remote, shippedName(ago(40))), gzipSync(''));
      const r = run(s, RECONCILE, [], env);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('no shipped file');
      expect(r.docker.filter((c) => c[0] === 'run')).toEqual([]);
    });
  });

  it('fails when the allowed-keys list is missing', () => {
    withSandbox((s) => {
      const env = arrange(s);
      rmSync(path.join(s.etc, 'allowed-keys.fp'));
      const r = run(s, RECONCILE, [], env);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('allowed-keys.fp');
    });
  });

  it('leaves nothing in its working directory', () => {
    withSandbox((s) => {
      run(s, RECONCILE, [], arrange(s));
      expect(readdirSync(s.tmp)).toEqual([]);
    });
  });
});

describe('makrai-prefix-export.sh', () => {
  const R = '2026-10-14T05:07:16Z';
  const ADDRESS = OWNER;
  const day1 = [
    '{"MESSAGE":"GET /health 200","__REALTIME_TIMESTAMP":"1"}',
    `{"MESSAGE":"Invalid user ${ADDRESS.toUpperCase()} from 203.0.113.9","__REALTIME_TIMESTAMP":"2"}`,
    '{"MESSAGE":"GET /login 200 \\"Mozilla/5.0 (+http://bots.example.org/crawler@bots.example.org)\\"","__REALTIME_TIMESTAMP":"3"}',
    '{"MESSAGE":[71,69,84,32],"__REALTIME_TIMESTAMP":"4"}',
    '{"MESSAGE":"GET /invitations/0123abcd/accept 200 and /api/v1/invitations/ffee99?x=1","__REALTIME_TIMESTAMP":"5"}',
  ].join('\n') + '\n';
  const day2 = '{"MESSAGE":"GET /health 200","__REALTIME_TIMESTAMP":"6"}\n';

  /** A stand-in email scan beside the script: --write-patterns writes the list; --file scans like the real one. */
  function arrange(s: Sandbox, scanBody?: string) {
    writeFileSync(
      path.join(s.host, 'makrai-email-scan.sh'),
      `#!/usr/bin/env bash
{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/scan"
case "$1" in
  --write-patterns) [ -n "\${STUB_SCAN_REFUSE:-}" ] && exit 2; printf '%s\\n' '${ADDRESS}' > "$2"; echo patterns=1 ;;
  --file) ${scanBody ?? `n=$(gzip -dc "$2" | grep -ciF '@' || true); echo "patterns=1 account_hits=0 shape_hits=$n shape_hits_nginx=0"; [ "$n" -eq 0 ]`} ;;
esac`,
    );
    chmodSync(path.join(s.host, 'makrai-email-scan.sh'), 0o755);
    const days = path.join(s.dir, 'days');
    mkdirSync(days);
    writeFileSync(path.join(days, '2026-10-13.json'), day1);
    writeFileSync(path.join(days, '2026-10-14.json'), day2);
    return { STUB_DAYS: days, STUB_OLDEST_US: usAt('2026-10-13T06:00:00Z') };
  }

  it('writes one scrubbed file per day, checks each with the email scan, ships them, and prints counts only', () => {
    withSandbox((s) => {
      const r = run(s, EXPORT, [R], arrange(s));
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(
        'patterns=1\npre-fix-2026-10-13 lines=5 kept=2 removed=3\npre-fix-2026-10-14 lines=1 kept=1 removed=0\ndays=2 shipped=2\n',
      );
      expect(readdirSync(s.remote).sort()).toEqual(['pre-fix-2026-10-13.json.gz', 'pre-fix-2026-10-14.json.gz']);
      const kept = gunzipSync(readFileSync(path.join(s.remote, 'pre-fix-2026-10-13.json.gz'))).toString();
      expect(kept).toBe(
        '{"MESSAGE":"GET /health 200","__REALTIME_TIMESTAMP":"1"}\n' +
          '{"MESSAGE":"GET /invitations/[token]/accept 200 and /api/v1/invitations/[token]?x=1","__REALTIME_TIMESTAMP":"5"}\n',
      );
      // The local copies go once shipped: the box's prune is what keeps them 90 days.
      expect(readdirSync(path.join(s.state, 'prefix-export'))).toEqual([]);
      expect(readdirSync(s.tmp), 'the pattern list is gone').toEqual([]);
    });
  });

  it('reads each day whole, up to R and no further', () => {
    withSandbox((s) => {
      const r = run(s, EXPORT, [R], arrange(s));
      const days = r.journalctl.filter((c) => c.some((a) => a.startsWith('--since=')));
      const windows = days.map((c) => [c.find((a) => a.startsWith('--since=')), c.find((a) => a.startsWith('--until='))]);
      expect([...new Set(windows.map((w) => JSON.stringify(w)))].map((w) => JSON.parse(w))).toEqual([
        ['--since=2026-10-13 00:00:00 UTC', '--until=2026-10-13 23:59:59.999999 UTC'],
        ['--since=2026-10-14 00:00:00 UTC', '--until=2026-10-14 05:07:16 UTC'],
      ]);
      for (const c of days) expect(c).toEqual(expect.arrayContaining(['-o', 'json', '--all']));
    });
  });

  it('ships nothing when the scan finds anything in any day', () => {
    withSandbox((s) => {
      const r = run(s, EXPORT, [R], arrange(s, 'echo "patterns=1 account_hits=1 shape_hits=0 shape_hits_nginx=0"; exit 1'));
      expect(r.status).not.toBe(0);
      expect(readdirSync(s.remote)).toEqual([]);
      expect(r.stdout).not.toContain(ADDRESS);
      expect(r.stderr).not.toContain(ADDRESS);
    });
  });

  it('stops when the scan refuses to write the pattern list', () => {
    withSandbox((s) => {
      const r = run(s, EXPORT, [R], { ...arrange(s), STUB_SCAN_REFUSE: '1' });
      expect(r.status).not.toBe(0);
      expect(r.journalctl).toEqual([]);
      expect(readdirSync(s.remote)).toEqual([]);
    });
  });

  it.each([[[]], [['not a time']], [[R, 'extra']]])('refuses arguments %j', (args) => {
    withSandbox((s) => {
      const r = run(s, EXPORT, args, arrange(s));
      expect(r.status).toBe(64);
      expect(r.journalctl).toEqual([]);
    });
  });
});
