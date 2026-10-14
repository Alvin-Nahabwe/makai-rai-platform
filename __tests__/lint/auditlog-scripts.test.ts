import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 * The scripts use the REAL makrai-lib.sh, and read their settings from a .env file written
 * here, through the library's text reader (read_env): root never executes that file. `docker
 * run ... node /ops/auditlog.mjs` is stood in for by the local node running the real
 * ops/host/auditlog.mjs, so the reconcile's verdict is the real one. The Storage Box is a
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
const SSH_E = 'ssh -p 23 -i /root/.ssh/makrai_auditlog -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/root/.ssh/known_hosts';
const MOUNT = '/usr/local/lib/makrai:/ops:ro';

type Sandbox = { dir: string; host: string; bin: string; rec: string; state: string; etc: string; remote: string; tmp: string };

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

  // gzip: the real one, unless told to fail while compressing (it still reads its input).
  gzip: `if [ -n "\${STUB_GZIP_FAIL:-}" ] && [ "\${1:-}" != -dc ]; then cat >/dev/null; echo "gzip: stand-in failure" >&2; exit 1; fi
exec /bin/gzip "$@"`,

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

  // docker exec: psql, answering with $STUB_DB. docker run: the local node, on the real
  // auditlog.mjs, with the mount mapped to the repository.
  docker: `{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/docker"
case "$1" in
  exec)
    cat > "$REC/psql-stdin"
    [ -z "\${STUB_PSQL_FAIL:-}" ] || { echo "psql: FATAL: stand-in" >&2; exit 2; }
    cat "$STUB_DB" ;;
  run)
    shift
    while [ $# -gt 0 ] && [ "$1" != /ops/auditlog.mjs ]; do shift; done
    [ $# -gt 0 ] || { echo "docker stand-in: no /ops/auditlog.mjs" >&2; exit 125; }
    shift
    exec "$NODE" "$MJS" "$@" ;;
  *) exit 9 ;;
esac`,

  // The clock: the real date, shifted by $STUB_DATE_OFFSET seconds when it reads "now" (no
  // -d, -f or -r): a clock that jumped. Conversions of a given time are left alone.
  date: `if [ -n "\${STUB_DATE_OFFSET:-}" ]; then
  for a in "$@"; do case "$a" in -d|-d*|--date*|-f|-f*|--file*|-r|-r*|--reference*) exec /usr/bin/date "$@" ;; esac; done
  exec /usr/bin/date -d "@$(( $(/usr/bin/date +%s) + STUB_DATE_OFFSET ))" "$@"
fi
exec /usr/bin/date "$@"`,

  curl: `{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/curl-argv"
for a in "$@"; do [ "$a" = "--config" ] && { cat >> "$REC/curl-stdin"; echo >> "$REC/curl-stdin"; }; done
case "$*" in *'%{http_code}'*) printf '\\n200' ;; esac`,
};

function sandbox(): Sandbox {
  const dir = mkdtempSync(path.join(tmpdir(), 'auditlog-scripts-'));
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
  // The scripts, the expression and the real library, side by side as installed.
  for (const f of [SHIP, RECONCILE, EXPORT, 'email-shape.regex', 'makrai-lib.sh']) copyFileSync(path.join(HOST, f), path.join(s.host, f));
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(path.join(s.bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path.join(s.bin, name), 0o755);
  }
  return s;
}

/**
 * The server .env, as the owner writes it: some values quoted, one with a trailing comment.
 * A key set to null is left out.
 */
const DOTENV: Record<string, string> = {
  OFFSITE_AUDIT_TARGET: TARGET,
  WEB_IMAGE: `"${IMAGE}"`,
  HC_AUDITSHIP_PING_URL: SHIP_PING,
  HC_RECONCILE_PING_URL: RECONCILE_PING,
  RESEND_API_KEY: `'${'k'.repeat(24)}'`,
  ADMIN_EMAIL: 'admin-sentinel@example.test',
  EMAIL_FROM_ADDRESS: 'sender-sentinel@example.test # the platform sender',
  POSTGRES_USER: 'owner_role',
  POSTGRES_DB: 'app_db',
};

type Opts = { env?: Record<string, string>; dotenv?: Record<string, string | null>; extraDotenv?: string };
type Run = { status: number; stdout: string; stderr: string; journalctl: string[][]; rsync: string[][]; ssh: string[][]; docker: string[][]; curl: string; psqlStdin: string };

function run(s: Sandbox, script: string, args: string[] = [], o: Opts = {}): Run {
  const merged = { ...DOTENV, ...o.dotenv };
  const lines = Object.entries(merged).flatMap(([k, v]) => (v === null ? [] : [`${k}=${v}`]));
  writeFileSync(path.join(s.dir, '.env'), `${lines.join('\n')}\n${o.extraDotenv ?? ''}`);
  const r = spawnSync('bash', [path.join(s.host, script), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    cwd: s.dir,
    // Nothing from the .env is in the environment: every value must come through read_env.
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
      MAKRAI_ENV_FILE: path.join(s.dir, '.env'),
      ...o.env,
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
const isoSecond = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;
/** Forget what the stand-ins recorded, between two runs in one sandbox. */
const clearRec = (s: Sandbox) => {
  for (const f of readdirSync(s.rec)) rmSync(path.join(s.rec, f));
};

/**
 * The README's command for clearing a delete hold (part C), exactly as the owner pastes it, with
 * only /var/lib/makrai moved into the sandbox (S3-4, T22-R3a).
 */
function readmeClear(s: Sandbox) {
  const readme = readFileSync(path.join(HOST, 'README.md'), 'utf8');
  const blocks = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const block = blocks.filter((b) => /^rm \/var\/lib\/makrai\/auditlog-delete-hold\b/m.test(b));
  expect(block, 'one README block clears the hold').toHaveLength(1);
  const local = block[0].replaceAll('/var/lib/makrai/', `${s.state}/`);
  expect(local).not.toContain('/var/lib/makrai');
  const r = spawnSync('bash', ['-c', local], { encoding: 'utf8', env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: s.dir } });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe('makrai-lib.sh read_env: the .env is read as text, never executed (T22-3)', () => {
  it('takes each named key literally, strips quotes and a trailing comment, and runs nothing', () => {
    withSandbox((s) => {
      const env = path.join(s.dir, '.env');
      writeFileSync(
        env,
        [
          `A=$(touch ${s.dir}/pwned-a)`,
          `B=\`touch ${s.dir}/pwned-b\``,
          `$(touch ${s.dir}/pwned-line)`,
          `C="quoted $(touch ${s.dir}/pwned-c) value"`,
          "D='single'",
          'E=plain # a comment',
          'F=first',
          'F=last',
          'G=unasked',
          '',
        ].join('\n'),
      );
      const r = spawnSync(
        'bash',
        ['-c', `. "${path.join(HOST, 'makrai-lib.sh')}"; read_env A B C D E F H; for k in A B C D E F H G; do printf '%s=[%s]\\n' "$k" "\${!k-unset}"; done`],
        { encoding: 'utf8', env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: s.dir, MAKRAI_ENV_FILE: env, H: 'inherited', G: 'from-env' } },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.split('\n').filter(Boolean)).toEqual([
        `A=[$(touch ${s.dir}/pwned-a)]`,
        `B=[\`touch ${s.dir}/pwned-b\`]`,
        `C=[quoted $(touch ${s.dir}/pwned-c) value]`,
        'D=[single]',
        'E=[plain]',
        'F=[last]',
        // Asked for and absent from the file: unset, whatever the environment held.
        'H=[unset]',
        // Not asked for: neither read nor touched.
        'G=[from-env]',
      ]);
      expect(readdirSync(s.dir).filter((f) => f.startsWith('pwned'))).toEqual([]);
    });
  });

  it('fails when the file cannot be read', () => {
    const r = spawnSync('bash', ['-c', `. "${path.join(HOST, 'makrai-lib.sh')}"; read_env A`], {
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HOME: '/nonexistent', MAKRAI_ENV_FILE: '/nonexistent/.env' },
    });
    expect(r.status).not.toBe(0);
  });

  it('runs nothing from the .env when a root job reads it', () => {
    withSandbox((s) => {
      const extraDotenv = [`X=$(touch ${s.dir}/pwned-x)`, `\`touch ${s.dir}/pwned-y\``, `$(touch ${s.dir}/pwned-z)`].join('\n') + '\n';
      const ok = run(s, SHIP, [], { extraDotenv });
      expect(ok.status, ok.stderr).toBe(0);
      // A key the job needs, set to a command: read as the literal text, and refused as a value.
      const bad = run(s, SHIP, [], { dotenv: { WEB_IMAGE: `$(touch ${s.dir}/pwned-w)` } });
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toContain('WEB_IMAGE is not pinned by digest');
      expect(readdirSync(s.dir).filter((f) => f.startsWith('pwned'))).toEqual([]);
    });
  });
});

