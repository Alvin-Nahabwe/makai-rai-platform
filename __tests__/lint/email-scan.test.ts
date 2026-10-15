import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { EMAIL_SHAPE_SOURCE, redactText } from '../../lib/redact';

/**
 * `ops/host/makrai-email-scan.sh` is the only thing that is allowed to look for account
 * emails in the logs (global constraint 5). It has to be able to do that without ever
 * showing one, and it has to fail loudly when it has nothing to look with, because a scan
 * that cannot find anything and says "0 hits" is worse than no scan.
 *
 * THESE TESTS RUN THE SCRIPT, with `docker`, `journalctl` and `curl` replaced by stand-ins
 * that record what they were called with. That shows what the script does with the
 * answers it is given. It cannot show that the real journal holds the tags it is told to
 * read, or that the real database answers as the stand-in does: step 4 of Task 12 does
 * that, on the server, after a sign-in.
 *
 * Every address here uses a reserved example domain.
 */

// EMAIL_SCAN_HOST_DIR points the whole file at a directory holding a COPY of the host files (the script,
// email-shape.regex and makrai-lib.sh). It exists so that a deliberately broken copy of the script can be run
// through these tests to show which of them notice (mutation evidence). Unset, it is the repository's own.
const HOST = path.resolve(process.env.EMAIL_SCAN_HOST_DIR ?? 'ops/host');
const SCRIPT = 'makrai-email-scan.sh';
const SHAPE_FILE = 'email-shape.regex';

const OWNER = 'owner@example.test';
const SECOND = 'second.user@example.test';
const BOT = 'crawler-bot@bots.example.org';
const PING = 'https://hc.example.test/ping-sentinel-12';

/** Four journal lines: two account hits (one in a different case), and one shape-only hit. */
const JOURNAL = [
  '{"event":"AUTH_LOGIN_FAILURE","userId":"u1"}',
  `Invalid user ${OWNER} from 203.0.113.9 port 4022`,
  `GET /login 200 "Mozilla/5.0 (compatible; Bot/2.0; +http://bots.example.org/${BOT})"`,
  `DETAIL: Key (email)=(${SECOND.replace('s', 'S').replace('e', 'E')}) already exists.`,
].join('\n') + '\n';

const PATTERNS = `${OWNER}\n${SECOND}\n`;

/**
 * How the scan selects the nginx container's lines: the name its journald driver records, AND
 * the trusted unit (S4). Any local process can send a CONTAINER_NAME field; none can send a
 * `_SYSTEMD_UNIT`, which journald sets itself.
 */
const NGINX_MATCH = 'CONTAINER_NAME=docker-nginx-1';
const DOCKER_UNIT = '_SYSTEMD_UNIT=docker.service';
/**
 * How the scan selects sshd's lines (T22c-1): the trusted `_COMM` of the record, which journald
 * sets from the process and a message cannot change. Two values of the same field are OR'd.
 * OpenSSH 9.8 and later logs from sshd-session.
 */
const SSHD_COMMS = ['_COMM=sshd', '_COMM=sshd-session'];
const isSshdPass = (argv: string[]): boolean => SSHD_COMMS.every((c) => argv.includes(c)) && !argv.includes('+') && !argv.includes(DOCKER_UNIT);

type Run = {
  status: number;
  stdout: string;
  stderr: string;
  /** One entry per call: the argument vector. */
  docker: string[][];
  journalctl: string[][];
  curlArgv: string;
  curlStdin: string;
  /** What is left in TMPDIR after the script exited. */
  leftovers: string[];
  /** Mode of the file the pattern query's output was written to, as the stand-in saw it. */
  patternFileMode: string;
  patternDirMode: string;
};

