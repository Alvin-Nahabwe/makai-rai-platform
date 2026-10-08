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
if [ -n "\${STUB_JOURNAL_FILE:-}" ]; then cat "$STUB_JOURNAL_FILE"; fi`,
    );
    stub(
      'curl',
      `{ echo CALL; printf '%s\\n' "$@"; } >> "$REC/curl-argv"
for a in "$@"; do [ "$a" = "--config" ] && cat >> "$REC/curl-stdin"; done
case "$*" in *'%{http_code}'*) printf '\\n200' ;; esac`,
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
    if (o.dockerFails) env.STUB_DOCKER_FAIL = '1';
    if (o.journalFails) env.STUB_JOURNAL_FAIL = '1';
    const args = (o.args ?? []).map((a) => a.replace('{DIR}', dir));
    if (o.fileText !== undefined) {
      writeFileSync(path.join(dir, 'log.gz'), gzipSync(o.fileText));
      args.push('--file', path.join(dir, 'log.gz'));
    }
    o.prepare?.(dir);

    const r = spawnSync('bash', [path.join(host, SCRIPT), ...args], { env, encoding: 'utf8', timeout: 60_000 });
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

  it('reads the journal for the three container tags, sshd and sudo, over one fixed window', () => {
    const r = run({ ...scanned, args: ['--since', '2026-10-08 06:00:00'] });
    expect(r.journalctl.length).toBeGreaterThan(0);
    for (const argv of r.journalctl) {
      const joined = argv.join('\n');
      for (const tag of ['nextjs', 'postgres', 'nginx']) expect(joined).toContain(`CONTAINER_TAG=makrai/docker-${tag}-1`);
      expect(joined).toContain('_COMM=sshd');
      expect(joined).toContain('_COMM=sudo');
      // Two groups of matches are OR'd with "+"; without it journalctl would AND them.
      expect(argv).toContain('+');
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
    expect(r.stdout.trimEnd()).toMatch(/^patterns=\d+ account_hits=\d+ shape_hits=\d+$/);
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stdout.trimEnd().split('\n')).toHaveLength(1);
    expectNoAddress(r);
  });

  it('counts a pattern hit in any case, and counts shape hits for addresses that are not accounts', () => {
    const r = run(scanned);
    expect(r.stdout).toBe('patterns=2 account_hits=2 shape_hits=3\n');
  });

  it('exits 1 when anything was found and 0 when nothing was', () => {
    expect(run(scanned).status).toBe(1);
    const clean = run({ ...scanned, journal: '{"event":"AUTH_LOGIN_FAILURE","userId":"u1"}\nGET /health 200\n' });
    expect(clean.stdout).toBe('patterns=2 account_hits=0 shape_hits=0\n');
    expect(clean.status).toBe(0);
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

describe('makrai-email-scan.sh --file', () => {
  it('scans a gzip file and does not read the journal', () => {
    const r = run({ patterns: PATTERNS, fileText: JOURNAL });
    expect(r.stdout).toBe('patterns=2 account_hits=2 shape_hits=3\n');
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
    expect(r.stdout).toBe('patterns=2 account_hits=2 shape_hits=3\n');
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
    expect(r.stdout, 'the counts are still printed').toBe('patterns=2 account_hits=0 shape_hits=0\n');
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
    expect(r.stdout).toBe('patterns=2 account_hits=0 shape_hits=1\n');
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
    'a@b.co',
    'owner@example.org',
    'A.B+tag@Sub.Example.CO.UG',
    'first_last-1%x@xn--bcher-kva.example',
    'x@y.museum',
    `prefix ${OWNER} suffix`,
    '(a.b@c-d.org)',
  ];
  const clean = ['a@b', 'a@b.c', '@example.org', 'user@localhost', 'pkg@1.2.3', '197.157.0.1', 'no at sign.example.org', 'a @b.co', ''];

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
