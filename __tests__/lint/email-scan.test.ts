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

const HOST = path.resolve('ops/host');
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

/** How the scan selects the nginx container's lines: its journald driver records the name. */
const NGINX_MATCH = 'CONTAINER_NAME=docker-nginx-1';

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
  /** What the nginx container's pass (CONTAINER_NAME=docker-nginx-1) returns. Absent = nothing. */
  nginx?: string;
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
    // The real library, with only load_env replaced: the real one reads the server's .env.
    writeFileSync(
      path.join(host, 'makrai-lib.sh'),
      `. "${path.join(HOST, 'makrai-lib.sh')}"\nload_env() { export POSTGRES_USER=owner_role POSTGRES_DB=app_db; }\n`,
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
for a in "$@"; do
  if [ "$a" = CONTAINER_NAME=docker-nginx-1 ]; then
    if [ -n "\${STUB_NGINX_FILE:-}" ]; then cat "$STUB_NGINX_FILE"; fi
    exit 0
  fi
done
if [ -n "\${STUB_JOURNAL_FILE:-}" ]; then cat "$STUB_JOURNAL_FILE"; fi`,
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
    // The nginx container's own pass is checked in the next describe block.
    const main = r.journalctl.filter((argv) => !argv.includes(NGINX_MATCH));
    expect(main.length).toBeGreaterThan(0);
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
      expect(argv).toContain('--since=2026-10-08 06:00:00');
      expect(argv.some((a) => a.startsWith('--until='))).toBe(true);
      expect(argv).toContain('--no-pager');
      expect(argv.slice(argv.indexOf('-o'), argv.indexOf('-o') + 2)).toEqual(['-o', 'cat']);
    }
    // Every pass reads the same window, or the two counts would describe different logs.
    const untils = new Set(r.journalctl.map((a) => a.find((x) => x.startsWith('--until='))));
    expect(untils.size).toBe(1);
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
    expect(r.stdout.trimEnd()).toMatch(/^patterns=\d+ account_hits=\d+ shape_hits=\d+ shape_hits_nginx=\d+$/);
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stdout.trimEnd().split('\n')).toHaveLength(1);
    expectNoAddress(r);
  });

  it('counts a pattern hit in any case, and counts shape hits for addresses that are not accounts', () => {
    const r = run(scanned);
    expect(r.stdout).toBe('patterns=2 account_hits=2 shape_hits=3 shape_hits_nginx=0\n');
  });

  it('exits 1 when anything was found and 0 when nothing was', () => {
    expect(run(scanned).status).toBe(1);
    const clean = run({ ...scanned, journal: '{"event":"AUTH_LOGIN_FAILURE","userId":"u1"}\nGET /health 200\n' });
    expect(clean.stdout).toBe('patterns=2 account_hits=0 shape_hits=0 shape_hits_nginx=0\n');
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
        // The library is the sandbox's own, so a failing load_env is one appended line.
        writeFileSync(path.join(dir, 'host', 'makrai-lib.sh'), 'load_env() { return 1; }\nping_ok() { :; }\nping_fail() { :; }\nalert() { :; }\n');
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
    const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\n${NGINX_LINE}\n`, nginx: `${NGINX_LINE}\n` });
    expect(r.stdout).toBe('patterns=2 account_hits=0 shape_hits=0 shape_hits_nginx=1\n');
    expect(r.status).toBe(0);
  });

  it('still fails on an account address in an nginx line', () => {
    const line = `203.0.113.20 - [2026-10-15T03:00:00+00:00] "GET /orgs/${OWNER} HTTP/1.1" 404 0 0.001`;
    const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\n${line}\n`, nginx: `${line}\n` });
    expect(r.stdout).toBe('patterns=2 account_hits=1 shape_hits=0 shape_hits_nginx=1\n');
    expect(r.status).toBe(1);
  });

  it('still fails on a shape hit from any other source', () => {
    const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\nInvalid user ${BOT} from 203.0.113.9\n${NGINX_LINE}\n`, nginx: `${NGINX_LINE}\n` });
    expect(r.stdout).toBe('patterns=2 account_hits=0 shape_hits=1 shape_hits_nginx=1\n');
    expect(r.status).toBe(1);
  });

  it('reads the nginx container by its journal name, over the same window as the other passes', () => {
    const r = run({ ...scanned, args: ['--since', '2026-10-08 06:00:00'] });
    const nginx = r.journalctl.filter((argv) => argv.includes(NGINX_MATCH));
    expect(nginx.length).toBeGreaterThan(0);
    for (const argv of nginx) {
      expect(argv.filter((a) => /^[A-Z_]+=/.test(a)), 'only the container match, OR-ed with nothing').toEqual([NGINX_MATCH]);
      expect(argv).not.toContain('+');
      expect(argv).toContain('--since=2026-10-08 06:00:00');
      expect(argv.slice(argv.indexOf('-o'), argv.indexOf('-o') + 2)).toEqual(['-o', 'cat']);
    }
    expect(new Set(r.journalctl.map((a) => a.find((x) => x.startsWith('--until=')))).size).toBe(1);
  });

  it('fails rather than report a negative count when the two passes disagree', () => {
    // The nginx pass found a shape line that the pass over everything did not: the window
    // moved, or the journal changed under it. Neither count can be stood behind.
    const r = run({ patterns: PATTERNS, journal: `${APP_LINE}\n`, nginx: `${NGINX_LINE}\n` });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('');
  });

  it('counts every shape in a --file scan as failing: a file carries no container name', () => {
    const r = run({ patterns: PATTERNS, fileText: `${NGINX_LINE}\n` });
    expect(r.stdout).toBe('patterns=2 account_hits=0 shape_hits=1 shape_hits_nginx=0\n');
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
        expect(lines.at(-1)).toBe('patterns=2 account_hits=2 shape_hits=3 shape_hits_nginx=0');
      },
    });
    expect(r.status).toBe(1);
  });
});

describe('makrai-email-scan.sh --file', () => {
  it('scans a gzip file and does not read the journal', () => {
    const r = run({ patterns: PATTERNS, fileText: JOURNAL });
    expect(r.stdout).toBe('patterns=2 account_hits=2 shape_hits=3 shape_hits_nginx=0\n');
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
    expect(r.stdout).toBe('patterns=2 account_hits=2 shape_hits=3 shape_hits_nginx=0\n');
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
    expect(r.stdout, 'the counts are still printed').toBe('patterns=2 account_hits=0 shape_hits=0 shape_hits_nginx=0\n');
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
    expect(r.stdout).toBe('patterns=2 account_hits=0 shape_hits=1 shape_hits_nginx=0\n');
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

  it('sources the shared library, reads .env only through load_env, and pings through it', () => {
    const text = code.join('\n');
    expect(text).toMatch(/makrai-lib\.sh/);
    expect(code).toContain('load_env');
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