type Opts = {
  args?: string[];
  /** Text psql returns for the pattern query. Absent = nothing. */
  patterns?: string;
  users?: number;
  journal?: string;
  /** Lines from the nginx container (trusted unit and name). Absent = none. */
  nginx?: string;
  /** Lines a local process (its _COMM is `sudo`) sent with CONTAINER_NAME=docker-nginx-1 but under its own unit. */
  forged?: string;
  /** Lines from sshd (T22c-1): their trusted _COMM is `sshdComm`. Absent = none. */
  sshd?: string;
  /**
   * Lines served ONLY to the dedicated pass that reads sshd by `_COMM`, and not to the export read that
   * tells the other sources apart. In the real journal the two always agree. Here they disagree on purpose:
   * if shape_hits were computed as "everything minus sshd", these lines would move it.
   */
  sshdPassOnly?: string;
  /** The same for the dedicated nginx pass (name AND trusted unit): served to it alone, never to the export read. */
  nginxPassOnly?: string;
  /**
   * Records with a `_COMM` and a `_SYSTEMD_UNIT` of their own, to pull the two apart. They appear in the text
   * pass, in the export (with both fields) and, when the `_COMM` is exactly sshd or sshd-session, in the sshd pass.
   */
  records?: { comm: string; unit: string; message: string }[];
  /** The _COMM the sshd lines carry: `sshd` or `sshd-session` (OpenSSH 9.8 and later). Default `sshd-session`. */
  sshdComm?: string;
  /** Contents of a gzip file passed with --file. */
  fileText?: string;
  /** Replace the shape file the script finds beside itself; `null` deletes it. */
  shape?: string | null;
  dockerFails?: boolean;
  journalFails?: boolean;
  env?: Record<string, string>;
  /** Called with the sandbox directory before the run, to arrange anything else. */
  prepare?: (dir: string) => void;
  /** Called with the sandbox directory after the run and before it is removed. */
  after?: (dir: string) => void;
  /** Run with `<sandbox>/work` as the working directory, for arguments that are relative paths. */
  inWorkDir?: boolean;
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

function run(o: Opts = {}): Run {
  const dir = mkdtempSync(path.join(tmpdir(), 'email-scan-'));
  try {
    const host = path.join(dir, 'host');
    const bin = path.join(dir, 'bin');
    const rec = path.join(dir, 'rec');
    const tmp = path.join(dir, 'tmp');
    for (const d of [host, bin, rec, tmp]) mkdirSync(d);

    // The script and its expression, side by side as they are installed.
    copyFileSync(path.join(HOST, SCRIPT), path.join(host, SCRIPT));
    chmodSync(path.join(host, SCRIPT), 0o755);
    if (o.shape !== null) {
      if (o.shape === undefined) copyFileSync(path.join(HOST, SHAPE_FILE), path.join(host, SHAPE_FILE));
      else writeFileSync(path.join(host, SHAPE_FILE), o.shape);
    }
    // The real library, with only read_env replaced: the real one reads the server's .env
    // (its own tests are in auditlog-scripts.test.ts). The mail settings and the ping URL
    // come from the environment below, as the reader would export them.
    writeFileSync(
      path.join(host, 'makrai-lib.sh'),
      `. "${path.join(HOST, 'makrai-lib.sh')}"\nread_env() { export POSTGRES_USER=owner_role POSTGRES_DB=app_db; }\n`,
    );

    const stub = (name: string, body: string): void => {
      writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(path.join(bin, name), 0o755);
    };
    stub(
      'docker',
      `{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/docker"
sql=
while [ $# -gt 0 ]; do [ "$1" = -c ] && { sql=$2; break; }; shift; done
if [ -n "\${STUB_DOCKER_FAIL:-}" ]; then echo "psql: FATAL: could not look up ${OWNER}" >&2; exit 1; fi
case "$sql" in
  *'count(*)'*) printf '%s\\n' "\${STUB_USERS:-0}" ;;
  *union*)
    out=$(readlink /proc/$$/fd/1)
    stat -c %a "$out" > "$REC/pattern-file-mode"
    stat -c %a "$(dirname "$out")" > "$REC/pattern-dir-mode"
    if [ -n "\${STUB_PATTERNS_FILE:-}" ]; then cat "$STUB_PATTERNS_FILE"; fi ;;
  *) echo "docker stand-in: unexpected query" >&2; exit 9 ;;
esac`,
    );
    stub(
      'journalctl',
      `{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/journalctl"
if [ -n "\${STUB_JOURNAL_FAIL:-}" ]; then echo "journalctl: stand-in failure" >&2; exit 1; fi
# Four kinds of line: other sources (docker.service, no name), the nginx container
# (docker.service and its name), forged (the name, under another unit, from a process
# named sudo), and sshd's (by _COMM, under the ssh unit). A pass gets what the real journal
# would give its matches.
lines() { [ -n "\${1:-}" ] && [ -f "$1" ] && cat "$1"; true; }
export_of() { # $1 file, $2... extra fields
  local f=$1; shift
  [ -n "$f" ] && [ -f "$f" ] || return 0
  while IFS= read -r l || [ -n "$l" ]; do printf '%s\n' "$@"; printf 'MESSAGE=%s\n\n' "$l"; done < "$f"
}
# Records with a _COMM and a unit of their own, one per line: comm TAB unit TAB message.
# $1: text (the message), sshd (the message, if the _COMM is exactly sshd or sshd-session), export (the record).
records() {
  local c u m
  [ -n "\${STUB_RECORDS_FILE:-}" ] && [ -f "$STUB_RECORDS_FILE" ] || return 0
  while IFS=$'\t' read -r c u m || [ -n "$c" ]; do
    case "$1" in
      text) printf '%s\n' "$m" ;;
      sshd) if [ "$c" = sshd ] || [ "$c" = sshd-session ]; then printf '%s\n' "$m"; fi ;;
      export) printf '_SYSTEMD_UNIT=%s\n_COMM=%s\nMESSAGE=%s\n\n' "$u" "$c" "$m" ;;
    esac
  done < "$STUB_RECORDS_FILE"
}
name= unit= export= sshd= plus=
for a in "$@"; do
  case "$a" in
    CONTAINER_NAME=docker-nginx-1) name=1 ;;
    _SYSTEMD_UNIT=docker.service) unit=1 ;;
    _COMM=sshd|_COMM=sshd-session) sshd=1 ;;
    +) plus=1 ;;
    export) export=1 ;;
  esac
done
if [ -n "$name" ]; then
  lines "\${STUB_NGINX_FILE:-}"
  [ -z "$unit" ] || lines "\${STUB_NGINX_PASS_ONLY_FILE:-}"
  [ -n "$unit" ] || lines "\${STUB_FORGED_FILE:-}"
elif [ -n "$sshd" ] && [ -z "$plus" ] && [ -z "$unit" ]; then
  # sshd's lines alone: the process name, with no unit group beside it.
  lines "\${STUB_SSHD_FILE:-}"
  lines "\${STUB_SSHD_PASS_ONLY_FILE:-}"
  records sshd
elif [ -n "$export" ]; then
  export_of "\${STUB_JOURNAL_FILE:-}" _SYSTEMD_UNIT=docker.service _COMM=dockerd
  export_of "\${STUB_NGINX_FILE:-}" _SYSTEMD_UNIT=docker.service _COMM=dockerd CONTAINER_NAME=docker-nginx-1
  export_of "\${STUB_FORGED_FILE:-}" _SYSTEMD_UNIT=user@1000.service _COMM=sudo CONTAINER_NAME=docker-nginx-1
  export_of "\${STUB_SSHD_FILE:-}" _SYSTEMD_UNIT=ssh.service "_COMM=\${STUB_SSHD_COMM:-sshd-session}"
  records export
else
  lines "\${STUB_JOURNAL_FILE:-}"; lines "\${STUB_NGINX_FILE:-}"; lines "\${STUB_FORGED_FILE:-}"; lines "\${STUB_SSHD_FILE:-}"
  records text
fi`,
    );
    stub(
      'curl',
      `{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/curl-argv"
for a in "$@"; do [ "$a" = "--config" ] && cat >> "$REC/curl-stdin"; done
if [ -n "\${STUB_CURL_FAIL:-}" ] && [[ "$*" == *api.resend.com* ]]; then echo "curl: (6) could not resolve host for \${STUB_CURL_FAIL}" >&2; exit 6; fi
case "$*" in *'%{http_code}'*) printf '%s\\n%s' "\${STUB_CURL_BODY:-}" "\${STUB_CURL_CODE:-200}" ;; esac`,
    );

    // A minimal environment, on purpose. NODE_ENV is only here because this project's
    // ProcessEnv type requires it.
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
      HOME: dir,
      TMPDIR: tmp,
      REC: rec,
      // The mail settings alert() needs, and the ping URL, as the server .env would give them.
      RESEND_API_KEY: 'k'.repeat(24),
      ADMIN_EMAIL: 'admin-sentinel@example.test',
      EMAIL_FROM_ADDRESS: 'sender-sentinel@example.test',
      ...o.env,
    };
    if (o.patterns !== undefined) {
      writeFileSync(path.join(dir, 'patterns'), o.patterns);
      env.STUB_PATTERNS_FILE = path.join(dir, 'patterns');
    }
    env.STUB_USERS = String(o.users ?? (o.patterns ?? '').split('\n').filter(Boolean).length);
    if (o.journal !== undefined) {
      writeFileSync(path.join(dir, 'journal'), o.journal);
      env.STUB_JOURNAL_FILE = path.join(dir, 'journal');
    }
    if (o.nginx !== undefined) {
      writeFileSync(path.join(dir, 'nginx'), o.nginx);
      env.STUB_NGINX_FILE = path.join(dir, 'nginx');
    }
    if (o.forged !== undefined) {
      writeFileSync(path.join(dir, 'forged'), o.forged);
      env.STUB_FORGED_FILE = path.join(dir, 'forged');
    }
    if (o.sshd !== undefined) {
      writeFileSync(path.join(dir, 'sshd'), o.sshd);
      env.STUB_SSHD_FILE = path.join(dir, 'sshd');
      if (o.sshdComm !== undefined) env.STUB_SSHD_COMM = o.sshdComm;
    }
    if (o.sshdPassOnly !== undefined) {
      writeFileSync(path.join(dir, 'sshd-pass-only'), o.sshdPassOnly);
      env.STUB_SSHD_PASS_ONLY_FILE = path.join(dir, 'sshd-pass-only');
    }
    if (o.nginxPassOnly !== undefined) {
      writeFileSync(path.join(dir, 'nginx-pass-only'), o.nginxPassOnly);
      env.STUB_NGINX_PASS_ONLY_FILE = path.join(dir, 'nginx-pass-only');
    }
    if (o.records !== undefined) {
      writeFileSync(path.join(dir, 'records'), o.records.map((r) => [r.comm, r.unit, r.message].join('\t')).join('\n') + '\n');
      env.STUB_RECORDS_FILE = path.join(dir, 'records');
    }
    if (o.dockerFails) env.STUB_DOCKER_FAIL = '1';
    if (o.journalFails) env.STUB_JOURNAL_FAIL = '1';
    const args = (o.args ?? []).map((a) => a.replace('{DIR}', dir));
    if (o.fileText !== undefined) {
      writeFileSync(path.join(dir, 'log.gz'), gzipSync(o.fileText));
      args.push('--file', path.join(dir, 'log.gz'));
    }
    o.prepare?.(dir);

    const cwd = path.join(dir, 'work');
    mkdirSync(cwd);
    const r = spawnSync('bash', [path.join(host, SCRIPT), ...args], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
      cwd: o.inWorkDir ? cwd : dir,
    });
    const read = (f: string): string => (existsSync(path.join(rec, f)) ? readFileSync(path.join(rec, f), 'utf8') : '');
    const result: Run = {
      status: r.status ?? -1,
      stdout: r.stdout,
      stderr: r.stderr,
      docker: calls(path.join(rec, 'docker')),
      journalctl: calls(path.join(rec, 'journalctl')),
      curlArgv: read('curl-argv'),
      curlStdin: read('curl-stdin'),
      leftovers: readdirSync(tmp),
      patternFileMode: read('pattern-file-mode').trim(),
      patternDirMode: read('pattern-dir-mode').trim(),
    };
    o.after?.(dir);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const everyAddress = [OWNER, SECOND, BOT, OWNER.toUpperCase(), 'sentinel@example.test'];
function expectNoAddress(r: Run): void {
  for (const text of [r.stdout, r.stderr]) {
    for (const a of everyAddress) expect(text.toLowerCase(), `an address reached the output: ${text}`).not.toContain(a.toLowerCase());
  }
}

const scanned = { patterns: PATTERNS, journal: JOURNAL };

describe('makrai-email-scan.sh refuses to scan with nothing to scan with', () => {
  it('refuses to scan with an empty pattern list', () => {
    const r = run({ patterns: '', users: 2, journal: JOURNAL });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('EMPTY-PATTERNS');
    expect(r.stdout, 'a refusal prints no counts').toBe('');
    expect(r.journalctl, 'the journal must not be read at all').toEqual([]);
  });

  it('refuses when psql returns nothing at all, not even an empty table', () => {
    // The brief's case: docker stubbed so psql returns nothing. users is 0 as well.
    const r = run({ journal: JOURNAL });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('EMPTY-PATTERNS');
  });

  it('refuses when the list has fewer lines than users', () => {
    // A query cut short by a dropped connection leaves a short list that is not empty.
    const r = run({ patterns: `${OWNER}\n`, users: 3, journal: JOURNAL });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('EMPTY-PATTERNS');
    expect(r.stdout).toBe('');
  });

  it('refuses a blank line in the list, which grep -F would read as a pattern that matches every line', () => {
    const r = run({ patterns: `${OWNER}\n\n${SECOND}\n`, users: 2, journal: JOURNAL });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('EMPTY-PATTERNS');
  });

  it('refuses when no log line was read, which would otherwise report 0 hits for a window it never saw', () => {
    // A wrong tag, or a journal this account cannot read, selects nothing and exits 0.
    const r = run({ ...scanned, journal: '' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('EMPTY-LOG');
    expect(r.stdout).toBe('');
  });
});

describe('makrai-email-scan.sh queries', () => {
  it('reads both tables, lowercased', () => {
    const r = run(scanned);
    const sqls = r.docker.map((c) => c[c.indexOf('-c') + 1]);
    expect(sqls).toContain('select lower(email) from users union select lower(email) from invitations');
    expect(sqls).toContain('select count(*) from users');
    // As the owner, in the database from .env, in the postgres container, and unaligned.
    for (const c of r.docker) {
      expect(c.slice(0, 7)).toEqual(['exec', 'docker-postgres-1', 'psql', '-U', 'owner_role', '-d', 'app_db']);
      expect(c).toContain('-At');
    }
  });

  it('reads the whole docker unit, sshd, sshd-session and sudo, over one fixed window', () => {
    const r = run({ ...scanned, args: ['--since', '2026-10-08 06:00:00'] });
    // The nginx container's own pass and sshd's own pass are checked in the blocks below.
    const main = r.journalctl.filter((argv) => !argv.includes(NGINX_MATCH) && !isSshdPass(argv));
    expect(main.length).toBeGreaterThan(0);
    // The text passes read `-o cat`; the one that tells nginx apart reads `-o export`.
    expect(main.filter((argv) => argv.includes('export'))).toHaveLength(1);
    for (const argv of main) {
      // The docker journald driver writes from dockerd, so one unit match covers every
      // container (the migrator, which has a different tag on every run, included) and
      // any container added later. A list of tags would be blind to all of those.
      expect(argv).toContain('_SYSTEMD_UNIT=docker.service');
      // Each term is an argv element of its own. A substring test would let
      // `_COMM=sshd-session` stand in for `_COMM=sshd`, and neither would be noticed missing.
      for (const comm of ['_COMM=sshd', '_COMM=sshd-session', '_COMM=sudo']) expect(argv).toContain(comm);
      // The unit is one group and the commands another, OR'd with "+"; without it
      // journalctl would AND them and select nothing.
      const plus = argv.indexOf('+');
      expect(plus).toBeGreaterThan(0);
      expect(argv.slice(0, plus)).toContain('_SYSTEMD_UNIT=docker.service');
      expect(argv.slice(plus + 1)).toEqual(['_COMM=sshd', '_COMM=sshd-session', '_COMM=sudo']);
      expect(argv.some((a) => a.startsWith('--until='))).toBe(true);
      expect(argv).toContain('--no-pager');
      expect(['cat', 'export']).toContain(argv[argv.indexOf('-o') + 1]);
    }
    // Every pass reads the same window, or the counts would describe different logs: --since
    // is resolved ONCE, to an absolute time, so a relative one cannot move between passes.
    const sinces = new Set(r.journalctl.map((a) => a.find((x) => x.startsWith('--since='))));
    expect(sinces.size).toBe(1);
    const since = [...sinces][0] as string;
    expect(since).toMatch(/^--since=@\d+$/);
    const local = spawnSync('date', ['-d', '2026-10-08 06:00:00', '+%s'], { encoding: 'utf8' }).stdout.trim();
    expect(since).toBe(`--since=@${local}`);
    const untils = new Set(r.journalctl.map((a) => a.find((x) => x.startsWith('--until='))));
    expect(untils.size).toBe(1);
  });

  it('resolves a relative --since once, so every pass reads the same span', () => {
    const r = run({ ...scanned, args: ['--since', '-26h'] });
    const sinces = new Set(r.journalctl.map((a) => a.find((x) => x.startsWith('--since='))));
    expect(sinces.size).toBe(1);
    const at = Number(([...sinces][0] as string).slice('--since=@'.length));
    expect(Math.abs(at - (Date.now() / 1000 - 26 * 3600))).toBeLessThan(120);
  });

  it('fails, with /fail and an alert, when --since cannot be resolved, before reading the logs (scripts F4)', () => {
    // Resolved after the trap, so a failure of systemd-analyze is a failure the dead-man
    // check and the owner hear about, not a usage error that pings nothing.
    const r = run({ ...scanned, args: ['--since', 'not a time', '--ping'], env: { HC_EMAILSCAN_PING_URL: PING } });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('systemd-analyze');
    expect(r.journalctl).toEqual([]);
    expect(r.docker).toEqual([]);
    expect(r.curlStdin).toContain(`url = "${PING}/fail"`);
    expect(r.curlStdin).toContain('email scan failed');
  });

  it('writes the pattern list to a mode-600 file in a mode-700 directory', () => {
    const r = run(scanned);
    expect(r.patternFileMode).toBe('600');
    expect(r.patternDirMode).toBe('700');
  });
});

describe('makrai-email-scan.sh output', () => {
  it('prints only counts', () => {
    const r = run(scanned);
    expect(r.stdout.trimEnd()).toMatch(/^patterns=\d+ account_hits=\d+ shape_hits=\d+ shape_hits_nginx=\d+ shape_hits_sshd=\d+$/);
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stdout.trimEnd().split('\n')).toHaveLength(1);
    expectNoAddress(r);
  });

  it('counts a pattern hit in any case, and counts shape hits for addresses that are not accounts', () => {
    const r = run(scanned);
    expect(r.stdout).toBe('patterns=2 account_hits=2 shape_hits=3 shape_hits_nginx=0 shape_hits_sshd=0\n');
  });

  it('exits 1 when anything was found and 0 when nothing was', () => {
    expect(run(scanned).status).toBe(1);
    const clean = run({ ...scanned, journal: '{"event":"AUTH_LOGIN_FAILURE","userId":"u1"}\nGET /health 200\n' });
    expect(clean.stdout).toBe('patterns=2 account_hits=0 shape_hits=0 shape_hits_nginx=0 shape_hits_sshd=0\n');
    expect(clean.status).toBe(0);
  });

  it('exit 1 means a finding and nothing else: an unexpected failure exits 3 with a reason', () => {
    // `date` failing is not one of the cases the script names, so it dies on `set -e` with
    // status 1, which a caller would read as "found something". It must come out as 3.
    const r = run({
      ...scanned,
      prepare: (dir) => {
        writeFileSync(path.join(dir, 'bin', 'date'), '#!/usr/bin/env bash\nexit 1\n');
        chmodSync(path.join(dir, 'bin', 'date'), 0o755);
      },
    });
    expect(r.status).toBe(3);
    expect(r.stdout, 'no counts line: nothing was found because nothing was scanned').toBe('');
    expect(r.stderr).toContain('unexpectedly');
    expect(r.leftovers).toEqual([]);
  });

  it('a .env that cannot be loaded exits 3 too, not the bare status 1', () => {
    const r = run({
      ...scanned,
      prepare: (dir) => {
        // The library is the sandbox's own, so a failing read_env is one appended line.
        writeFileSync(path.join(dir, 'host', 'makrai-lib.sh'), 'read_env() { return 1; }\nping_ok() { :; }\nping_fail() { :; }\nalert() { :; }\n');
      },
    });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.docker, 'nothing is read before the environment is').toEqual([]);
  });

  it('an unexpected failure under --ping sends /fail and an alert, not a success', () => {
    const r = run({
      ...scanned,
      args: ['--ping'],
      env: { HC_EMAILSCAN_PING_URL: PING },
      prepare: (dir) => {
        writeFileSync(path.join(dir, 'bin', 'date'), '#!/usr/bin/env bash\nexit 1\n');
        chmodSync(path.join(dir, 'bin', 'date'), 0o755);
      },
    });
    expect(r.status).toBe(3);
    expect(r.curlStdin).toContain(`url = "${PING}/fail"`);
    expect(r.curlStdin).toContain('email scan failed');
  });

  it('prints no address even when psql, the journal and the shape file all fail', () => {
    for (const r of [
      run({ ...scanned, dockerFails: true }),
      run({ ...scanned, journalFails: true }),
      run({ ...scanned, shape: null }),
    ]) {
      expect(r.status).not.toBe(0);
      expectNoAddress(r);
    }
  });
});

describe('makrai-email-scan.sh counts address shapes from nginx apart (R22-3)', () => {
  // Any client can put an address-shaped string in a request path, and nginx logs the path.
  // Those are reported, as shape_hits_nginx, and never fail the run. An account address
  // fails wherever it is, and a shape anywhere else still fails.
  const NGINX_LINE = '203.0.113.20 - [2026-10-15T03:00:00+00:00] "GET /wp-login/probe@scanner.example.org HTTP/1.1" 404 0 0.001';
  const APP_LINE = '{"event":"AUTH_LOGIN_FAILURE","userId":"u1"}';

  it('reports a shape hit from the nginx container without failing', () => {
    const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\n`, nginx: `${NGINX_LINE}\n` });
    expect(r.stdout).toBe('patterns=2 account_hits=0 shape_hits=0 shape_hits_nginx=1 shape_hits_sshd=0\n');
    expect(r.status).toBe(0);
  });

  it('still fails on an account address in an nginx line', () => {
    const line = `203.0.113.20 - [2026-10-15T03:00:00+00:00] "GET /orgs/${OWNER} HTTP/1.1" 404 0 0.001`;
    const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\n`, nginx: `${line}\n` });
    expect(r.stdout).toBe('patterns=2 account_hits=1 shape_hits=0 shape_hits_nginx=1 shape_hits_sshd=0\n');
    expect(r.status).toBe(1);
  });

  it('still fails on a shape hit from any other source', () => {
    const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\nInvalid user ${BOT} from 203.0.113.9\n`, nginx: `${NGINX_LINE}\n` });
    expect(r.stdout).toBe('patterns=2 account_hits=0 shape_hits=1 shape_hits_nginx=1 shape_hits_sshd=0\n');
    expect(r.status).toBe(1);
  });

  it('counts a forged nginx name under another unit as another source, and fails (S4)', () => {
    // A local process (named sudo here, so that it is not sshd's either) sends
    // CONTAINER_NAME=docker-nginx-1 with an address-shaped message. It is not the nginx
    // container: it counts in shape_hits, and nothing is subtracted to make room for it.
    const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\n`, nginx: `${NGINX_LINE}\n`, forged: `Invalid user ${BOT} from 203.0.113.9\n` });
    expect(r.stdout).toBe('patterns=2 account_hits=0 shape_hits=1 shape_hits_nginx=1 shape_hits_sshd=0\n');
    expect(r.status).toBe(1);
  });

  it('reads the nginx container by its name AND the trusted unit, over the same window as the other passes', () => {
    const r = run({ ...scanned, args: ['--since', '2026-10-08 06:00:00'] });
    const nginx = r.journalctl.filter((argv) => argv.includes(NGINX_MATCH));
    expect(nginx.length).toBeGreaterThan(0);
    for (const argv of nginx) {
      // Two fields in one group: journalctl ANDs them. No "+", which would OR them.
      expect(argv.filter((a) => /^[A-Z_]+=/.test(a)).sort()).toEqual([NGINX_MATCH, DOCKER_UNIT].sort());
      expect(argv).not.toContain('+');
      expect(argv.slice(argv.indexOf('-o'), argv.indexOf('-o') + 2)).toEqual(['-o', 'cat']);
    }
    expect(new Set(r.journalctl.map((a) => a.find((x) => x.startsWith('--since=')))).size).toBe(1);
    expect(new Set(r.journalctl.map((a) => a.find((x) => x.startsWith('--until=')))).size).toBe(1);
  });

  it('counts the other sources directly, never as everything minus nginx', () => {
    // Whatever the nginx pass finds, the other-sources count does not move.
    const base = run({ patterns: PATTERNS, journal: `Invalid user ${BOT} from 203.0.113.9\n` });
    const more = run({ patterns: PATTERNS, journal: `Invalid user ${BOT} from 203.0.113.9\n`, nginx: `${NGINX_LINE}\n${NGINX_LINE}\n` });
    expect(base.stdout).toBe('patterns=2 account_hits=0 shape_hits=1 shape_hits_nginx=0 shape_hits_sshd=0\n');
    expect(more.stdout).toBe('patterns=2 account_hits=0 shape_hits=1 shape_hits_nginx=2 shape_hits_sshd=0\n');
  });

  it('does not subtract: lines only the nginx pass sees move shape_hits_nginx and leave shape_hits alone', () => {
    // The stub serves these three lines to the dedicated nginx pass and NOT to the export read that
    // shape_hits is made from. If shape_hits were "its own read minus shape_hits_nginx" it would go to -2.
    const r = run({ patterns: PATTERNS, journal: `Invalid user ${BOT} from 203.0.113.9\n`, nginxPassOnly: `${NGINX_LINE}\n${NGINX_LINE}\n${NGINX_LINE}\n` });
    expect(r.stdout).toBe('patterns=2 account_hits=0 shape_hits=1 shape_hits_nginx=3 shape_hits_sshd=0\n');
    expect(r.status).toBe(1);
  });

  it('counts every shape in a --file scan as failing: a file carries no container name', () => {
    const r = run({ patterns: PATTERNS, fileText: `${NGINX_LINE}\n` });
    expect(r.stdout).toBe('patterns=2 account_hits=0 shape_hits=1 shape_hits_nginx=0 shape_hits_sshd=0\n');
    expect(r.status).toBe(1);
  });

  it('ends a run that sends an alert with its counts line, so a log taking both streams ends in it', () => {
    // The crontab appends stdout and stderr to /var/log/makrai/email-scan.log, and Task 25
    // reads its last line. The library reports the alert on stderr, after the scan is done.
    const r = run({
      ...scanned,
      args: ['--ping'],
      env: { HC_EMAILSCAN_PING_URL: PING },
      prepare: (dir) => {
        // One file for both streams, as `>> log 2>&1` gives: wrap the script.
        const host = path.join(dir, 'host');
        const real = path.join(host, SCRIPT);
        copyFileSync(real, path.join(host, 'real-scan.sh'));
        writeFileSync(real, `#!/usr/bin/env bash\nbash "${path.join(host, 'real-scan.sh')}" "$@" >> "${path.join(dir, 'both.log')}" 2>&1\n`);
      },
      after: (dir) => {
        const lines = readFileSync(path.join(dir, 'both.log'), 'utf8').trimEnd().split('\n');
        expect(lines.some((l) => l.includes('alert accepted')), 'the alert was reported in the log').toBe(true);
        expect(lines.at(-1)).toBe('patterns=2 account_hits=2 shape_hits=3 shape_hits_nginx=0 shape_hits_sshd=0');
      },
    });
    expect(r.status).toBe(1);
  });
});