describe('makrai-auditlog-ship.sh', () => {
  const JOURNAL = exportRecords([
    { __CURSOR: 's=x;i=1', __REALTIME_TIMESTAMP: usAt('2026-10-15T00:30:00Z'), _PID: '4242', _COMM: 'sshd', MESSAGE: 'Accepted keyboard-interactive/pam for root from 203.0.113.7 port 50022 ssh2' },
  ]);

  const dayName = (daysAgo: number, hhmm = '0005') => `auditlog-${new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)}T${hhmm}00Z.journal.gz`;
  /** The box's ordinary history: one file a day at 00:05, from `fromDaysAgo` to `toDaysAgo`. */
  const cadence = (s: Sandbox, fromDaysAgo: number, toDaysAgo: number) => {
    for (let d = fromDaysAgo; d >= toDaysAgo; d -= 1) writeFileSync(path.join(s.remote, dayName(d)), 'x');
  };
  const LAST_RUN = (s: Sandbox) => path.join(s.state, 'auditlog-last-run');
  const HOLD = (s: Sandbox) => path.join(s.state, 'auditlog-delete-hold');
  const HOLD_CLEARED = (s: Sandbox) => path.join(s.state, 'auditlog-hold-cleared');
  const LAST_NAME = (s: Sandbox) => path.join(s.state, 'auditlog-last-name');
  /** The names on the box that were not there before, in order. */
  const newNames = (s: Sandbox, before: string[]) => readdirSync(s.remote).filter((f) => !before.includes(f)).sort();
  const DAY_S = 86_400;

  it('exports the audit sources since 26 h ago on the first run, ships the file, empties the spool and pings', () => {
    withSandbox((s) => {
      writeFileSync(path.join(s.dir, 'journal'), JOURNAL);
      const r = run(s, SHIP, [], { env: { STUB_JOURNAL: path.join(s.dir, 'journal') } });
      expect(r.status, r.stderr).toBe(0);

      expect(r.journalctl).toHaveLength(1);
      const argv = r.journalctl[0];
      // Each source as its own argv element, OR-ed with "+", exactly as the brief lists them.
      const terms = argv.slice(argv.indexOf('export') + 1);
      expect(terms).toEqual([
        '_COMM=sshd', '+', '_COMM=sshd-session', '+', '_COMM=sudo', '+', '_COMM=sudoedit', '+', '_COMM=su', '+',
        // By executable too: _COMM is whatever name the caller ran the binary under (L-F1).
        // polkit's agent helper logs every polkit authentication failure (L3-1).
        '_EXE=/usr/bin/sudo', '+', '_EXE=/usr/bin/su', '+', '_EXE=/usr/bin/pkexec', '+',
        '_EXE=/usr/lib/polkit-1/polkit-agent-helper-1', '+',
        // And by content: every authpriv line, whatever process journald credits it to (L4-1).
        'SYSLOG_FACILITY=10', '+', '_COMM=login', '+',
        '_COMM=passwd', '+', '_COMM=chpasswd', '+', 'SYSLOG_IDENTIFIER=makrai-break-glass',
      ]);
      expect(argv).toContain('--since=-26h');
      expect(argv.find((a) => a.startsWith('--cursor-file='))).toMatch(new RegExp(`^--cursor-file=${s.state}/auditlog\\.cursor`));

      // One file on the box, named by its UTC time, holding the export unchanged.
      const shipped = readdirSync(s.remote);
      expect(shipped).toHaveLength(1);
      expect(shipped[0]).toMatch(/^auditlog-\d{4}-\d{2}-\d{2}T\d{6}Z\.journal\.gz$/);
      expect(gunzipSync(readFileSync(path.join(s.remote, shipped[0]))).toString()).toBe(JOURNAL);
      expect(r.rsync.find((c) => c.includes(TARGET) && !c.includes('--list-only'))).toEqual(expect.arrayContaining(['-e', SSH_E]));

      expect(readdirSync(path.join(s.state, 'auditlog-spool')), 'the spool is emptied after a good copy').toEqual([]);
      expect(readFileSync(path.join(s.state, 'auditlog.cursor'), 'utf8')).toMatch(/^s=stand-in;/);
      expect(r.curl).toBe(`url = "${SHIP_PING}"\n\n`);
      expect(r.stdout).toBe('shipped=1 deleted=0 pending=0\n');
    });
  });

  it('reads on from the cursor afterwards, without --since', () => {
    withSandbox((s) => {
      writeFileSync(path.join(s.state, 'auditlog.cursor'), 's=earlier;i=1\n');
      const r = run(s, SHIP);
      expect(r.status, r.stderr).toBe(0);
      expect(r.journalctl[0].filter((a) => a.startsWith('--since'))).toEqual([]);
      // Nothing new still ships a file: the box shows the ship ran.
      expect(readdirSync(s.remote)).toHaveLength(1);
    });
  });

  it('keeps the spool when the copy fails, and sends both files next time', () => {
    withSandbox((s) => {
      writeFileSync(path.join(s.dir, 'journal'), JOURNAL);
      const env = { STUB_JOURNAL: path.join(s.dir, 'journal') };
      const failedRun = run(s, SHIP, [], { env: { ...env, STUB_RSYNC_FAIL: 'push' } });
      expect(failedRun.status).not.toBe(0);
      expect(readdirSync(path.join(s.state, 'auditlog-spool'))).toHaveLength(1);
      expect(failedRun.curl).toContain(`url = "${SHIP_PING}/fail"`);
      expect(failedRun.curl).toContain('audit log ship failed');
      expect(readdirSync(s.remote)).toEqual([]);

      // A second later, so the two names differ.
      spawnSync('sleep', ['1.1']);
      const next = run(s, SHIP, [], { env });
      expect(next.status, next.stderr).toBe(0);
      expect(readdirSync(s.remote)).toHaveLength(2);
      expect(readdirSync(path.join(s.state, 'auditlog-spool'))).toEqual([]);
    });
  });

  it('does not move the cursor, or leave a part file, when the export fails', () => {
    withSandbox((s) => {
      writeFileSync(path.join(s.state, 'auditlog.cursor'), 's=earlier;i=1\n');
      const r = run(s, SHIP, [], { env: { STUB_JOURNAL_FAIL: '1' } });
      expect(r.status).not.toBe(0);
      expect(readFileSync(path.join(s.state, 'auditlog.cursor'), 'utf8')).toBe('s=earlier;i=1\n');
      expect(readdirSync(path.join(s.state, 'auditlog-spool'))).toEqual([]);
      expect(readdirSync(s.state).filter((f) => f.includes('next') || f.includes('part'))).toEqual([]);
      expect(r.curl).toContain(`url = "${SHIP_PING}/fail"`);
    });
  });

  it('keeps the cursor byte for byte when journalctl wrote one and exited 0 but gzip failed (T22-SQ-2)', () => {
    withSandbox((s) => {
      const before = 's=earlier;i=1;b=00ff\n';
      writeFileSync(path.join(s.state, 'auditlog.cursor'), before);
      writeFileSync(path.join(s.dir, 'journal'), JOURNAL);
      const r = run(s, SHIP, [], { env: { STUB_JOURNAL: path.join(s.dir, 'journal'), STUB_GZIP_FAIL: '1' } });
      expect(r.status).not.toBe(0);
      // journalctl did write a new cursor (into the copy it was given).
      expect(r.journalctl).toHaveLength(1);
      expect(readFileSync(path.join(s.state, 'auditlog.cursor'))).toEqual(Buffer.from(before));
      expect(readdirSync(path.join(s.state, 'auditlog-spool'))).toEqual([]);
      expect(readdirSync(s.state).filter((f) => f.includes('next') || f.includes('part'))).toEqual([]);
      expect(r.curl).toContain(`url = "${SHIP_PING}/fail"`);
      expect(readdirSync(s.remote)).toEqual([]);
    });
  });

  it('exits without exporting while another run holds the lock (T22R-S7)', async () => {
    const s = sandbox();
    const lock = path.join(s.state, 'auditlog-ship.lock');
    const holder = spawn('flock', [lock, 'sleep', '30'], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 50 && spawnSync('flock', ['-n', lock, 'true']).status === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(spawnSync('flock', ['-n', lock, 'true']).status, 'the lock is held').not.toBe(0);
      const r = run(s, SHIP);
      expect(r.status).not.toBe(0);
      expect(r.journalctl).toEqual([]);
      expect(readdirSync(s.remote)).toEqual([]);
      expect(r.curl).toContain(`url = "${SHIP_PING}/fail"`);
      expect(r.stderr).toContain('still going');
    } finally {
      holder.kill();
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it('deletes from the box only the files expiredNames() names, by exact name, in the web image offline', () => {
    withSandbox((s) => {
      // An expired hourly file, then the box's ordinary cadence up to now (no gap of more
      // than 3 days: S3-1), and an old pre-fix file, which the gap check never reads.
      const old = dayName(91);
      const oldPrefix = 'pre-fix-2020-01-01.json.gz';
      const recent = shippedName(new Date(Date.now() - 3_600_000));
      const stranger = 'notes-2020-01-01.txt';
      for (const f of [old, oldPrefix, recent, stranger]) writeFileSync(path.join(s.remote, f), 'x');
      cadence(s, 89, 1);
      const r = run(s, SHIP);
      expect(r.status, r.stderr).toBe(0);
      const left = readdirSync(s.remote);
      expect(left).not.toContain(old);
      expect(left).not.toContain(oldPrefix);
      expect(left).toEqual(expect.arrayContaining([recent, stranger]));
      // The oldest first.
      expect(r.ssh.map((c) => c.slice(-3))).toEqual([
        ['sub-user@box.example.test', 'rm', oldPrefix],
        ['sub-user@box.example.test', 'rm', old],
      ]);
      expect(r.stdout).toBe('shipped=1 deleted=2 pending=0\n');
      const dockerRun = r.docker.find((c) => c[0] === 'run') as string[];
      expect(dockerRun).toEqual(
        expect.arrayContaining(['--rm', '-i', '--pull', 'never', '--network', 'none', '-v', MOUNT, '--entrypoint', 'node', IMAGE, '/ops/auditlog.mjs', 'expired']),
      );
      expect(dockerRun[dockerRun.indexOf('--pull') + 1]).toBe('never');
    });
  });

  it('drains a backlog 60 at a time, oldest first, and succeeds (T22R-S2)', () => {
    withSandbox((s) => {
      // 61 hourly files from 95 days ago, all expired, then the box's ordinary cadence to now.
      const base = Date.parse(`${new Date(Date.now() - 95 * 86_400_000).toISOString().slice(0, 10)}T00:05:00Z`);
      const backlog = Array.from({ length: 61 }, (_, i) => shippedName(new Date(base + i * 3_600_000)));
      for (const f of backlog) writeFileSync(path.join(s.remote, f), 'x');
      cadence(s, 90, 1);
      writeFileSync(path.join(s.remote, shippedName(new Date(Date.now() - 3_600_000))), 'x');
      const first = run(s, SHIP);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toBe('shipped=1 deleted=60 pending=1\n');
      expect(readdirSync(s.remote).filter((f) => backlog.includes(f))).toEqual([backlog[60]]);
      spawnSync('sleep', ['1.1']);
      const second = run(s, SHIP);
      expect(second.stdout).toBe('shipped=1 deleted=1 pending=0\n');
      expect(readdirSync(s.remote).filter((f) => backlog.includes(f))).toEqual([]);
    });
  });

  it('deletes nothing when an expired file is dated within days of the newest one shipped before: the clock jumped forward', () => {
    withSandbox((s) => {
      for (const f of ['auditlog-2020-01-01T000500Z.journal.gz', 'auditlog-2020-01-02T230500Z.journal.gz']) writeFileSync(path.join(s.remote, f), 'x');
      // A clearing recorded after this run's own file excuses every gap (T22-R3a), so the gap
      // check cannot see the jump: this check still refuses, as the last line.
      writeFileSync(HOLD_CLEARED(s), `${isoSecond(new Date(Date.now() + 3_600_000))}\n`);
      const r = run(s, SHIP);
      expect(r.status).not.toBe(0);
      expect(r.ssh).toEqual([]);
      expect(r.stderr).toContain('clock jumped forward');
      expect(r.curl).toContain('audit log ship failed');
    });
  });

  it('holds every delete after a clock-jump refusal until the owner clears the marker (scripts F1)', () => {
    withSandbox((s) => {
      const old = ['auditlog-2020-01-01T000500Z.journal.gz', 'auditlog-2020-01-02T230500Z.journal.gz'];
      for (const f of old) writeFileSync(path.join(s.remote, f), 'x');
      const hold = path.join(s.state, 'auditlog-delete-hold');

      const first = run(s, SHIP);
      expect(first.status).not.toBe(0);
      expect(first.stderr).toContain('clock jumped');
      expect(readFileSync(hold, 'utf8')).toMatch(/^reason=.*clock jumped.* at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n$/);
      expect(statSync(hold).mode & 0o777).toBe(0o600);

      // An hour later the first run's own file is on the box: without the hold it would become
      // the newest file before the run, and the old files would pass the clock check.
      clearRec(s);
      spawnSync('sleep', ['1.1']);
      const second = run(s, SHIP);
      expect(second.status).not.toBe(0);
      expect(second.ssh, 'no delete while held').toEqual([]);
      expect(readdirSync(s.remote)).toEqual(expect.arrayContaining(old));
      expect(readdirSync(s.remote).filter((f) => !old.includes(f)), 'it still uploads').toHaveLength(2);
      expect(second.stdout).toBe('shipped=1 deleted=0 held=1\n');
      expect(second.curl).toContain(`url = "${SHIP_PING}/fail"`);
      expect(second.curl, 'one alert a day, not one an hour').not.toContain('audit log ship failed');

      // The owner checks the clock and clears the hold with the README's command, which also
      // removes the last-run time (a held run never moves it) and records the clearing, so the
      // gap the jump left no longer holds (T22-R3a): deletion resumes.
      const cleared = readmeClear(s);
      expect(cleared.status, cleared.stderr).toBe(0);
      clearRec(s);
      spawnSync('sleep', ['1.1']);
      const third = run(s, SHIP);
      expect(third.status, third.stderr).toBe(0);
      expect(third.ssh.map((c) => c.at(-1))).toEqual(old);
    });
  });

  it('records the time of its last fully successful run, and a normal hourly cadence never trips on it (S-F1 a)', () => {
    withSandbox((s) => {
      writeFileSync(LAST_RUN(s), `${isoSecond(new Date(Date.now() - 3_600_000))}\n`);
      const r = run(s, SHIP);
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(HOLD(s))).toBe(false);
      const stamp = readFileSync(LAST_RUN(s), 'utf8');
      expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n$/);
      expect(Math.abs(Date.parse(stamp.trim()) - Date.now())).toBeLessThan(120_000);
      expect(statSync(LAST_RUN(s)).mode & 0o777).toBe(0o600);
    });
  });

  it.each([
    ['more than 3 days after the last full run (a 4-day outage, or a jump forward)', 4 * 86_400_000],
    ['more than an hour before it (a jump back)', -2 * 3_600_000],
  ])('holds deletes when this run is %s, and still uploads (S-F1 a)', (_name, ageMs) => {
    withSandbox((s) => {
      writeFileSync(LAST_RUN(s), `${isoSecond(new Date(Date.now() - ageMs))}\n`);
      writeFileSync(path.join(s.remote, 'auditlog-2020-01-01T000500Z.journal.gz'), 'x');
      writeFileSync(path.join(s.remote, shippedName(new Date(Date.now() - 3_600_000))), 'x');
      const r = run(s, SHIP);
      expect(r.status).not.toBe(0);
      expect(readFileSync(HOLD(s), 'utf8')).toMatch(/^reason=.*last fully successful run.* at=/);
      expect(r.ssh).toEqual([]);
      expect(readdirSync(s.remote), 'the hour was uploaded').toHaveLength(3);
      expect(r.curl).toContain('audit log ship failed');
      // The marker is not moved by a run that did not fully succeed.
      expect(Math.abs(Date.parse(readFileSync(LAST_RUN(s), 'utf8').trim()) - (Date.now() - ageMs))).toBeLessThan(120_000);
    });
  });

  it('holds deletes when the run after a jump uploaded and then failed, even with no marker (S-F1, two runs)', () => {
    withSandbox((s) => {
      // The clock jumped about 30 days forward: the real files run from 120 to 30 "days ago",
      // and those older than 90 now look expired.
      for (let d = 120; d >= 30; d -= 1) writeFileSync(path.join(s.remote, dayName(d)), 'x');
      const first = run(s, SHIP, [], { env: { STUB_RSYNC_FAIL: 'list' } });
      expect(first.status).not.toBe(0);
      expect(readdirSync(s.remote).filter((f) => f.startsWith(`auditlog-${new Date().toISOString().slice(0, 10)}`)), 'run 1 uploaded').toHaveLength(1);
      clearRec(s);
      spawnSync('sleep', ['1.1']);
      // Run 1's file, with the wrong date, would be "the newest shipped before" run 2.
      const second = run(s, SHIP);
      expect(second.status).not.toBe(0);
      expect(second.ssh, 'run 2 deletes nothing').toEqual([]);
      expect(readFileSync(HOLD(s), 'utf8')).toMatch(/^reason=.*gap.* at=/);
      expect(second.stderr).toContain('gap');
    });
  });

  it('holds deletes on a gap of more than 3 days between names in the last 93 days (S-F1 b)', () => {
    withSandbox((s) => {
      for (const f of [dayName(12, '0005'), dayName(12, '0105'), dayName(5, '0005')]) writeFileSync(path.join(s.remote, f), 'x');
      writeFileSync(path.join(s.remote, 'auditlog-2020-01-01T000500Z.journal.gz'), 'x');
      const r = run(s, SHIP);
      expect(r.status).not.toBe(0);
      expect(r.ssh).toEqual([]);
      expect(existsSync(HOLD(s))).toBe(true);
    });
  });

  // A forward jump of more than 93 days moves every real name out of the last 93 days. Each gap
  // is measured by its LATER end, with the newest name before the window as the lower end, so the
  // jump is still a gap (S3-1). The real files run from 209 to 120 "days ago".
  it.each([
    ['the listing', { STUB_RSYNC_FAIL: 'list' }],
    ['expiredNames()', { MJS: '/nonexistent/auditlog.mjs' }],
  ])('holds deletes after a 120-day jump with no last-run marker, when run 1 uploaded and then failed at %s (S3-1)', (_where, failure) => {
    withSandbox((s) => {
      cadence(s, 209, 120);
      const real = readdirSync(s.remote);
      const first = run(s, SHIP, [], { env: failure });
      expect(first.status).not.toBe(0);
      expect(readdirSync(s.remote).filter((f) => !real.includes(f)), 'run 1 uploaded').toHaveLength(1);
      expect(existsSync(LAST_RUN(s)), 'no marker: run 1 did not fully succeed').toBe(false);
      clearRec(s);
      spawnSync('sleep', ['1.1']);
      // Run 1's file, with the wrong date, would be "the newest shipped before" run 2.
      const second = run(s, SHIP);
      expect(second.status).not.toBe(0);
      expect(second.ssh, 'run 2 deletes nothing').toEqual([]);
      expect(readdirSync(s.remote).filter((f) => real.includes(f))).toHaveLength(real.length);
      expect(readFileSync(HOLD(s), 'utf8')).toMatch(/^reason=a gap of 120 days .* at=/);
      expect(existsSync(LAST_RUN(s))).toBe(false);
    });
  });

  it('holds on the first run after install when the clock jumped 120 days (no marker, no cursor), before choosing anything to delete (S3-1)', () => {
    withSandbox((s) => {
      cadence(s, 209, 120);
      expect(readdirSync(s.state), 'nothing from an earlier run').toEqual([]);
      const r = run(s, SHIP);
      expect(r.status).not.toBe(0);
      expect(r.journalctl[0]).toContain('--since=-26h');
      expect(r.ssh).toEqual([]);
      expect(readFileSync(HOLD(s), 'utf8')).toMatch(/^reason=a gap of 120 days .* at=/);
      // The gap is found on the listing alone: no later step that could fail decides it.
      expect(r.docker, 'expiredNames() never ran').toEqual([]);
    });
  });

  it('stops holding for an outage the owner cleared, and deletes again (T22-R3a)', () => {
    withSandbox((s) => {
      // A real outage of 6 days that ended 14 days ago, and ten files past retention.
      cadence(s, 100, 20);
      cadence(s, 14, 1);
      const first = run(s, SHIP);
      expect(first.status).not.toBe(0);
      expect(first.ssh).toEqual([]);
      expect(readFileSync(HOLD(s), 'utf8')).toMatch(/^reason=a gap of 6 days /);

      const cleared = readmeClear(s);
      expect(cleared.status, cleared.stderr).toBe(0);
      expect(readFileSync(HOLD_CLEARED(s), 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n$/);

      clearRec(s);
      spawnSync('sleep', ['1.1']);
      const second = run(s, SHIP);
      expect(second.status, second.stderr).toBe(0);
      expect(existsSync(HOLD(s))).toBe(false);
      expect(second.stdout).toBe('shipped=1 deleted=10 pending=0\n');
      expect(second.ssh.map((c) => c.at(-1))).toEqual(Array.from({ length: 10 }, (_, i) => dayName(100 - i)));
    });
  });

  it('still holds a new jump after the owner cleared an earlier hold (T22-R3a)', () => {
    withSandbox((s) => {
      // The owner cleared a hold; then the clock jumped 120 days: the gap ends after the
      // clearing, so it holds.
      cadence(s, 209, 120);
      writeFileSync(HOLD_CLEARED(s), `${isoSecond(new Date(Date.now() - 150 * 86_400_000))}\n`);
      const r = run(s, SHIP);
      expect(r.status).not.toBe(0);
      expect(r.ssh).toEqual([]);
      expect(readFileSync(HOLD(s), 'utf8')).toMatch(/^reason=a gap of 120 days .* at=/);
    });
  });

  it.each([
    ['not a time', 'not-a-time\n'],
    // `date -d ''` reads an empty string as today's midnight.
    ['empty', ''],
  ])('measures every gap when the clearing time is %s', (_name, text) => {
    withSandbox((s) => {
      cadence(s, 100, 20);
      cadence(s, 14, 1);
      writeFileSync(HOLD_CLEARED(s), text);
      const r = run(s, SHIP);
      expect(r.status).not.toBe(0);
      expect(r.ssh).toEqual([]);
      expect(readFileSync(HOLD(s), 'utf8')).toMatch(/^reason=a gap of 6 days /);
    });
  });

  describe("the README's command for clearing a hold (S3-4, T22-R3a)", () => {
    it.each([
      ['the hold alone, with no alert mark and no last-run time (none before a first full run)', ['auditlog-delete-hold']],
      ['the hold, its alert mark and the last-run time', ['auditlog-delete-hold', 'auditlog-delete-hold.alerted', 'auditlog-last-run']],
    ])('clears %s without an error, and records when, mode 600', (_name, present) => {
      withSandbox((s) => {
        for (const f of present) writeFileSync(path.join(s.state, f), 'x\n');
        const before = Date.now();
        const r = readmeClear(s);
        expect(r.status, r.stderr).toBe(0);
        expect(r.stderr).toBe('');
        expect(readdirSync(s.state).sort()).toEqual(['auditlog-hold-cleared']);
        const at = readFileSync(HOLD_CLEARED(s), 'utf8');
        expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n$/);
        expect(Date.parse(at.trim())).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
        expect(Date.parse(at.trim())).toBeLessThanOrEqual(Date.now());
        expect(statSync(HOLD_CLEARED(s)).mode & 0o777).toBe(0o600);
      });
    });

    it('fails, and records nothing, when there is no hold to clear', () => {
      withSandbox((s) => {
        const r = readmeClear(s);
        expect(r.status).not.toBe(0);
        expect(existsSync(HOLD_CLEARED(s))).toBe(false);
      });
    });
  });

  it('holds a jump whose gap straddles the clearing: the gap\'s later end decides, not its earlier one (S4-2)', () => {
    withSandbox((s) => {
      // The owner cleared 29 days ago, after the newest real file (30 days ago), and the clock
      // jumped before anything was shipped after the clearing.
      cadence(s, 120, 30);
      writeFileSync(HOLD_CLEARED(s), `${isoSecond(new Date(Date.now() - 29 * DAY_S * 1000))}\n`);
      const r = run(s, SHIP);
      expect(r.status).not.toBe(0);
      expect(r.ssh).toEqual([]);
      expect(readFileSync(HOLD(s), 'utf8')).toMatch(/^reason=a gap of 30 days /);
    });
  });

  // Names never go backwards (S4-1): each hour's file is named at max(now, the last name shipped
  // + 1 s), so a clock that stepped back cannot name a file into the past, where retention, which
  // works by name, would delete it early, and the reconcile would never fetch it.
  it('names the file of a run 200 days back just after the previous one, so the clear that follows does not free it (S4-1)', () => {
    withSandbox((s) => {
      cadence(s, 95, 1);
      const prev = shippedName(new Date(Date.now() - 3_600_000));
      writeFileSync(path.join(s.remote, prev), 'x');
      writeFileSync(LAST_RUN(s), `${isoSecond(new Date(Date.now() - 3_600_000 + 5_000))}\n`);
      writeFileSync(LAST_NAME(s), `${prev}\n`);
      const real = readdirSync(s.remote);

      const jumped = run(s, SHIP, [], { env: { STUB_DATE_OFFSET: String(-200 * DAY_S) } });
      expect(jumped.status).not.toBe(0);
      expect(readFileSync(HOLD(s), 'utf8')).toContain('the clock jumped back');
      const [jf] = newNames(s, real);
      expect(jf > prev, `${jf} sorts after ${prev}`).toBe(true);

      // The clock is right again; the hold stands until the owner clears it, as the README says.
      clearRec(s);
      expect(run(s, SHIP).stdout).toBe('shipped=1 deleted=0 held=1\n');
      const cleared = readmeClear(s);
      expect(cleared.status, cleared.stderr).toBe(0);
      clearRec(s);
      spawnSync('sleep', ['1.1']);
      const after = run(s, SHIP);
      expect(after.status, after.stderr).toBe(0);
      expect(after.stdout).toBe('shipped=1 deleted=5 pending=0\n');
      expect(after.ssh.map((c) => c.at(-1))).not.toContain(jf);
      expect(readdirSync(s.remote)).toContain(jf);
    });
  });

  it('does the same with no last-run time and a clearing an hour earlier, naming from the box (S4-1)', () => {
    withSandbox((s) => {
      cadence(s, 95, 1);
      const prev = shippedName(new Date(Date.now() - 3_600_000));
      writeFileSync(path.join(s.remote, prev), 'x');
      writeFileSync(HOLD_CLEARED(s), `${isoSecond(new Date(Date.now() - 3_600_000))}\n`);
      const real = readdirSync(s.remote);

      const jumped = run(s, SHIP, [], { env: { STUB_DATE_OFFSET: String(-200 * DAY_S) } });
      expect(jumped.status).not.toBe(0);
      expect(jumped.stderr).toContain('the clock is behind');
      const [jf] = newNames(s, real);
      expect(jf > prev, `${jf} sorts after ${prev}`).toBe(true);

      // The clock-behind refusal writes no hold, so there is nothing to clear: the clock is right
      // again, and the next run prunes what is past retention, and only that.
      expect(existsSync(HOLD(s))).toBe(false);
      clearRec(s);
      spawnSync('sleep', ['1.1']);
      const after = run(s, SHIP);
      expect(after.status, after.stderr).toBe(0);
      expect(after.stdout).toBe('shipped=1 deleted=5 pending=0\n');
      expect(readdirSync(s.remote)).toContain(jf);
    });
  });

  it('keeps names strictly increasing across three runs while the clock steps back an hour between them (S4-1)', () => {
    withSandbox((s) => {
      const names: string[] = [];
      for (const offset of [0, -3600, -7200]) {
        const before = readdirSync(s.remote);
        // Whatever the run does after its upload, the upload names the file.
        run(s, SHIP, [], { env: { STUB_DATE_OFFSET: String(offset) } });
        const added = newNames(s, before);
        expect(added).toHaveLength(1);
        names.push(added[0]);
        expect(readFileSync(LAST_NAME(s), 'utf8')).toBe(`${added[0]}\n`);
      }
      expect([...names].sort()).toEqual(names);
      expect(new Set(names).size).toBe(3);
    });
  });

  it('names the next file after one still in the spool, whatever the clock (S4-1)', () => {
    withSandbox((s) => {
      const older = shippedName(new Date(Date.now() - 2 * 3_600_000));
      writeFileSync(LAST_NAME(s), `${older}\n`);
      const failed = run(s, SHIP, [], { env: { STUB_RSYNC_FAIL: 'push' } });
      expect(failed.status).not.toBe(0);
      const [spooled] = readdirSync(path.join(s.state, 'auditlog-spool'));
      expect(readFileSync(LAST_NAME(s), 'utf8'), 'a failed upload does not move it').toBe(`${older}\n`);
      run(s, SHIP, [], { env: { STUB_DATE_OFFSET: '-3600' } });
      const shipped = readdirSync(s.remote).sort();
      expect(shipped).toHaveLength(2);
      expect(shipped[0]).toBe(spooled);
      expect(shipped[1] > spooled).toBe(true);
    });
  });

  it('records the last name it shipped after each successful upload, even when the run then fails, mode 600 (S4-1)', () => {
    withSandbox((s) => {
      const r = run(s, SHIP, [], { env: { STUB_RSYNC_FAIL: 'list' } });
      expect(r.status).not.toBe(0);
      const [name] = readdirSync(s.remote);
      expect(readFileSync(LAST_NAME(s), 'utf8')).toBe(`${name}\n`);
      expect(statSync(LAST_NAME(s)).mode & 0o777).toBe(0o600);
      expect(existsSync(LAST_RUN(s)), 'independent of the last-run time').toBe(false);
    });
  });

  it('keeps naming after a future name a forward jump left: names never go backwards (S4-1)', () => {
    withSandbox((s) => {
      const ahead = shippedName(new Date(Date.now() + 30 * DAY_S * 1000));
      writeFileSync(LAST_NAME(s), `${ahead}\n`);
      run(s, SHIP);
      const [name] = readdirSync(s.remote);
      expect(name > ahead, `${name} sorts after ${ahead}`).toBe(true);
    });
  });

  it('names no reason of its own while a hold stands: the alert points to the hold file (S3-2)', () => {
    withSandbox((s) => {
      // A hold for a jump back: the alert must not call it a clock-forward refusal.
      writeFileSync(LAST_RUN(s), `${isoSecond(new Date(Date.now() + 2 * 3_600_000))}\n`);
      const r = run(s, SHIP);
      expect(r.status).not.toBe(0);
      expect(readFileSync(HOLD(s), 'utf8')).toContain('the clock jumped back');
      expect(r.curl).toContain(`audit log ship failed: remote deletes are held (the reason is in ${HOLD(s)})`);
      expect(r.curl).not.toContain('clock-forward');
    });
  });

  it('alerts again the next day while the hold stands', () => {
    withSandbox((s) => {
      writeFileSync(path.join(s.state, 'auditlog-delete-hold'), 'reason=clock jumped forward at=2026-10-14T01:05:00Z\n');
      writeFileSync(path.join(s.state, 'auditlog-delete-hold.alerted'), '2020-01-01\n');
      const r = run(s, SHIP);
      expect(r.status).not.toBe(0);
      expect(r.curl).toContain('audit log ship failed');
      expect(readFileSync(path.join(s.state, 'auditlog-delete-hold.alerted'), 'utf8')).toBe(`${new Date().toISOString().slice(0, 10)}\n`);
    });
  });

  it('deletes nothing when a file on the box is dated after today: the clock is behind', () => {
    withSandbox((s) => {
      for (const f of [dayName(91), shippedName(new Date(Date.now() - 3_600_000)), 'auditlog-2099-01-01T000500Z.journal.gz']) {
        writeFileSync(path.join(s.remote, f), 'x');
      }
      cadence(s, 89, 1);
      const r = run(s, SHIP);
      expect(r.status).not.toBe(0);
      expect(r.ssh).toEqual([]);
      expect(r.stderr).toContain('clock is behind');
    });
  });

  it('ships first, then fails loudly when WEB_IMAGE is empty or not pinned, since it cannot prune', () => {
    for (const image of ['', 'ghcr.io/example/web:latest']) {
      withSandbox((s) => {
        const r = run(s, SHIP, [], { dotenv: { WEB_IMAGE: image } });
        expect(r.status).not.toBe(0);
        expect(readdirSync(s.remote), 'the hour was still shipped').toHaveLength(1);
        expect(r.docker).toEqual([]);
        expect(r.curl).toContain(`url = "${SHIP_PING}/fail"`);
        expect(r.stderr).toContain('WEB_IMAGE');
      });
    }
  });

  it.each([['box.example.test:/abs'], ['-e@box.example.test:'], ['sub-user@-box.example.test:'], ['.x@box.example.test:']])(
    'refuses the target %j before any rsync call (scripts F2)',
    (target) => {
      withSandbox((s) => {
        const r = run(s, SHIP, [], { dotenv: { OFFSITE_AUDIT_TARGET: target } });
        expect(r.status).not.toBe(0);
        expect(r.rsync).toEqual([]);
      });
    },
  );

  it('ends rsync\'s options with -- before the files and the target', () => {
    withSandbox((s) => {
      const r = run(s, SHIP);
      expect(r.status, r.stderr).toBe(0);
      expect(r.rsync.length).toBeGreaterThan(1);
      for (const c of r.rsync) {
        expect(c, c.join(' ')).toContain('--');
        expect(c.slice(c.indexOf('--') + 1).length, 'something follows --').toBeGreaterThan(0);
        expect(c.slice(c.indexOf('--') + 1).filter((a) => a.startsWith('-')), 'only paths and the target follow --').toEqual([]);
      }
    });
  });
});

describe('what the ship exports is named where it is described (S3-3, L3-1)', () => {
  const ship = readFileSync(path.join(HOST, SHIP), 'utf8');
  const header = ship.slice(0, ship.indexOf('\nset -Eeuo pipefail')).replace(/\n#\s*/g, ' ');
  const readme = readFileSync(path.join(HOST, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  const exes = [...ship.matchAll(/_EXE=(\S+)/g)].map((m) => m[1]);

  it('names every executable it exports by path, in its header and in the README', () => {
    expect(exes).toEqual(['/usr/bin/sudo', '/usr/bin/su', '/usr/bin/pkexec', '/usr/lib/polkit-1/polkit-agent-helper-1']);
    for (const exe of exes) {
      expect(header, `the header names ${exe}`).toContain(exe);
      expect(readme, `the README names ${exe}`).toContain(exe);
    }
    expect(header).toContain('pkexec');
    // By content too (L4-1): the authpriv facility, named in both places.
    expect(ship).toContain('+ SYSLOG_FACILITY=10');
    expect(header).toContain('SYSLOG_FACILITY=10');
    expect(readme).toContain('SYSLOG_FACILITY=10');
  });

  it('lists polkit-1 among the PAM services whose root session counts, and polkit authentication failures', () => {
    expect(readme).toMatch(/`sudo`, `sudo-i`, `su`, `su-l` (?:or|and) `polkit-1` PAM session/);
    expect(readme).toContain('pam_unix(polkit-1:auth)');
  });

  it('records that pkexec is absent and polkitd present, and advises, without making it a step, that an unused polkit may be removed', () => {
    expect(readme).toContain('pkexec is not installed on the server (checked 2026-10-14)');
    expect(readme).toMatch(/`polkitd` is installed, as a dependency/);
    const blocks = [...readFileSync(path.join(HOST, 'README.md'), 'utf8').matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(blocks.filter((b) => /pkexec|polkit/.test(b)), 'no command block removes either').toEqual([]);
  });

  it('says what each hold alert carries: the reason first, then the file (S4-3)', () => {
    expect(readme).toContain('The first alert of a gap or clock-forward hold carries the reason');
    expect(readme).toContain('while the hold stands, each daily alert says only that remote deletes are held and names the file');
  });

  it('gives the recovery after a future-dated integrity row, and the review after a jump back (T22-R4c)', () => {
    expect(readme).toMatch(/futureRows[^`]*`--since <the stored checked_until, or earlier>`/);
    expect(readme).toContain('A `--since` later than the stored `checked_until` is refused by design');
    expect(readme).toMatch(/After a "the clock jumped back" hold[^.]*reviews the files shipped while the hold stood/);
  });
});

describe('makrai-auditlog-reconcile.sh', () => {
  const now = Date.now();
  const ago = (h: number) => new Date(now - h * 3_600_000);
  const iso = (d: Date) => d.toISOString();
  const TOL = 300;

  type DbRow = { seq: number; prevHash: string; hash: string; atUtc: string; kind: string; actorRef: string; detailText: string };
  const mkRow = (seq: number, prevHash: string, at: Date): DbRow => {
    const r = { seq, prevHash, atUtc: iso(at), kind: 'break_glass.open', actorRef: 'console:root', detailText: '{"tty": "tty1", "channel": "hetzner-console"}' };
    return { ...r, hash: entryHash(r) };
  };

  /**
   * A console break-glass login 3 h ago, its row (seq 7, after an anchor row seq 6 from two days
   * ago) and shipped line, and a two-factor SSH login.
   */
  function arrange(s: Sandbox, o: { db?: Record<string, unknown>; extra?: Record<string, string>[]; files?: boolean; verbose?: boolean } = {}) {
    const loginAt = ago(3);
    const anchor = mkRow(6, 'd'.repeat(64), ago(50));
    const row = mkRow(7, anchor.hash, new Date(loginAt.getTime() + 2_000));
    const journal = exportRecords([
      { __CURSOR: 'c1', __REALTIME_TIMESTAMP: usAt(iso(loginAt)), _PID: '900', _COMM: 'login', SYSLOG_IDENTIFIER: 'login', MESSAGE: 'pam_unix(login:session): session opened for user root(uid=0) by root(uid=0)' },
      { __CURSOR: 'c2', __REALTIME_TIMESTAMP: usAt(iso(new Date(loginAt.getTime() + 17_000))), _PID: '901', _COMM: 'logger', SYSLOG_IDENTIFIER: 'makrai-break-glass', MESSAGE: `entry=0f8fad5b-d9cb-469f-a165-70867728950e seq=7 hash=${row.hash} notice=sent` },
      { __CURSOR: 'c3', __REALTIME_TIMESTAMP: usAt(iso(ago(2))), _PID: '4242', _COMM: 'sshd', SYSLOG_IDENTIFIER: 'sshd', MESSAGE: `Partial publickey for root from 203.0.113.7 port 50022 ssh2: ED25519 ${FP}` },
      { __CURSOR: 'c4', __REALTIME_TIMESTAMP: usAt(iso(new Date(ago(2).getTime() + 9_000))), _PID: '4242', _COMM: 'sshd', SYSLOG_IDENTIFIER: 'sshd', MESSAGE: 'Accepted keyboard-interactive/pam for root from 203.0.113.7 port 50022 ssh2' },
      ...(o.extra ?? []),
    ]);
    if (o.files !== false) {
      // The journal split over two shipped files, as two hourly runs would; and the same
      // records shipped twice (a run that died after the copy and before moving the cursor),
      // which must not count twice.
      writeFileSync(path.join(s.remote, shippedName(ago(2.5))), gzipSync(journal));
      writeFileSync(path.join(s.remote, shippedName(ago(1))), gzipSync(journal));
      // The newest file before the window is fetched too, for pairing across the window's
      // start; anything older is not.
      writeFileSync(
        path.join(s.remote, shippedName(ago(40))),
        gzipSync(exportRecords([{ __CURSOR: 'c0', __REALTIME_TIMESTAMP: usAt(iso(ago(40))), _PID: '1', _COMM: 'sudo', MESSAGE: 'root : TTY=pts/0 ; PWD=/root ; USER=postgres ; COMMAND=/bin/true' }])),
      );
      writeFileSync(path.join(s.remote, shippedName(ago(60))), gzipSync('not even export data'));
    }
    writeFileSync(path.join(s.dir, 'db.json'), `${JSON.stringify({ rows: [row], anchor, stateRow: null, maxSeq: 7, ...o.db })}\n`);
    writeFileSync(path.join(s.etc, 'allowed-keys.fp'), `${FP} operator\n`);
    // The switch and the verbose marker, relative to now, both before every record here.
    writeFileSync(path.join(s.etc, 'ssh-two-factor-since'), `${isoSecond(ago(100))}\n`);
    if (o.verbose !== false) writeFileSync(path.join(s.etc, 'ssh-verbose-since'), `${isoSecond(ago(90))}\n`);
    return { env: { STUB_DB: path.join(s.dir, 'db.json') }, row, anchor };
  }

  const COUNTS = /^records=\d+ rows=\d+ matched=\d+ consoleLoginsWithoutEntry=\d+ entriesWithoutLogin=\d+ unknownKeyLogins=\d+ singleFactorLogins=\d+ chainBreaks=\d+ hashMismatches=\d+ noticeFailures=\d+ sudoToRoot=\d+ operatorSessions=\d+ rootPasswordChanges=\d+ rowsWithoutShipped=\d+ preVerboseLogins=\d+ backdatedRows=\d+ futureRows=\d+ futureNamedFiles=\d+$/;
  const STATE = (s: Sandbox) => path.join(s.state, 'auditlog-state');
  const psqlVar = (r: Run, name: string) => (r.docker.find((c) => c[0] === 'exec') as string[]).find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) as string;

  it('passes a clean window, pings, mails the two counts, stores its state, and ends with the counts line', () => {
    withSandbox((s) => {
      const { env, row } = arrange(s);
      const r = run(s, RECONCILE, [], { env });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trimEnd().split('\n'), 'stdout is the counts line and nothing else').toHaveLength(1);
      const last = r.stdout.trimEnd();
      expect(last).toMatch(COUNTS);
      expect(last).toContain('rows=1 matched=1 consoleLoginsWithoutEntry=0 entriesWithoutLogin=0 unknownKeyLogins=0 singleFactorLogins=0 chainBreaks=0');
      expect(last).toContain('operatorSessions=1 rootPasswordChanges=0 rowsWithoutShipped=0 preVerboseLogins=0 backdatedRows=0 futureRows=0 futureNamedFiles=0');
      expect(r.curl).toContain(`url = "${RECONCILE_PING}"\n`);
      expect(r.curl).not.toContain('/fail');
      // The nightly mail carries the two counts the owner reviews (F-30), and no other data.
      expect(r.curl).toContain('audit reconcile passed: operatorSessions=1 rootPasswordChanges=0');
      expect(r.curl).not.toContain('203.0.113');
      expect(r.curl).not.toContain(FP);
      // The state: flagged up to the tolerance before the newest file, and the last row checked.
      const until = new Date(Date.parse(isoSecond(ago(1))) - TOL * 1000);
      expect(readFileSync(STATE(s), 'utf8')).toBe(`checked_until=${isoSecond(until)} seq=7 hash=${row.hash}\n`);
      expect(statSync(STATE(s)).mode & 0o777).toBe(0o600);
    });
  });

  it('fetches the files from the window start on, plus the one before, and asks psql for the same span', () => {
    withSandbox((s) => {
      const { env } = arrange(s);
      const r = run(s, RECONCILE, [], { env });
      expect(r.status, r.stderr).toBe(0);
      const fetch = r.rsync.find((c) => c.some((a) => a.startsWith('--include='))) as string[];
      expect(fetch.filter((a) => a.startsWith('--include=')).sort()).toEqual(
        [shippedName(ago(40)), shippedName(ago(2.5)), shippedName(ago(1))].map((n) => `--include=${n}`).sort(),
      );
      expect(fetch).toContain('--exclude=*');
      // psql reads the rows with the to_char rendering the hash covers, as ONE contiguous seq
      // range: from the row after the stored seq, or from the first row dated from the tolerance
      // before the window's start to the newest file's time, whichever is lower (L3-2); the row
      // just before the first of them; the stored seq's row; and max(seq).
      expect(r.psqlStdin).toContain(`to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
      expect(r.psqlStdin).toContain('detail::text');
      expect(r.psqlStdin.replace(/\s+/g, ' ')).toContain(
        "where seq >= least(:'state_seq'::bigint + 1, coalesce((select min(seq) from integrity_log where at >= :'rows_from'::timestamptz and at < :'until'::timestamptz), :'state_seq'::bigint + 1))",
      );
      expect(r.psqlStdin).not.toMatch(/seq > :'state_seq'::bigint or/);
      expect(r.psqlStdin).toMatch(/where seq < coalesce\(\(select min\(seq\) from w\)[^\n]*\n?[^\n]*order by seq desc limit 1/);
      expect(r.psqlStdin).toContain("seq = :'state_seq'::bigint");
      expect(r.psqlStdin).toContain('max(seq)');
      const rowsFrom = Date.parse(psqlVar(r, 'rows_from'));
      expect(Math.abs(rowsFrom - (now - 26 * 3_600_000 - TOL * 1000))).toBeLessThan(120_000);
      expect(psqlVar(r, 'until')).toBe(isoSecond(ago(1)));
      expect(psqlVar(r, 'state_seq')).toBe('0');
      const dockerRun = r.docker.find((c) => c[0] === 'run') as string[];
      expect(dockerRun).toEqual(expect.arrayContaining(['--pull', 'never', '--network', 'none', '-v', MOUNT, '--entrypoint', 'node', IMAGE, '/ops/auditlog.mjs', 'reconcile']));
      expect(dockerRun[dockerRun.indexOf('--pull') + 1]).toBe('never');
    });
  });

  it('starts from the stored state when it is older than 26 h, so a missed night is caught up (T22-R-A2)', () => {
    withSandbox((s) => {
      const { env, row } = arrange(s, { db: {} });
      const checked = ago(30);
      writeFileSync(STATE(s), `checked_until=${isoSecond(checked)} seq=7 hash=${row.hash}\n`);
      writeFileSync(path.join(s.dir, 'db.json'), JSON.stringify({ ...JSON.parse(readFileSync(path.join(s.dir, 'db.json'), 'utf8')), stateRow: row }));
      const r = run(s, RECONCILE, [], { env });
      expect(r.status, r.stderr).toBe(0);
      expect(Date.parse(psqlVar(r, 'rows_from'))).toBe(Date.parse(isoSecond(checked)) - 2 * TOL * 1000);
      expect(psqlVar(r, 'state_seq')).toBe('7');
    });
  });

  it('fails loudly when the stored state is more than 8 days old, and asks for --since', () => {
    withSandbox((s) => {
      const { env, row } = arrange(s);
      writeFileSync(STATE(s), `checked_until=${isoSecond(ago(24 * 9))} seq=7 hash=${row.hash}\n`);
      const r = run(s, RECONCILE, [], { env });
      expect(r.status).toBe(3);
      expect(r.curl).toContain(`url = "${RECONCILE_PING}/fail"`);
      expect(r.curl).toContain('state too old; run with --since');
      expect(r.docker).toEqual([]);
    });
  });

  it('takes --since for a manual catch-up from before the stored checked_until', () => {
    withSandbox((s) => {
      const { env, row } = arrange(s);
      writeFileSync(STATE(s), `checked_until=${isoSecond(ago(24 * 9))} seq=7 hash=${row.hash}\n`);
      writeFileSync(path.join(s.dir, 'db.json'), JSON.stringify({ ...JSON.parse(readFileSync(path.join(s.dir, 'db.json'), 'utf8')), stateRow: row }));
      // The span now reaches the 60 h file too, so it must be readable.
      writeFileSync(path.join(s.remote, shippedName(ago(60))), gzipSync(''));
      const since = isoSecond(ago(24 * 9 + 1));
      const r = run(s, RECONCILE, ['--since', since], { env });
      expect(r.status, r.stderr).toBe(0);
      expect(Date.parse(psqlVar(r, 'rows_from'))).toBe(Date.parse(since) - TOL * 1000);
    });
  });

  it('refuses a --since later than the stored checked_until, which would skip what was never checked (T22R1A-4)', () => {
    withSandbox((s) => {
      const { env, row } = arrange(s);
      writeFileSync(STATE(s), `checked_until=${isoSecond(ago(30))} seq=7 hash=${row.hash}\n`);
      const r = run(s, RECONCILE, ['--since', isoSecond(ago(20))], { env });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('later than');
      expect(r.rsync).toEqual([]);
    });
  });

  it('fails when the newest shipped file is older than 26 h, even with a stored state (T22R1A-3)', () => {
    withSandbox((s) => {
      const { env, row } = arrange(s, { files: false });
      writeFileSync(STATE(s), `checked_until=${isoSecond(ago(30))} seq=7 hash=${row.hash}\n`);
      const quiet = gzipSync(exportRecords([{ __CURSOR: 'q', __REALTIME_TIMESTAMP: usAt(iso(ago(29))), _PID: '1', _COMM: 'sudo', MESSAGE: 'root : TTY=pts/0 ; PWD=/root ; USER=postgres ; COMMAND=/bin/true' }]));
      for (const h of [40, 29, 28]) writeFileSync(path.join(s.remote, shippedName(ago(h))), quiet);
      const r = run(s, RECONCILE, [], { env });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('no shipped file in the last 26 h: the ship has stopped');
      expect(r.curl).toContain(`url = "${RECONCILE_PING}/fail"`);
      expect(r.docker.filter((c) => c[0] === 'run')).toEqual([]);
    });
  });

  it('ignores a future-named file for the window, reports it, and never stores a checked_until after now (L-F3)', () => {
    withSandbox((s) => {
      const { env } = arrange(s);
      writeFileSync(path.join(s.remote, shippedName(new Date(now + 10 * 86_400_000))), gzipSync('not even export data'));
      const r = run(s, RECONCILE, [], { env });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trimEnd()).toMatch(/ futureNamedFiles=1$/);
      expect(r.curl).toContain('futureNamedFiles=1');
      const fetch = r.rsync.find((c) => c.some((a) => a.startsWith('--include='))) as string[];
      expect(fetch.some((a) => a.includes(new Date(now + 10 * 86_400_000).toISOString().slice(0, 10)))).toBe(false);
      const stored = /checked_until=(\S+)/.exec(readFileSync(STATE(s), 'utf8'))?.[1] as string;
      expect(Date.parse(stored)).toBeLessThanOrEqual(Date.now());
    });
  });

  it('fails freshness when the only recent name is in the future, and stores nothing (L-F3)', () => {
    withSandbox((s) => {
      const { env, row } = arrange(s, { files: false });
      const before = `checked_until=${isoSecond(ago(30))} seq=7 hash=${row.hash}\n`;
      writeFileSync(STATE(s), before);
      const quiet = gzipSync(exportRecords([{ __CURSOR: 'q', __REALTIME_TIMESTAMP: usAt(iso(ago(29))), _PID: '1', _COMM: 'sudo', MESSAGE: 'root : TTY=pts/0 ; PWD=/root ; USER=postgres ; COMMAND=/bin/true' }]));
      for (const h of [40, 29]) writeFileSync(path.join(s.remote, shippedName(ago(h))), quiet);
      writeFileSync(path.join(s.remote, shippedName(new Date(now + 10 * 86_400_000))), quiet);
      const r = run(s, RECONCILE, [], { env });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('no shipped file in the last 26 h: the ship has stopped');
      expect(readFileSync(STATE(s), 'utf8')).toBe(before);
    });
  });

  it('counts a password change once across two nights: the informational counts start at the stored checked_until (T22R1A-6)', () => {
    withSandbox((s) => {
      const extra = [{ __CURSOR: 'c9', __REALTIME_TIMESTAMP: usAt(iso(ago(1.5))), _PID: '950', _COMM: 'chpasswd', SYSLOG_IDENTIFIER: 'chpasswd', MESSAGE: 'pam_unix(chpasswd:chauthtok): password changed for root' }];
      const { env, row } = arrange(s, { extra });
      const first = run(s, RECONCILE, [], { env });
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain(' operatorSessions=1 rootPasswordChanges=1 ');
      writeFileSync(path.join(s.dir, 'db.json'), JSON.stringify({ ...JSON.parse(readFileSync(path.join(s.dir, 'db.json'), 'utf8')), stateRow: row }));
      clearRec(s);
      const second = run(s, RECONCILE, [], { env });
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain(' operatorSessions=0 rootPasswordChanges=0 ');
      expect(second.curl).toContain('audit reconcile passed: operatorSessions=0 rootPasswordChanges=0');
    });
  });

  it('refuses a target beginning with - before any rsync call (scripts F2)', () => {
    withSandbox((s) => {
      const { env } = arrange(s);
      const r = run(s, RECONCILE, [], { env, dotenv: { OFFSITE_AUDIT_TARGET: '-e@box.example.test:' } });
      expect(r.status).toBe(3);
      expect(r.rsync).toEqual([]);
    });
  });

  it.each([[['--since']], [['--since', 'yesterday']], [['--bogus']]])('refuses arguments %j with exit 64, before reading anything', (args) => {
    withSandbox((s) => {
      const { env } = arrange(s);
      const r = run(s, RECONCILE, args, { env });
      expect(r.status).toBe(64);
      expect(r.rsync).toEqual([]);
      expect(r.curl).toBe('');
    });
  });

  it('fails on a state file it cannot read as one', () => {
    withSandbox((s) => {
      const { env } = arrange(s);
      writeFileSync(STATE(s), 'checked_until=yesterday\n');
      const r = run(s, RECONCILE, [], { env });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('auditlog-state');
    });
  });

  it('fails on a row dated after now: futureRows=1, /fail, and no state stored (L3-2)', () => {
    withSandbox((s) => {
      const { env, row, anchor } = arrange(s);
      // The last good run stored seq 7. Row 8 is read because its seq is above that, and it is
      // dated an hour from now: a clock that ran ahead wrote it.
      writeFileSync(STATE(s), `checked_until=${isoSecond(ago(20))} seq=7 hash=${row.hash}\n`);
      const ahead = mkRow(8, row.hash, new Date(now + 3_600_000));
      writeFileSync(path.join(s.dir, 'db.json'), JSON.stringify({ rows: [row, ahead], anchor, stateRow: row, maxSeq: 8 }));
      const before = readFileSync(STATE(s), 'utf8');
      const r = run(s, RECONCILE, [], { env });
      expect(r.status).toBe(1);
      expect(r.stdout.trimEnd()).toMatch(COUNTS);
      expect(r.stdout).toContain(' chainBreaks=0 ');
      expect(r.stdout).toContain(' futureRows=1 ');
      expect(r.curl).toContain(`url = "${RECONCILE_PING}/fail"`);
      expect(r.curl).toContain('audit reconcile FAILED');
      expect(readFileSync(STATE(s), 'utf8'), 'the state is not moved').toBe(before);
    });
  });

  it('fails on a finding: /fail, an alert with the two counts, the counts line last, and no state stored', () => {
    withSandbox((s) => {
      // The row is gone: the console login and the shipped line have nothing to meet.
      const { env } = arrange(s, { db: { rows: [] } });
      const r = run(s, RECONCILE, [], { env });
      expect(r.status).toBe(1);
      expect(r.stdout.trimEnd().split('\n').at(-1)).toMatch(COUNTS);
      expect(r.stdout).toContain(' consoleLoginsWithoutEntry=1 ');
      expect(r.curl).toContain(`url = "${RECONCILE_PING}/fail"`);
      expect(r.curl).toContain('audit reconcile FAILED: operatorSessions=1 rootPasswordChanges=0');
      expect(existsSync(STATE(s))).toBe(false);
    });
  });

  it('reports root password changes in the mail, without failing', () => {
    withSandbox((s) => {
      const extra = [{ __CURSOR: 'c9', __REALTIME_TIMESTAMP: usAt(iso(ago(1.5))), _PID: '950', _COMM: 'chpasswd', SYSLOG_IDENTIFIER: 'chpasswd', MESSAGE: 'pam_unix(chpasswd:chauthtok): password changed for root' }];
      const { env } = arrange(s, { extra });
      const r = run(s, RECONCILE, [], { env });
      expect(r.status, r.stderr).toBe(0);
      expect(r.curl).toContain('audit reconcile passed: operatorSessions=1 rootPasswordChanges=1');
    });
  });

  it('reads the switch and the verbose marker as absent when their files are', () => {
    withSandbox((s) => {
      // A keyboard-interactive-only login: before install A, that is how a two-factor login looked.
      const extra = [{ __CURSOR: 'c8', __REALTIME_TIMESTAMP: usAt(iso(ago(1.7))), _PID: '5400', _COMM: 'sshd', SYSLOG_IDENTIFIER: 'sshd', MESSAGE: 'Accepted keyboard-interactive/pam for root from 203.0.113.70 port 40100 ssh2' }];
      const { env } = arrange(s, { extra, verbose: false });
      const r = run(s, RECONCILE, [], { env });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(' preVerboseLogins=1');
      rmSync(path.join(s.etc, 'ssh-two-factor-since'));
      rmSync(STATE(s));
      const noSwitch = run(s, RECONCILE, [], { env });
      expect(noSwitch.stdout).toContain(' singleFactorLogins=0 ');
    });
  });

  it.each([
    ['WEB_IMAGE is empty', { dotenv: { WEB_IMAGE: '' } }, 'WEB_IMAGE'],
    ['WEB_IMAGE is a tag, not a digest', { dotenv: { WEB_IMAGE: 'ghcr.io/example/web:latest' } }, 'WEB_IMAGE'],
    ['the box cannot be listed', { env: { STUB_RSYNC_FAIL: 'list' } }, 'list'],
    ['the files cannot be fetched', { env: { STUB_RSYNC_FAIL: 'fetch' } }, 'fetch'],
    ['psql fails', { env: { STUB_PSQL_FAIL: '1' } }, 'integrity_log'],
  ] as [string, Opts, string][])('fails loudly, never silently, when %s', (_name, o, says) => {
    withSandbox((s) => {
      const { env } = arrange(s);
      const r = run(s, RECONCILE, [], { ...o, env: { ...env, ...o.env } });
      expect(r.status).toBe(3);
      expect(r.stdout, 'no counts: nothing was reconciled').toBe('');
      expect(r.stderr).toContain(says);
      expect(r.curl).toContain(`url = "${RECONCILE_PING}/fail"`);
      expect(r.curl).toContain('audit reconcile could not run');
      expect(r.stderr).not.toContain('FATAL');
      expect(existsSync(STATE(s))).toBe(false);
    });
  });

  it('fails when no file was shipped since the window start, rather than pass on nothing', () => {
    withSandbox((s) => {
      const { env } = arrange(s, { files: false });
      writeFileSync(path.join(s.remote, shippedName(ago(40))), gzipSync(''));
      const r = run(s, RECONCILE, [], { env });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('no shipped file');
      expect(r.docker.filter((c) => c[0] === 'run')).toEqual([]);
    });
  });

  it('fails when the allowed-keys list is missing', () => {
    withSandbox((s) => {
      const { env } = arrange(s);
      rmSync(path.join(s.etc, 'allowed-keys.fp'));
      const r = run(s, RECONCILE, [], { env });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('allowed-keys.fp');
    });
  });

  it('leaves nothing in its working directory', () => {
    withSandbox((s) => {
      const { env } = arrange(s);
      run(s, RECONCILE, [], { env });
      expect(readdirSync(s.tmp)).toEqual([]);
    });
  });
});

describe('makrai-prefix-export.sh', () => {
  const R = '2026-10-14T05:07:16Z';
  const ADDRESS = OWNER;
  const LINK_HEX = '0123456789abcdef'.repeat(4);
  const NGINX = '"CONTAINER_NAME":"docker-nginx-1","_SYSTEMD_UNIT":"docker.service"';
  const day1 = [
    '{"MESSAGE":"GET /health 200","__REALTIME_TIMESTAMP":"1"}',
    `{"MESSAGE":"Invalid user ${ADDRESS.toUpperCase()} from 203.0.113.9","__REALTIME_TIMESTAMP":"2"}`,
    '{"MESSAGE":"GET /login 200 \\"Mozilla/5.0 (+http://bots.example.org/crawler@bots.example.org)\\"","__REALTIME_TIMESTAMP":"3"}',
    '{"MESSAGE":[71,69,84,32],"__REALTIME_TIMESTAMP":"4"}',
    `{"MESSAGE":"GET /invitations/${LINK_HEX}/accept 200 and /api/v1/invitations/${LINK_HEX}?x=1","__REALTIME_TIMESTAMP":"5"}`,
    // An nginx line in the image's old "main" format: its query string and referer go entirely.
    `{${NGINX},"MESSAGE":"203.0.113.9 - - [13/Oct/2026:06:00:00 +0000] \\"GET /login?callbackUrl=%2Finvitations%2F${LINK_HEX} HTTP/1.1\\" 200 512 \\"https://ref.example.org/p?q=1\\" \\"Mozilla/5.0\\" \\"-\\"","__REALTIME_TIMESTAMP":"6"}`,
    // The app's own line, percent-encoded: the token goes, the rest stays.
    `{"MESSAGE":"redirect callbackUrl=%2Finvitations%2f${LINK_HEX}","__REALTIME_TIMESTAMP":"7"}`,
  ].join('\n') + '\n';
  const day2 = '{"MESSAGE":"GET /health 200","__REALTIME_TIMESTAMP":"8"}\n';

  /** A stand-in email scan beside the script: --write-patterns writes the list; --file scans like the real one. */
  function arrange(s: Sandbox, o: { scanBody?: string; days?: Record<string, string> } = {}) {
    writeFileSync(
      path.join(s.host, 'makrai-email-scan.sh'),
      `#!/usr/bin/env bash
{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/scan"
case "$1" in
  --write-patterns) [ -n "\${STUB_SCAN_REFUSE:-}" ] && exit 2; printf '%s\\n' '${ADDRESS}' > "$2"; echo patterns=1 ;;
  --file) ${o.scanBody ?? `n=$(gzip -dc "$2" | grep -ciF '@' || true); echo "patterns=1 account_hits=0 shape_hits=$n shape_hits_nginx=0"; [ "$n" -eq 0 ]`} ;;
esac`,
    );
    chmodSync(path.join(s.host, 'makrai-email-scan.sh'), 0o755);
    const days = path.join(s.dir, 'days');
    mkdirSync(days);
    for (const [day, text] of Object.entries(o.days ?? { '2026-10-13': day1, '2026-10-14': day2 })) writeFileSync(path.join(days, `${day}.json`), text);
    return { STUB_DAYS: days, STUB_OLDEST_US: usAt('2026-10-13T06:00:00Z') };
  }
  const scanCalls = (s: Sandbox) => calls(path.join(s.rec, 'scan'));

  it('writes one scrubbed file per day, checks each with the email scan, ships them, and prints counts only', () => {
    withSandbox((s) => {
      const r = run(s, EXPORT, [R], { env: arrange(s) });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(
        'patterns=1\npre-fix-2026-10-13 lines=7 kept=4 removed=3\npre-fix-2026-10-14 lines=1 kept=1 removed=0\ndays=2 shipped=2\n',
      );
      expect(readdirSync(s.remote).sort()).toEqual(['pre-fix-2026-10-13.json.gz', 'pre-fix-2026-10-14.json.gz']);
      const kept = gunzipSync(readFileSync(path.join(s.remote, 'pre-fix-2026-10-13.json.gz'))).toString();
      expect(kept).toBe(
        [
          '{"MESSAGE":"GET /health 200","__REALTIME_TIMESTAMP":"1"}',
          '{"MESSAGE":"GET /invitations/[token]/accept 200 and /api/v1/invitations/[token]?x=1","__REALTIME_TIMESTAMP":"5"}',
          `{${NGINX},"MESSAGE":"203.0.113.9 - - [13/Oct/2026:06:00:00 +0000] \\"GET /login HTTP/1.1\\" 200 512 \\"-\\" \\"Mozilla/5.0\\" \\"-\\"","__REALTIME_TIMESTAMP":"6"}`,
          '{"MESSAGE":"redirect callbackUrl=%2Finvitations%2f[token]","__REALTIME_TIMESTAMP":"7"}',
        ].join('\n') + '\n',
      );
      expect(kept).not.toContain(LINK_HEX);
      // The local copies go once shipped: the box's prune is what keeps them 90 days.
      expect(readdirSync(path.join(s.state, 'prefix-export'))).toEqual([]);
      expect(readdirSync(s.tmp), 'the pattern list is gone').toEqual([]);
    });
  });

  it('reads each day whole, up to R and no further', () => {
    withSandbox((s) => {
      const r = run(s, EXPORT, [R], { env: arrange(s) });
      const days = r.journalctl.filter((c) => c.some((a) => a.startsWith('--since=')));
      const windows = days.map((c) => [c.find((a) => a.startsWith('--since=')), c.find((a) => a.startsWith('--until='))]);
      expect([...new Set(windows.map((w) => JSON.stringify(w)))].map((w) => JSON.parse(w))).toEqual([
        ['--since=2026-10-13 00:00:00 UTC', '--until=2026-10-13 23:59:59.999999 UTC'],
        ['--since=2026-10-14 00:00:00 UTC', '--until=2026-10-14 05:07:16 UTC'],
      ]);
      for (const c of days) expect(c).toEqual(expect.arrayContaining(['-o', 'json', '--all']));
    });
  });

  it('writes, checks and ships nothing for a day whose every line was removed, and says so (T22R-S5)', () => {
    withSandbox((s) => {
      const env = arrange(s, { days: { '2026-10-13': '{"MESSAGE":[1,2,3],"__REALTIME_TIMESTAMP":"1"}\n', '2026-10-14': day2 } });
      const r = run(s, EXPORT, [R], { env });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe('patterns=1\npre-fix-2026-10-13 lines=1 kept=0 removed=1\npre-fix-2026-10-14 lines=1 kept=1 removed=0\ndays=2 shipped=1\n');
      expect(readdirSync(s.remote)).toEqual(['pre-fix-2026-10-14.json.gz']);
      expect(scanCalls(s).filter((c) => c[0] === '--file')).toHaveLength(1);
    });
  });

  it('fails, and ships nothing, when an invitation token survives the scrub in an encoding it does not undo (S3)', () => {
    withSandbox((s) => {
      const env = arrange(s, { days: { '2026-10-13': `{"MESSAGE":"next=%252Finvitations%252F${LINK_HEX}","__REALTIME_TIMESTAMP":"1"}\n`, '2026-10-14': day2 } });
      const r = run(s, EXPORT, [R], { env });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('invitation token');
      expect(readdirSync(s.remote)).toEqual([]);
      expect(r.stdout + r.stderr).not.toContain(LINK_HEX);
    });
  });

  it('refuses a target beginning with - before any rsync call (scripts F2)', () => {
    withSandbox((s) => {
      const r = run(s, EXPORT, [R], { env: arrange(s), dotenv: { OFFSITE_AUDIT_TARGET: '-e@box.example.test:' } });
      expect(r.status).not.toBe(0);
      expect(r.rsync).toEqual([]);
      expect(readdirSync(s.remote)).toEqual([]);
    });
  });

  it('drops a query string past nginx \\xHH escapes, and the error log\'s referrer (scripts F5)', () => {
    withSandbox((s) => {
      const lines = [
        // nginx writes a quote, a backslash or a high byte as \xHH, which is \\xHH in JSON.
        `{${NGINX},"MESSAGE":"203.0.113.9 - - [13/Oct/2026:06:00:00 +0000] \\"GET /reset?code=AAAA\\\\x22BBBBBBBB&next=1 HTTP/1.1\\" 200 0 \\"-\\" \\"Mozilla/5.0\\" \\"-\\"","__REALTIME_TIMESTAMP":"1"}`,
        `{${NGINX},"MESSAGE":"2026/10/13 06:00:00 [error] 29#29: *1 open() failed, client: 203.0.113.9, server: app.example.test, request: \\"GET /x?q=1 HTTP/1.1\\", host: \\"app.example.test\\", referrer: \\"https://app.example.test/orgs/acme/settings?tab=2\\"","__REALTIME_TIMESTAMP":"2"}`,
      ];
      const env = arrange(s, { days: { '2026-10-13': `${lines.join('\n')}\n`, '2026-10-14': day2 } });
      const r = run(s, EXPORT, [R], { env });
      expect(r.status, r.stderr).toBe(0);
      const kept = gunzipSync(readFileSync(path.join(s.remote, 'pre-fix-2026-10-13.json.gz'))).toString().split('\n');
      expect(kept[0]).toContain('\\"GET /reset HTTP/1.1\\"');
      expect(kept[0]).not.toContain('BBBB');
      expect(kept[0]).not.toContain('next=1');
      expect(kept[1]).toContain('request: \\"GET /x HTTP/1.1\\"');
      expect(kept[1]).toContain('referrer: \\"-\\"');
      expect(kept[1]).not.toContain('settings');
    });
  });

  it('ships nothing when the scan finds anything in any day', () => {
    withSandbox((s) => {
      const r = run(s, EXPORT, [R], { env: arrange(s, { scanBody: 'echo "patterns=1 account_hits=1 shape_hits=0 shape_hits_nginx=0"; exit 1' }) });
      expect(r.status).not.toBe(0);
      expect(readdirSync(s.remote)).toEqual([]);
      expect(r.stdout).not.toContain(ADDRESS);
      expect(r.stderr).not.toContain(ADDRESS);
    });
  });

  it('stops when the scan refuses to write the pattern list', () => {
    withSandbox((s) => {
      const r = run(s, EXPORT, [R], { env: { ...arrange(s), STUB_SCAN_REFUSE: '1' } });
      expect(r.status).not.toBe(0);
      expect(r.journalctl).toEqual([]);
      expect(readdirSync(s.remote)).toEqual([]);
    });
  });

  it.each([[[]], [['not a time']], [[R, 'extra']]])('refuses arguments %j', (args) => {
    withSandbox((s) => {
      const r = run(s, EXPORT, args, { env: arrange(s) });
      expect(r.status).toBe(64);
      expect(r.journalctl).toEqual([]);
    });
  });
});