/** The counts line, built from its parts, in the order the script prints them. */
function counts(account: number, shape: number, nginx = 0, sshd = 0, patterns = 2): string {
  return `patterns=${patterns} account_hits=${account} shape_hits=${shape} shape_hits_nginx=${nginx} shape_hits_sshd=${sshd}\n`;
}

describe('makrai-email-scan.sh ignores systemd unit names (T22c-1 a)', () => {
  // `user@1000.service` and `getty@tty1.service` are shaped like an address and are not one: the
  // journal is full of them. They are removed from each line before the shape is matched, as
  // whole tokens, so that a real address on the same line is still found.
  const APP_LINE = '{"event":"AUTH_LOGIN_FAILURE","userId":"u1"}';
  const SUFFIXES = ['service', 'socket', 'timer', 'target', 'mount', 'slice', 'scope', 'path', 'device', 'swap'];

  it.each(SUFFIXES)('does not count a templated unit name ending in .%s', (suffix) => {
    const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\nStarted unit-name@instance1.${suffix} - a unit.\n` });
    expect(r.stdout).toBe(counts(0, 0));
    expect(r.status).toBe(0);
  });

  it.each([
    'Started user@1000.service - User Manager for UID 1000.',
    'Started getty@tty1.service - Getty on tty1.',
    'Stopped getty@tty1.service.',
    'user@1000.service: Deactivated successfully.',
    'Stopped user-runtime-dir@1000.service - User Runtime Directory /run/user/1000.',
    '(getty@tty1.service)',
    'Started a@b.service, c@d.timer and e@f.socket',
    'user@1000.service',
  ])('does not count the line %j', (message) => {
    const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\n${message}\n` });
    expect(r.stdout).toBe(counts(0, 0));
    expect(r.status).toBe(0);
  });

  it('strips the unit names from every count: nginx, sshd and a --file scan as well', () => {
    const unit = 'Started user@1000.service - User Manager for UID 1000.\n';
    const viaNginx = run({ patterns: PATTERNS, journal: `${APP_LINE}\n`, nginx: unit });
    expect(viaNginx.stdout).toBe(counts(0, 0));
    expect(viaNginx.status).toBe(0);
    const viaSshd = run({ patterns: PATTERNS, journal: `${APP_LINE}\n`, sshd: unit });
    expect(viaSshd.stdout).toBe(counts(0, 0));
    expect(viaSshd.status).toBe(0);
    const viaFile = run({ patterns: PATTERNS, fileText: `${APP_LINE}\n${unit}` });
    expect(viaFile.stdout).toBe(counts(0, 0));
    expect(viaFile.status).toBe(0);
  });

  it.each([
    `Started user@1000.service for ${BOT}`,
    `${BOT} was seen by getty@tty1.service`,
    `user@1000.service,${BOT}`,
    `${BOT},user@1000.service`,
    `(${BOT}) user@1000.service getty@tty1.service.`,
    `Stopped user@1000.service. Invalid user ${BOT} from 203.0.113.9`,
  ])('still counts a line holding a unit name AND a real address shape: %j', (message) => {
    const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\n${message}\n` });
    expect(r.stdout).toBe(counts(0, 1));
    expect(r.status).toBe(1);
  });

  it('still counts a line holding a unit name and a real address, from nginx, sshd and a --file scan', () => {
    const both = `Started user@1000.service for ${BOT}\n`;
    const viaNginx = run({ patterns: PATTERNS, journal: `${APP_LINE}\n`, nginx: both });
    expect(viaNginx.stdout).toBe(counts(0, 0, 1, 0));
    const viaSshd = run({ patterns: PATTERNS, journal: `${APP_LINE}\n`, sshd: both });
    expect(viaSshd.stdout).toBe(counts(0, 0, 0, 1));
    const viaFile = run({ patterns: PATTERNS, fileText: `${APP_LINE}\n${both}` });
    expect(viaFile.stdout).toBe(counts(0, 1));
    expect(viaFile.status).toBe(1);
  });

  it.each([
    ['a suffix that is only the start of a longer word', 'x@example.servicefoo'],
    ['a suffix in the middle of the domain, not at its end', 'x@svc.service.example.org'],
    ['a unit-looking local part with a real domain', 'getty.service@example.org'],
    // The "@" after the type keeps the token going, so it is not a whole unit name and is counted. The
    // next domain has no dot, so that if the "@" did end the token, what is left (x@localhost) would
    // match nothing; with the "@" it ends, this line would come out clean.
    ['a unit name followed at once by another "@", so that the token goes on', 'x@y.service@localhost'],
  ])('does not mistake %s for a unit name: %s', (_why, token) => {
    const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\nSeen ${token} here\n` });
    expect(r.stdout).toBe(counts(0, 1));
    expect(r.status).toBe(1);
  });

  it('never strips anything before the account check: an account address that ends in a unit suffix is still a hit', () => {
    // The account's domain ends in a unit suffix on purpose: it is the one kind of address the strip WOULD
    // remove, so a hit here shows that account_hits reads the lines before any stripping.
    const r = run({
      patterns: `${OWNER}\n${SECOND}\nops@fleet.service\n`,
      journal: `${APP_LINE}\nStarted ops@fleet.service - a unit.\n`,
    });
    // One account hit; the unit-shaped token is no shape hit.
    expect(r.stdout).toBe(counts(1, 0, 0, 0, 3));
    expect(r.status).toBe(1);
  });
});

describe('makrai-email-scan.sh counts address shapes from sshd apart (T22c-1 b)', () => {
  // Any client can send an address-shaped username, and sshd logs the username it was given. Those
  // are reported, as shape_hits_sshd, and never fail the run. An account address fails wherever it
  // is, and a shape anywhere else still fails. A line is sshd's by the trusted _COMM of its record.
  const APP_LINE = '{"event":"AUTH_LOGIN_FAILURE","userId":"u1"}';
  const INVALID = 'Failed password for invalid user a@b.example from 203.0.113.9 port 4022 ssh2';
  const NGINX_LINE = '203.0.113.20 - [2026-10-15T03:00:00+00:00] "GET /wp-login/probe@scanner.example.org HTTP/1.1" 404 0 0.001';

  it.each(['sshd-session', 'sshd'])('reports a shape quoted by an invalid-user line from _COMM=%s without failing', (comm) => {
    const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\n`, sshd: `${INVALID}\n`, sshdComm: comm });
    expect(r.stdout).toBe(counts(0, 0, 0, 1));
    expect(r.status).toBe(0);
  });

  it('still fails on an account address in an sshd line', () => {
    const line = `Failed password for invalid user ${OWNER} from 203.0.113.9 port 4022 ssh2`;
    const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\n`, sshd: `${line}\n` });
    expect(r.stdout).toBe(counts(1, 0, 0, 1));
    expect(r.status).toBe(1);
  });

  it('still fails on a shape hit from any other source, and counts each source in its own field', () => {
    const r = run({
      patterns: PATTERNS,
      journal: `${APP_LINE}\nInvalid user ${BOT} from 203.0.113.9\n`,
      nginx: `${NGINX_LINE}\n`,
      sshd: `${INVALID}\n`,
    });
    expect(r.stdout).toBe(counts(0, 1, 1, 1));
    expect(r.status).toBe(1);
  });

  it('does not take a line for sshd'
    + "'s because it says so: only the record's _COMM does", () => {
    // The journal's other sources (here: docker.service, _COMM=dockerd) can print anything, including
    // the words sshd-session. The split is on the record's trusted field, never on the text.
    const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\nsshd-session[4242]: ${INVALID.replace('a@b.example', BOT)}\n` });
    expect(r.stdout).toBe(counts(0, 1));
    expect(r.status).toBe(1);
  });

  it('counts the other sources directly, never as everything minus sshd', () => {
    // Whatever the sshd pass finds, the other-sources count does not move, and the other way round.
    const base = run({ patterns: PATTERNS, journal: `Invalid user ${BOT} from 203.0.113.9\n` });
    const more = run({ patterns: PATTERNS, journal: `Invalid user ${BOT} from 203.0.113.9\n`, sshd: `${INVALID}\n${INVALID}\n` });
    expect(base.stdout).toBe(counts(0, 1, 0, 0));
    expect(more.stdout).toBe(counts(0, 1, 0, 2));
    const onlySshd = run({ patterns: PATTERNS, journal: `${APP_LINE}\n`, sshd: `${INVALID}\n` });
    expect(onlySshd.stdout).toBe(counts(0, 0, 0, 1));
  });

  it('does not subtract: lines only the sshd pass sees move shape_hits_sshd and leave shape_hits alone', () => {
    // The stub serves these three lines to the dedicated _COMM pass and NOT to the export read that
    // shape_hits is made from. If shape_hits were "its own read minus shape_hits_sshd" it would go to -2.
    const r = run({ patterns: PATTERNS, journal: `Invalid user ${BOT} from 203.0.113.9\n`, sshdPassOnly: `${INVALID}\n${INVALID}\n${INVALID}\n` });
    expect(r.stdout).toBe(counts(0, 1, 0, 3));
    expect(r.status).toBe(1);
  });

  describe("the split is on the record's _COMM, and on nothing else", () => {
    // The stub exports each of these with the _COMM and the _SYSTEMD_UNIT given, so that the two can be
    // pulled apart. A split keyed on the unit (the stub's sshd lines are all under ssh.service), or on a
    // prefix of the process name, would pass every test above and fail one of these.
    const record = (comm: string, unit: string, message: string) => ({ comm, unit, message });

    it('does not take a record for sshd just because it is under sshd\'s unit: its _COMM is what counts', () => {
      const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\n`, records: [record('sudo', 'ssh.service', `Invalid user ${BOT} from 203.0.113.9`)] });
      expect(r.stdout).toBe(counts(0, 1, 0, 0));
      expect(r.status).toBe(1);
    });

    it.each(['sshd-foo', 'sshdx', 'sshd-session2', 'sshd-'])('does not take _COMM=%s for sshd: the name must be exactly sshd or sshd-session', (comm) => {
      const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\n`, records: [record(comm, 'docker.service', `Invalid user ${BOT} from 203.0.113.9`)] });
      expect(r.stdout).toBe(counts(0, 1, 0, 0));
      expect(r.status).toBe(1);
    });

    it.each([
      ['sshd', 'session-3.scope'],
      ['sshd-session', 'session-3.scope'],
      ['sshd-session', 'user@1000.service'],
      ['sshd', 'sshd.service'],
    ])('takes _COMM=%s under %s for sshd: reported in shape_hits_sshd, not in shape_hits', (comm, unit) => {
      const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\n`, records: [record(comm, unit, INVALID)] });
      expect(r.stdout).toBe(counts(0, 0, 0, 1));
      expect(r.status).toBe(0);
    });
  });

  it('reads sshd by its _COMM alone, over the same window as the other passes', () => {
    const r = run({ ...scanned, args: ['--since', '2026-10-08 06:00:00'] });
    const sshd = r.journalctl.filter(isSshdPass);
    expect(sshd).toHaveLength(1);
    for (const argv of sshd) {
      // Both process names, ORed as two values of one field: no "+", which would add a group,
      // and no unit or container match, which a local process can send.
      expect(argv.filter((a) => /^[A-Z_]+=/.test(a)).sort()).toEqual([...SSHD_COMMS].sort());
      expect(argv).not.toContain('+');
      expect(argv.slice(argv.indexOf('-o'), argv.indexOf('-o') + 2)).toEqual(['-o', 'cat']);
      expect(argv).toContain('--no-pager');
    }
    expect(new Set(r.journalctl.map((a) => a.find((x) => x.startsWith('--since=')))).size).toBe(1);
    expect(new Set(r.journalctl.map((a) => a.find((x) => x.startsWith('--until=')))).size).toBe(1);
  });

  it('counts every shape in a --file scan as failing: a file carries no process name', () => {
    const r = run({ patterns: PATTERNS, fileText: `${INVALID}\n` });
    expect(r.stdout).toBe(counts(0, 1, 0, 0));
    expect(r.status).toBe(1);
  });

  it('does not read sshd from the journal in a --file scan', () => {
    const r = run({ patterns: PATTERNS, fileText: `${INVALID}\n` });
    expect(r.journalctl).toEqual([]);
  });
});

describe('makrai-email-scan.sh counts line', () => {
  it('has the five fields, in this order, so that anything reading the first four by name or position still works', () => {
    const r = run(scanned);
    const fields = r.stdout.trimEnd().split(' ').map((f) => f.split('=')[0]);
    expect(fields).toEqual(['patterns', 'account_hits', 'shape_hits', 'shape_hits_nginx', 'shape_hits_sshd']);
    expect(r.stdout.trimEnd().split(' ').every((f) => /^[a-z_]+=\d+$/.test(f))).toBe(true);
  });

  it('exits 1 only for an account hit anywhere or a shape hit outside nginx AND sshd', () => {
    const quiet = '{"event":"AUTH_LOGIN_FAILURE","userId":"u1"}\n';
    const ngx = '203.0.113.20 "GET /probe@scanner.example.org HTTP/1.1" 404\n';
    const ssh = 'Failed password for invalid user a@b.example from 203.0.113.9 port 4022 ssh2\n';
    expect(run({ patterns: PATTERNS, journal: quiet, nginx: ngx, sshd: ssh }).status).toBe(0);
    expect(run({ patterns: PATTERNS, journal: `${quiet}Invalid user ${BOT}\n`, nginx: ngx, sshd: ssh }).status).toBe(1);
    expect(run({ patterns: PATTERNS, journal: quiet, nginx: ngx, sshd: `Failed password for invalid user ${OWNER}\n` }).status).toBe(1);
    expect(run({ patterns: PATTERNS, journal: quiet, nginx: `GET /orgs/${OWNER} HTTP/1.1\n`, sshd: ssh }).status).toBe(1);
  });
});

describe('makrai-email-scan.sh --file', () => {
  it('scans a gzip file and does not read the journal', () => {
    const r = run({ patterns: PATTERNS, fileText: JOURNAL });
    expect(r.stdout).toBe('patterns=2 account_hits=2 shape_hits=3 shape_hits_nginx=0 shape_hits_sshd=0\n');
    expect(r.journalctl).toEqual([]);
  });

  it('fails on a file that is not gzip, rather than reporting 0', () => {
    const r = run({
      patterns: PATTERNS,
      prepare: (dir) => writeFileSync(path.join(dir, 'plain.txt'), JOURNAL),
      args: ['--file', '{DIR}/plain.txt'],
    });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('');
  });

  it('fails on a missing file', () => {
    const r = run({ patterns: PATTERNS, args: ['--file', '/nonexistent/log.gz'] });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('');
  });

  it('refuses --file together with --since, which would otherwise ignore one silently', () => {
    const r = run({ patterns: PATTERNS, fileText: JOURNAL, args: ['--since', 'yesterday'] });
    expect(r.status).toBe(64);
    expect(r.stdout).toBe('');
  });
});

describe('makrai-email-scan.sh arguments', () => {
  it.each([[['--bogus']], [['--since']], [['--file']], [['--write-patterns']], [['stray']], [['--ping', '--write-patterns', '/x']]])(
    'rejects %j with exit 64 and reads nothing',
    (args) => {
      const r = run({ ...scanned, args });
      expect(r.status).toBe(64);
      expect(r.stdout).toBe('');
      expect(r.docker).toEqual([]);
      expect(r.journalctl).toEqual([]);
    },
  );
});

describe('makrai-email-scan.sh --ping', () => {
  const ping = { HC_EMAILSCAN_PING_URL: PING };

  it('pings success on zero hits, with the URL on stdin and not in argv', () => {
    const r = run({ ...scanned, journal: 'GET /health 200\n', args: ['--ping'], env: ping });
    expect(r.status).toBe(0);
    expect(r.curlStdin).toBe(`url = "${PING}"\n`);
    expect(r.curlArgv).not.toContain('ping-sentinel');
    expect(r.curlArgv, 'no alert on a clean scan').not.toContain('api.resend.com');
  });

  it('pings /fail and sends an alert on a hit, and still prints the counts', () => {
    const r = run({ ...scanned, args: ['--ping'], env: ping });
    expect(r.status).toBe(1);
    expect(r.curlStdin).toContain(`url = "${PING}/fail"`);
    expect(r.curlStdin).not.toContain(`url = "${PING}"\n`);
    expect(r.curlArgv).toContain('https://api.resend.com/emails');
    expect(r.stdout).toBe('patterns=2 account_hits=2 shape_hits=3 shape_hits_nginx=0 shape_hits_sshd=0\n');
    // The alert carries a subject and fixed text: no count, no line, no address.
    expect(r.curlStdin).toContain('email scan');
    // (It does carry the administrator's own address, as the recipient: that is the alert's job.)
    for (const a of [OWNER, SECOND, BOT]) expect(r.curlStdin.toLowerCase()).not.toContain(a.toLowerCase());
  });

  it('pings /fail and alerts when it refuses, so a broken scan is not mistaken for a clean one', () => {
    const r = run({ patterns: '', journal: JOURNAL, args: ['--ping'], env: ping });
    expect(r.status).toBe(2);
    expect(r.curlStdin).toContain(`url = "${PING}/fail"`);
    expect(r.curlArgv).toContain('https://api.resend.com/emails');
  });

  it('pings /fail and alerts when the journal cannot be read', () => {
    const r = run({ ...scanned, journalFails: true, args: ['--ping'], env: ping });
    expect(r.status).toBe(3);
    expect(r.curlStdin).toContain(`url = "${PING}/fail"`);
  });

  it('does not ping without --ping', () => {
    const r = run({ ...scanned, env: ping });
    expect(r.curlArgv).toBe('');
    expect(r.curlStdin).toBe('');
  });

  it('fails, and says why, when --ping is asked for and the URL is not set', () => {
    const r = run({ ...scanned, journal: 'GET /health 200\n', args: ['--ping'] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('HC_EMAILSCAN_PING_URL');
    expect(r.stdout, 'the counts are still printed').toBe('patterns=2 account_hits=0 shape_hits=0 shape_hits_nginx=0 shape_hits_sshd=0\n');
  });
});

describe("makrai-lib.sh's alert never shows what the provider said", () => {
  // M2. When Resend refuses a mail in testing mode its body names the account owner's
  // address ("You can only send testing emails to your own email address (...)"). The
  // library used to print the first 300 bytes of that body to stderr, which a scheduled
  // job's log would then keep. It prints the status and nothing else.
  const RESEND_BODY = `{"statusCode":403,"message":"You can only send testing emails to your own email address (${OWNER})","name":"validation_error"}`;
  const ping = { HC_EMAILSCAN_PING_URL: PING };

  it('prints the HTTP status of a refused alert, and not the body', () => {
    const r = run({ ...scanned, args: ['--ping'], env: { ...ping, STUB_CURL_CODE: '403', STUB_CURL_BODY: RESEND_BODY } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('alert NOT delivered (HTTP 403)');
    expect(r.stderr).not.toContain('validation_error');
    expectNoAddress(r);
  });

  it('prints no curl message either when there is no status to print', () => {
    const r = run({ ...scanned, args: ['--ping'], env: { ...ping, STUB_CURL_FAIL: OWNER } });
    expect(r.stderr).toContain('alert NOT delivered');
    expect(r.stderr).toContain('no HTTP status');
    expect(r.stderr, "curl's own message is not printed").not.toContain('could not resolve');
    expectNoAddress(r);
  });

  it('still says an accepted alert was accepted', () => {
    const r = run({ ...scanned, args: ['--ping'], env: ping });
    expect(r.stderr).toContain('alert accepted by Resend (HTTP 200)');
  });
});

describe('makrai-email-scan.sh leaves nothing behind', () => {
  it.each([
    ['a clean scan', { ...scanned, journal: 'GET /health 200\n' }],
    ['a scan with hits', scanned],
    ['a refusal', { patterns: '', journal: JOURNAL }],
    ['a failed psql', { ...scanned, dockerFails: true }],
    ['a failed journal read', { ...scanned, journalFails: true }],
    ['a gzip file scan', { patterns: PATTERNS, fileText: JOURNAL }],
  ] as [string, Opts][])('the pattern file is shredded after %s', (_name, opts) => {
    const r = run(opts);
    expect(r.leftovers).toEqual([]);
  });
});

describe('makrai-email-scan.sh failures are loud, and say nothing about rows', () => {
  it('fails with 3 when psql fails, and prints neither the counts nor what psql said', () => {
    const r = run({ ...scanned, dockerFails: true });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toContain('could not look up');
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it('fails with 3 when the journal cannot be read, rather than counting 0', () => {
    const r = run({ ...scanned, journalFails: true });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('journal');
  });
});

describe('makrai-email-scan.sh --write-patterns', () => {
  it('writes the guarded list to the file named, mode 600, prints only a count, and does not scan', () => {
    let written = '';
    let mode = 0;
    const r = run({
      ...scanned,
      args: ['--write-patterns', '{DIR}/patterns.out'],
      after: (dir) => {
        const f = path.join(dir, 'patterns.out');
        written = readFileSync(f, 'utf8');
        mode = statSync(f).mode & 0o777;
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('patterns=2\n');
    expect(written).toBe(PATTERNS);
    expect(mode).toBe(0o600);
    expect(r.journalctl, 'writing the list scans nothing').toEqual([]);
    expect(r.leftovers, "the working copy is shredded; the written file is the caller's").toEqual([]);
  });

  it('treats a value that looks like an option as a file name', () => {
    // `install` would read `--help` as its own option: usage on stdout, exit 0, no file.
    let written = '';
    let mode = 0;
    const r = run({
      ...scanned,
      args: ['--write-patterns', '--help'],
      inWorkDir: true,
      after: (dir) => {
        const f = path.join(dir, 'work', '--help');
        written = readFileSync(f, 'utf8');
        mode = statSync(f).mode & 0o777;
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout, "install's usage must not reach stdout").toBe('patterns=2\n');
    expect(written).toBe(PATTERNS);
    expect(mode).toBe(0o600);
  });

  it('fails rather than drop a file inside a directory it was given', () => {
    let inside: string[] = ['unset'];
    const r = run({
      ...scanned,
      args: ['--write-patterns', '{DIR}/out-dir'],
      prepare: (dir) => mkdirSync(path.join(dir, 'out-dir')),
      after: (dir) => {
        inside = readdirSync(path.join(dir, 'out-dir'));
      },
    });
    expect(r.status).toBe(3);
    expect(inside).toEqual([]);
  });

  it('refuses an empty list the same way, and writes no file', () => {
    let exists = true;
    const r = run({
      patterns: '',
      users: 2,
      args: ['--write-patterns', '{DIR}/patterns.out'],
      after: (dir) => {
        exists = existsSync(path.join(dir, 'patterns.out'));
      },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('EMPTY-PATTERNS');
    expect(exists).toBe(false);
  });
});

describe('makrai-email-scan.sh reads the shape from the file beside it', () => {
  it('follows the file: a different expression gives different counts', () => {
    // Proves the expression is read at run time, not copied into the script.
    const r = run({ ...scanned, shape: 'GET /health\n', journal: 'GET /health 200\nGET /login 200\n' });
    expect(r.stdout).toBe('patterns=2 account_hits=0 shape_hits=1 shape_hits_nginx=0 shape_hits_sshd=0\n');
  });

  it.each([
    ['missing', null],
    ['empty', ''],
    ['only a newline', '\n'],
    ['two lines, one of them blank, which matches everything', '[a-z]+@x\n\n'],
    ['two expressions', 'a@b\nc@d\n'],
  ] as [string, string | null][])('refuses a shape file that is %s', (_name, shape) => {
    const r = run({ ...scanned, shape });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(SHAPE_FILE);
    expect(r.docker, 'checked before the database is read').toEqual([]);
  });
});

describe('the script itself', () => {
  const source = readFileSync(path.join(HOST, SCRIPT), 'utf8');
  const code = source.split('\n').filter((l) => !l.trim().startsWith('#') && l.trim() !== '');

  it('starts with set -Eeuo pipefail', () => {
    expect(code[0]).toBe('set -Eeuo pipefail');
  });

  it('does not carry a copy of the expression', () => {
    // D-09: one copy, in the file. A second one here is the drift the equality test in
    // redact.test.ts exists to prevent.
    expect(source).not.toContain('[A-Za-z0-9._%+-]');
    expect(source).not.toContain(EMAIL_SHAPE_SOURCE);
  });

  it('sources the shared library, reads .env only through read_env, never executing it, and pings through it', () => {
    const text = code.join('\n');
    expect(text).toMatch(/makrai-lib\.sh/);
    // T22-3: root never sources the operator-writable .env.
    expect(code.some((l) => /^read_env( [A-Z_]+)+$/.test(l))).toBe(true);
    expect(text).not.toMatch(/\bload_env\b/);
    expect(text.split('\n').filter((l) => /\.env\b/.test(l))).toEqual([]);
    expect(text).toContain('ping_ok HC_EMAILSCAN_PING_URL');
    expect(text).toContain('ping_fail HC_EMAILSCAN_PING_URL');
    expect(text).toMatch(/\balert "/);
  });

  it('keeps the pattern list off disk: its working directory is made in /dev/shm unless TMPDIR says otherwise', () => {
    // M8. /tmp is ext4 on the host and `shred` is best effort on a journaling filesystem;
    // a SIGKILL leaves the list until tmp cleanup. /dev/shm is tmpfs.
    const text = code.join('\n');
    expect(text).toMatch(/mktemp -d -p "\$\{TMPDIR:-\/dev\/shm\}"/);
    let asked = '';
    const r = run({
      ...scanned,
      env: { TMPDIR: '' },
      prepare: (dir) => {
        // A stand-in that records where it was asked to make the directory, and makes it in
        // the sandbox instead so nothing is written to the real /dev/shm.
        writeFileSync(
          path.join(dir, 'bin', 'mktemp'),
          `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$REC/mktemp-argv"\nexec /usr/bin/mktemp -d -p "${path.join(dir, 'tmp')}"\n`,
        );
        chmodSync(path.join(dir, 'bin', 'mktemp'), 0o755);
      },
      after: (dir) => {
        asked = readFileSync(path.join(dir, 'rec', 'mktemp-argv'), 'utf8');
      },
    });
    expect(r.status).toBe(1);
    expect(asked.split('\n')).toEqual(['-d', '-p', '/dev/shm', '']);
  });

  it('shreds in a trap on EXIT, and never traces', () => {
    const text = code.join('\n');
    expect(text).toMatch(/^trap \w+ EXIT$/m);
    expect(text).toMatch(/\bshred -u\b/);
    expect(text).not.toMatch(/\bset\s+-\w*x/);
    expect(text).not.toMatch(/\bset\s+-o\s+xtrace/);
  });

  it('gives no address, URL or key to curl, and passes no pattern in argv', () => {
    const text = code.join('\n');
    expect(text, 'this script never calls curl itself; the library does').not.toMatch(/\bcurl\b/);
  });
});

describe('the shape expression, in grep -E and in JavaScript', () => {
  // D-09: both read ops/host/email-shape.regex. Proven here on a corpus, in both
  // directions, so neither can quietly accept what the other refuses.
  const matches = [
    'a@b.example',
    'owner@example.org',
    'A.B+tag@Sub.Example.ORG',
    'first_last-1%x@xn--bcher-kva.example',
    'x@y.example',
    `prefix ${OWNER} suffix`,
    '(a.b@c-d.example.org)',
  ];
  const clean = ['a@b', 'a@b.c', '@example.org', 'user@localhost', 'pkg@1.2.3', '197.157.0.1', 'no at sign.example.org', 'a @b.example', ''];

  it.each([...matches.map((s) => [s, true] as const), ...clean.map((s) => [s, false] as const)])(
    'agrees on %j (address: %s)',
    (s, expected) => {
      const shape = readFileSync(path.join(HOST, SHAPE_FILE), 'utf8').replace(/\n$/, '');
      const g = spawnSync('grep', ['-Ec', '-e', shape], { input: `${s}\n`, encoding: 'utf8', env: { NODE_ENV: 'test', LC_ALL: 'C', PATH: '/usr/bin:/bin' } });
      expect(g.status === 0, `grep -E said ${g.status}`).toBe(expected);
      expect(redactText(s) !== s, 'redactText').toBe(expected);
    },
  );
});

describe('the one place the two engines are meant to differ', () => {
  it('a percent-encoded address is redacted by redactText and not counted by the shell scan', () => {
    // M7, and a limit on purpose: the redactor also reads `user%40example.org`, which is how an
    // address looks in a path or a query string. The scan keeps the plain expression, because
    // what it reads is nginx's `$uri`, where the "@" has already been decoded. This pins the
    // difference, so that changing either side is a decision and not an accident.
    const shape = readFileSync(path.join(HOST, SHAPE_FILE), 'utf8').replace(/\n$/, '');
    const encoded = 'GET /orgs/x/user%40example.org HTTP/1.1';
    const g = spawnSync('grep', ['-Ec', '-e', shape], { input: `${encoded}\n`, encoding: 'utf8', env: { NODE_ENV: 'test', LC_ALL: 'C', PATH: '/usr/bin:/bin' } });
    expect(g.status, 'grep -E counted the encoded form').toBe(1);
    expect(redactText(encoded)).toBe('GET /orgs/x/[email-redacted] HTTP/1.1');
  });
});
