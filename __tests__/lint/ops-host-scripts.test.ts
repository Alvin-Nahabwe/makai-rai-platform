import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The scripts that run on the host are tracked in `ops/host/`, and this file is
 * the contact point between them and the rules they must keep.
 *
 * Until the first verified restore, the only copy of the backup scripts was the
 * one on the server, plus a second one pasted into a runbook that had already
 * drifted from it by six comment lines. Nothing could say what the host was
 * actually running, and nothing checked the properties that matter about it:
 * that it stops on the first error, that no secret reaches a process table, that
 * a restore test cannot touch the live database or print a row of it.
 *
 * WHAT THESE TESTS CAN AND CANNOT SHOW. They read shell source and assert that
 * strings are present or absent. A script can contain every required string and
 * still do the wrong thing, so none of this is proof that a restore works.
 * That proof is the first live restore on the server (it prints
 * `RESTORE MATCH` and ends its log with `Restore test PASSED`). What these
 * tests do is stop the properties from being edited away afterwards, and they
 * were each made to fail by a deliberate mutation before being trusted.
 *
 * Comment lines are ignored throughout: both live scripts carry a comment that
 * quotes the very `-H "Authorization` form this file forbids, explaining why
 * they do not use it.
 */

const HOST_DIR = 'ops/host';
const RESTORE = 'makrai-restore-test.sh';
const OFFSITE = 'makrai-offsite-copy.sh';
const LIB = 'makrai-lib.sh';
const HOOK = 'makrai-break-glass-session';
/**
 * The exact name of a nightly backup, as a grep -E pattern: the restore test's
 * filter, character for character. The copy's guard and its choice of the newest
 * nightly use the same text (backup-glob-agreement.test.ts keeps the three equal).
 */
const NIGHTLY = '^makrai-[0-9]{8}-[0-9]{6}\\.sql\\.gz\\.gpg$';

const EXPECTED_SCRIPTS = [
  'makrai-backup-check.sh',
  'makrai-backup.sh',
  LIB,
  OFFSITE,
  RESTORE,
  HOOK,
];

/**
 * Scripts that must NOT fail fast, each with the reason. A script listed here is still
 * held to every other rule in this file, and to never turning errexit on.
 */
const FAIL_FAST_EXEMPT: Record<string, string> = {
  [HOOK]:
    'the console break-glass PAM session hook (ADR-0010, P3): a root login at the console must ' +
    'never wait on, or be refused by, a failing database, mailer or logger, so it runs every ' +
    'step, logs what failed and always exits 0',
};

function hostFiles(): string[] {
  return readdirSync(HOST_DIR).sort();
}

/** Every shell script: a `.sh` file, or a file that starts with a shebang (the PAM hook has no extension). */
function hostScripts(): string[] {
  return hostFiles().filter(
    (f) => f.endsWith('.sh') || readFileSync(path.join(HOST_DIR, f), 'utf8').startsWith('#!'),
  );
}

function readHost(file: string): string {
  const p = path.join(HOST_DIR, file);
  expect(existsSync(p), `${p} does not exist`).toBe(true);
  return readFileSync(p, 'utf8');
}

/**
 * Executable shell as whole logical lines: backslash continuations joined,
 * whole-line comments and blank lines dropped. A trailing `# ...` on a code line
 * is kept, which can only make a check stricter.
 */
function code(file: string): string[] {
  const out: string[] = [];
  let pending = '';
  for (const raw of readHost(file).split('\n')) {
    const t = raw.trim();
    if (pending === '' && (t === '' || t.startsWith('#'))) continue;
    if (t.endsWith('\\')) {
      pending += t.slice(0, -1).trim() + ' ';
      continue;
    }
    out.push((pending + t).trim());
    pending = '';
  }
  if (pending) out.push(pending.trim());
  return out;
}

/** A script's executable lines as one string, for checks that look for a fragment. */
const text = (file: string): string => code(file).join('\n');

describe('the tracked host scripts', () => {
  it('finds every script it expects, so an empty directory cannot pass vacuously', () => {
    const missing = EXPECTED_SCRIPTS.filter((f) => !hostScripts().includes(f));
    expect(missing, `missing from ${HOST_DIR}/: ${missing.join(', ')}`).toEqual([]);
  });

  it('every ops/host script parses', () => {
    const broken: string[] = [];
    for (const f of hostScripts()) {
      try {
        execFileSync('bash', ['-n', path.join(HOST_DIR, f)], { stdio: 'pipe' });
      } catch (e) {
        broken.push(`${f}: ${String((e as { stderr?: Buffer }).stderr ?? e).trim()}`);
      }
    }
    expect(broken, broken.join('\n')).toEqual([]);
  });

  it('every ops/host script fails fast', () => {
    // The first executable line, after the shebang and any header comment.
    const wrong = hostScripts().filter((f) => !(f in FAIL_FAST_EXEMPT) && code(f)[0] !== 'set -Eeuo pipefail');
    expect(
      wrong,
      `these scripts do not start with \`set -Eeuo pipefail\`, so a failing command in them ` +
        `is ignored and the run goes on to report success: ${wrong.join(', ')}`,
    ).toEqual([]);
  });

  it('the fail-fast exemptions are real scripts that never turn errexit on', () => {
    for (const [f, reason] of Object.entries(FAIL_FAST_EXEMPT)) {
      expect(hostScripts(), `${f} is exempt but is not a script in ${HOST_DIR}`).toContain(f);
      expect(reason.length).toBeGreaterThan(0);
      // `set -e`, `set -Eeuo`, `set -o errexit`, `#!/bin/bash -e`: any of them would let a
      // failing step end the script before its exit 0 (and, for the hook, fail the login).
      const errexit = [readHost(f).split('\n')[0], ...code(f)].filter(
        (l) => /(^|[;&|(]\s*)set\s+(-[A-Za-z]*e|-o\s+errexit)\b/.test(l) || /^#!.*\s-[A-Za-z]*e\b/.test(l),
      );
      expect(errexit, `${f} turns errexit on: ${errexit.join(' | ')}`).toEqual([]);
      expect(code(f).at(-1), `${f} must end with exit 0`).toBe('exit 0');
    }
  });

  it('no secret reaches argv', () => {
    const bad: string[] = [];
    for (const f of hostScripts()) {
      for (const line of code(f)) {
        // A bearer token in a header is in the process table for the life of curl.
        if (/-H\s*["']Authorization/i.test(line)) bad.push(`${f}: ${line.slice(0, 90)}`);
        // `--passphrase-fd` is the safe form; `--passphrase <value>` is not.
        if (/--passphrase(?![-\w])/.test(line)) bad.push(`${f}: ${line.slice(0, 90)}`);
      }
    }
    expect(bad, `a secret would be visible in \`ps\`:\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('no URL, address or key is given to curl as an argument in the new scripts', () => {
    // A ping URL is a credential (anyone holding it can send a success ping and
    // silence a real alarm), and the alert's recipient is personal data. In argv
    // either is readable by every local account for the life of the call. The new
    // scripts hand curl its URL, headers and body as a config on stdin
    // (`--config -`); the live backup scripts are tracked unchanged and are not
    // held to this.
    const bad: string[] = [];
    let seen = 0;
    for (const f of [LIB, OFFSITE, RESTORE, HOOK]) {
      for (const line of code(f).filter((l) => /\bcurl\b/.test(l))) {
        seen += 1;
        if (!line.includes('--config -')) bad.push(`${f}: no \`--config -\`: ${line.slice(0, 80)}`);
        if (/\s(-d|--data[\w-]*|--json|--url)\s/.test(line)) bad.push(`${f}: body or URL as an argument: ${line.slice(0, 80)}`);
      }
    }
    expect(seen, 'found no curl calls, so this would pass vacuously').toBeGreaterThanOrEqual(2);
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('sends the API key to curl on stdin, in the one place a key is used', () => {
    const lib = text(LIB);
    expect(lib, 'the alert function must pass its key with `curl ... --config -`').toMatch(
      /curl[^\n]*--config -/,
    );
  });

  it('no personal identifier', () => {
    // Built from parts so this file does not itself contain the string it forbids.
    const owner = ['al', 'vin'].join('');
    const hits: string[] = [];
    for (const f of hostFiles()) {
      readHost(f).split('\n').forEach((line, i) => {
        const where = `${HOST_DIR}/${f}:${i + 1}`;
        if (line.toLowerCase().includes(owner)) hits.push(`${where}  the owner's name`);
        // /home/<name>/ and `-u <name>`: scripts use $HOME, documents use <operator>.
        if (/\/home\/(?![<$])[A-Za-z_]/.test(line)) hits.push(`${where}  a literal home path`);
        if (/(^|\s)-u\s+(?![<$+])[a-z_][\w-]*/.test(line)) hits.push(`${where}  a literal \`-u <user>\``);
        // A literal user@host, such as a Storage Box sub-account, lives only in the server .env.
        if (/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(line)) hits.push(`${where}  a literal address`);
      });
    }
    expect(hits, `committed host files carry personal identifiers:\n  ${hits.join('\n  ')}`).toEqual([]);
  });
});

describe('the shared library', () => {
  it('defines load_env, ping_ok, ping_fail and alert', () => {
    const lib = text(LIB);
    for (const fn of ['load_env', 'ping_ok', 'ping_fail', 'alert']) {
      expect(lib, `${LIB} does not define ${fn}()`).toMatch(new RegExp(`(^|\\n)${fn}\\(\\)`));
    }
    expect(lib).toContain('. /srv/makrai/app/.env');
    expect(lib).toContain('curl -fsS -m 10 --retry 3 -o /dev/null');
  });

  it('is the only way the new scripts read the server .env', () => {
    for (const f of [OFFSITE, RESTORE]) {
      const lines = code(f);
      const joined = lines.join('\n');
      expect(joined, `${f} must source ${LIB}`).toMatch(/\.\s+"?\$[A-Za-z_{}]+\/makrai-lib\.sh"?/);
      expect(lines.some((l) => l === 'load_env'), `${f} must call load_env`).toBe(true);
      const direct = lines.filter((l) => /\.env\b/.test(l));
      expect(direct, `${f} reads .env directly instead of through load_env: ${direct.join(' | ')}`).toEqual([]);
    }
  });
});

describe('the off-site copy', () => {
  it('mirrors backup files only, over the pinned ssh, and pings its own check', () => {
    const joined = text(OFFSITE);
    expect(joined).toContain("--include='makrai-*.sql.gz.gpg'");
    expect(joined).toContain("--exclude='*'");
    expect(joined).toContain('--delete');
    expect(joined).toContain('SRC=/srv/makrai/backups/');
    expect(joined).toContain('"$OFFSITE_TARGET"');
    expect(joined).toContain('-e "$OFFSITE_SSH"');
    expect(joined, 'a success must reach the dead-man check').toMatch(/\bping_ok HC_OFFSITE_PING_URL\b/);
    expect(joined, 'a failure must reach it as /fail').toMatch(/\bping_fail HC_OFFSITE_PING_URL\b/);
    expect(joined, 'a failure must also alert').toMatch(/\balert\b/);
    expect(joined, 'the EXIT trap is what runs the failure path').toContain('trap on_exit EXIT');
  });

  it.each([[OFFSITE], [RESTORE]])('%s: its exit handler keeps going when a log write fails', (file) => {
    // Under errexit, the first `log` that fails (a full disk) would end the
    // handler before it pinged /fail or sent the alert.
    const lines = code(file);
    const at = lines.indexOf('trap - EXIT');
    expect(at, 'no `trap - EXIT` in the handler').toBeGreaterThan(-1);
    expect(lines.slice(at, at + 4), 'errexit must be off right after the trap is cleared').toContain('set +e');
  });

  it('reaches the Storage Box on port 23, with its own key, without prompting', () => {
    // The restore test uses the same string, so the two cannot disagree.
    const lib = text(LIB);
    expect(lib).toContain('ssh -p 23 -i $HOME/.ssh/makrai_offsite -o BatchMode=yes');
    expect(lib).toContain('-o StrictHostKeyChecking=yes');
    expect(text(RESTORE)).toContain('-e "$OFFSITE_SSH"');
  });

  it('checks, on the line right before rsync, that a settled nightly backup is listed', () => {
    // `rsync --delete` makes the box match the source. From a source with nothing
    // to send it deletes every remote backup, and the run can still report success.
    // "Nothing to send" is wider than an empty directory: a directory holding only
    // a hand-named file sends nothing the restore test can use, and one holding only
    // tonight's nightly, still inside the 2-minute window, sends nothing at all,
    // because rsync is told to leave that file out. So the guard counts the exact
    // nightly names that are not on the fresh list. The copy may wait 30 minutes and
    // then sleep 125 s, so the guard reads the list taken after the wait, and
    // nothing may sit between it and rsync.
    const lines = code(OFFSITE);
    const sync = lines.findIndex((l) => /rsync -a --delete/.test(l));
    expect(sync, 'no rsync line').toBeGreaterThan(0);
    const guard = lines[sync - 1];
    expect(guard, 'the line before rsync must be the guard').toMatch(
      /^\[ "\$\(printf '%s\\n' "\$\{all\[@\]\}" \| grep -E '[^']+' \| grep -cvxF -f <\(printf '%s\\n' "\$\{fresh\[@\]\}"\) \|\| true\)" -gt 0 \] \|\| \{ NOTE="[^"]+"; log "ERROR: .*exit 1; \}$/,
    );
    expect(guard, 'the guard must count exact nightly names, the restore test\'s filter').toContain(`grep -E '${NIGHTLY}'`);
    expect(
      lines.findIndex((l) => COPY_LINES.all[0].test(l)),
      'the list the guard reads must be taken before it',
    ).toBeLessThan(sync - 1);
    expect(
      lines.findIndex((l) => COPY_LINES.fresh[0].test(l)),
      'the fresh list the guard subtracts must be taken before it',
    ).toBeLessThan(sync - 1);
    expect(lines.filter((l) => /-print -quit/.test(l)), 'the early, stale guard must be gone').toEqual([]);
  });

  it('does not run rsync when nothing is listed, and fails with the reason', () => {
    const r = rsyncRun('user@host:', copySteps(['all', 'fresh', 'excludes', 'guard', 'rsync']), []);
    expect(r.status, 'must exit non-zero so on_exit sends /fail and the alert').toBe(1);
    expect(r.calls, 'rsync must not have run').toEqual([]);
    expect(r.note).toBe('no backup to mirror');
    expect(r.logs.some((l) => l.startsWith('ERROR: no settled nightly backup in'))).toBe(true);
  });

  it('counts only backup files when it decides the source is empty', () => {
    // The backup's plaintext temporary is never mirrored and must not make an
    // otherwise empty directory look populated.
    const r = rsyncRun('user@host:', copySteps(['all', 'fresh', 'excludes', 'guard', 'rsync']), [
      { name: '.makrai-20261009-000001.sql.gz.tmp', ageMin: 60 },
    ]);
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
  });

  // The guard's steps, then rsync: what a run does when the directory holds this.
  const guarded = (backups: { name: string; ageMin: number }[]) =>
    rsyncRun('user@host:', copySteps(['all', 'fresh', 'excludes', 'guard', 'rsync']), backups);
  const NIGHT_OLD = 'makrai-20261008-000001.sql.gz.gpg';
  const NIGHT_NEW = 'makrai-20261009-000001.sql.gz.gpg';
  const MANUAL = 'makrai-manual.sql.gz.gpg';

  it('does not run rsync when the only backup is hand-named', () => {
    // The listing matches makrai-*.sql.gz.gpg, so a hand-named file is listed. It is
    // not a nightly, and rsync would send it and delete every remote nightly.
    const r = guarded([{ name: MANUAL, ageMin: 600 }]);
    expect(r.status, 'must exit non-zero so on_exit sends /fail and the alert').toBe(1);
    expect(r.calls, 'rsync must not have run').toEqual([]);
    expect(r.note).toBe('no backup to mirror');
    expect(r.logs.some((l) => l.startsWith('ERROR: no settled nightly backup in'))).toBe(true);
  });

  it('does not run rsync when the only nightly was written in the last 2 minutes', () => {
    // rsync is told to leave a fresh file out, so it would send nothing and delete
    // the remote nightlies, and only afterwards would the newest-backup check fail.
    const r = guarded([{ name: NIGHT_NEW, ageMin: 1 }]);
    expect(r.status).toBe(1);
    expect(r.calls, 'rsync must not have run').toEqual([]);
    expect(r.note).toBe('no backup to mirror');
  });

  it('does not run rsync when the only nightly is fresh and a hand-named file is old', () => {
    // Each half alone is an exact name or a settled file; neither is both.
    const r = guarded([
      { name: NIGHT_NEW, ageMin: 1 },
      { name: MANUAL, ageMin: 600 },
    ]);
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
  });

  it.each([
    ['one settled nightly', [{ name: NIGHT_OLD, ageMin: 600 }]],
    ['a settled nightly and a fresh one', [{ name: NIGHT_OLD, ageMin: 600 }, { name: NIGHT_NEW, ageMin: 1 }]],
    ['a settled nightly and a hand-named file', [{ name: NIGHT_OLD, ageMin: 600 }, { name: MANUAL, ageMin: 600 }]],
  ])('runs rsync when the directory holds %s', (_label, backups) => {
    const r = guarded(backups);
    expect(r.status).toBe(0);
    expect(r.calls.length, 'rsync must have run once').toBe(1);
  });
});

/**
 * The off-site target comes from the server .env in two shapes, and both occur:
 *
 *   user@host:        an empty path, which means the sub-account's home. The
 *                     Storage Box maps that to its base directory.
 *   user@host:dir/    a named directory.
 *
 * A script that builds a file path from the target must not turn the first into
 * `user@host:/`, which names the root of the box rather than the home. That is
 * what `"${OFFSITE_TARGET%/}/"` did. Reading the script text cannot catch it, so
 * these tests run the scripts' own rsync lines, with a stand-in `rsync` that
 * records its arguments, once per shape.
 */
const FAKE_RSYNC = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RECORD"
case "$*" in
  *--list-only*)
    echo "drwx------          4,096 2026/10/08 00:00:45 ."
    echo "-rw-------          1,234 2026/10/08 00:00:45 makrai-20261008-000001.sql.gz.gpg" ;;
esac
exit "\${FAKE_RSYNC_RC:-0}"
`;

/**
 * Runs the given script lines, in order, with `rsync` replaced, and with a
 * stand-in `log` and a trap that records `NOTE`, as the script's own `log` and
 * `on_exit` would. Returns each rsync call's arguments, the exit status, what was
 * logged, the failure note, and the source directory used. `backups` are files
 * created in that source directory, `ageMin` minutes old.
 */
function rsyncRun(
  target: string,
  lines: string[],
  backups: { name: string; ageMin: number }[] = [],
  extraEnv: Record<string, string> = {},
): { calls: string[][]; src: string; status: number; logs: string[]; note: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ops-host-'));
  try {
    mkdirSync(path.join(dir, 'bin'));
    mkdirSync(path.join(dir, 'work'));
    mkdirSync(path.join(dir, 'src'));
    for (const b of backups) {
      const f = path.join(dir, 'src', b.name);
      writeFileSync(f, 'x');
      const t = new Date(Date.now() - b.ageMin * 60_000);
      utimesSync(f, t, t);
    }
    const fake = path.join(dir, 'bin', 'rsync');
    writeFileSync(fake, FAKE_RSYNC);
    chmodSync(fake, 0o755);
    const record = path.join(dir, 'record');
    const driver = path.join(dir, 'driver.sh');
    writeFileSync(
      driver,
      [
        'set -Eeuo pipefail',
        `. "${path.resolve(HOST_DIR, LIB)}"`,
        'OFFSITE_TARGET=$1',
        `WORK="${dir}/work"`,
        `SRC="${dir}/src/"`,
        'NOTE=',
        'log() { printf "%s\\n" "$*" >> "$RECORD.log"; }',
        `trap 'printf "%s" "$NOTE" > "$RECORD.note"' EXIT`,
        ...lines.map((_, i) => `eval "$LINE_${i}"`),
      ].join('\n'),
    );
    // A minimal environment, on purpose. NODE_ENV is only here because this
    // project's ProcessEnv type requires it.
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: dir,
      RECORD: record,
      ...extraEnv,
    };
    lines.forEach((l, i) => (env[`LINE_${i}`] = l));
    let status = 0;
    try {
      execFileSync('bash', [driver, target], { env, stdio: 'pipe' });
    } catch (e) {
      status = (e as { status?: number }).status ?? -1;
    }
    const read = (f: string): string => (existsSync(f) ? readFileSync(f, 'utf8') : '');
    return {
      calls: read(record).trim().split('\n').filter(Boolean).map((l) => l.split(' ')),
      src: `${dir}/src/`,
      status,
      logs: read(`${record}.log`).split('\n').filter(Boolean),
      note: read(`${record}.note`),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `script` after sourcing the library, with a stand-in `curl` that records argv and stdin. */
function runLib(script: string, extraEnv: Record<string, string>): { argv: string; stdin: string; status: number; stdout: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ops-host-'));
  try {
    mkdirSync(path.join(dir, 'bin'));
    const fake = path.join(dir, 'bin', 'curl');
    writeFileSync(
      fake,
      `#!/usr/bin/env bash
{ echo CALL; printf '%s\\n' "$@"; } >> "$RECORD_ARGV"
for a in "$@"; do [ "$a" = "--config" ] && cat >> "$RECORD_STDIN"; done
case "$*" in *'%{http_code}'*) printf '\\n200' ;; esac
`,
    );
    chmodSync(fake, 0o755);
    const driver = path.join(dir, 'driver.sh');
    writeFileSync(driver, `. "${path.resolve(HOST_DIR, LIB)}"\nset +e\n${script}\necho "status=$?"\n`);
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: dir,
      RECORD_ARGV: path.join(dir, 'argv'),
      RECORD_STDIN: path.join(dir, 'stdin'),
      ...extraEnv,
    };
    const out = execFileSync('bash', [driver], { env, stdio: 'pipe' }).toString();
    const read = (f: string): string => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : '');
    return { argv: read('argv'), stdin: read('stdin'), status: Number(/status=(\d+)/.exec(out)?.[1]), stdout: out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the shared library at run time', () => {
  // Sentinels: unmistakable strings, so a leak into argv cannot be a coincidence.
  const URL_SENTINEL = 'https://hc.invalid/ping-sentinel-7f3a';
  const KEY_SENTINEL = 'k'.repeat(24); // built, not a literal: keeps secret scanners quiet
  const TO_SENTINEL = 'owner-sentinel@example.invalid';
  const FROM_SENTINEL = 'sender-sentinel@example.invalid';
  const mail = {
    RESEND_API_KEY: KEY_SENTINEL,
    ADMIN_EMAIL: TO_SENTINEL,
    EMAIL_FROM_ADDRESS: FROM_SENTINEL,
  };

  it.each([
    ['ping_ok', URL_SENTINEL],
    ['ping_fail', `${URL_SENTINEL}/fail`],
  ])('%s sends the URL on stdin and not in argv', (fn, expected) => {
    const r = runLib(`${fn} HC_X_PING_URL`, { HC_X_PING_URL: URL_SENTINEL });
    expect(r.status).toBe(0);
    expect(r.argv, 'the URL reached curl as an argument').not.toContain('ping-sentinel');
    expect(r.argv).toContain('--config');
    expect(r.stdin).toBe(`url = "${expected}"\n`);
  });

  it('a ping with the variable unset, or a URL that cannot go in a config, calls nothing and returns 1', () => {
    expect(runLib('ping_ok HC_UNSET_PING_URL', {})).toMatchObject({ status: 1, argv: '' });
    // A quote or a newline in the value would end the string and let it add
    // config lines of its own (`output = ...`).
    for (const bad of ['https://hc.invalid/a"b', 'https://hc.invalid/a\nb', 'https://hc.invalid/a b', 'https://hc.invalid/a\\b']) {
      expect(runLib('ping_ok HC_X_PING_URL', { HC_X_PING_URL: bad }), JSON.stringify(bad)).toMatchObject({ status: 1, argv: '' });
    }
  });

  it('alert puts the key, the addresses and the subject on stdin and none of them in argv', () => {
    const r = runLib('alert "restore test FAILED: policies"', mail);
    expect(r.status).toBe(0);
    for (const secret of [KEY_SENTINEL, TO_SENTINEL, FROM_SENTINEL, 'restore test FAILED']) {
      expect(r.argv, `${secret} reached curl as an argument`).not.toContain(secret);
    }
    expect(r.argv, 'the only header in argv is the content type').toContain('Content-Type: application/json');
    expect(r.stdin).toContain(`header = "Authorization: Bearer ${KEY_SENTINEL}"`);

    // The body travels as `data = "<json>"`, with the quoting a curl config needs.
    const line = r.stdin.split('\n').find((l) => l.startsWith('data = "'));
    expect(line, 'no data line on stdin').toBeDefined();
    const unquoted = (line as string).slice('data = "'.length, -1).replace(/\\(["\\])/g, '$1');
    const body = JSON.parse(unquoted) as { from: string; to: string[]; subject: string; text: string };
    expect(body.from).toBe(FROM_SENTINEL);
    expect(body.to).toEqual([TO_SENTINEL]);
    expect(body.subject).toMatch(/^\[makrai\] restore test FAILED: policies on \S+/);
    expect(body.text, 'the body is fixed text with no data in it').toBe(
      'A scheduled job on this host reported a failure. Read its log on the host. This message carries no data.',
    );
  });

  it('alert without its mail settings sends nothing and still returns 0', () => {
    expect(runLib('alert "x"', {})).toMatchObject({ status: 0, argv: '' });
  });
});

/** The off-site copy's own lines, by role, in the order the script runs them. */
const COPY_LINES: Record<string, [RegExp, string]> = {
  all: [/^mapfile -t all /, 'list of local backups'],
  fresh: [/^mapfile -t fresh /, 'list of files written in the last 2 minutes'],
  excludes: [/^excludes=\(\)/, 'exclusion arguments'],
  guard: [/^\[ "\$\(printf '%s\\n' "\$\{all\[@\]\}" \| grep -E '\^makrai-/, 'check that a settled nightly backup is listed'],
  rsync: [/rsync -a --delete/, 'rsync'],
  skipped: [/^for f in "\$\{fresh\[@\]\}"; do log "Skipped /, 'report of skipped files'],
  newestName: [/^newest=\$\(/, 'choice of the newest nightly backup'],
  newest: [/newest backup not copied: still being written/, 'check that the newest backup was copied'],
  complete: [/^log "Off-site copy complete/, 'completion log'],
  ping: [/^if ping_ok HC_OFFSITE_PING_URL; then$/, 'success ping'],
};

/** The roles in the order the script runs them. Tests that run the lines use this order. */
const COPY_ORDER = ['all', 'fresh', 'excludes', 'guard', 'rsync', 'skipped', 'newestName', 'newest', 'complete', 'ping'];
function copySteps(roles: string[]): string[] {
  return roles.map((role) => {
    const [re, what] = COPY_LINES[role];
    const hit = code(OFFSITE).find((l) => re.test(l));
    expect(hit, `no ${what} line found in ${OFFSITE}`).toBeDefined();
    return hit as string;
  });
}

describe('the off-site target', () => {
  const NAME = 'makrai-20261008-000001.sql.gz.gpg';
  const forms = [
    // [target as in .env, what the restore lists, what it fetches, what the copy mirrors to]
    ['user@host:', 'user@host:', `user@host:${NAME}`, 'user@host:'],
    ['user@host:dir/', 'user@host:dir/', `user@host:dir/${NAME}`, 'user@host:dir/'],
    ['user@host:dir', 'user@host:dir/', `user@host:dir/${NAME}`, 'user@host:dir'],
  ];

  it.each(forms)('the restore test lists and fetches from %s', (target, listed, fetched) => {
    const lines = code(RESTORE);
    const find = (re: RegExp, what: string): string => {
      const hit = lines.find((l) => re.test(l));
      expect(hit, `no ${what} line found in ${RESTORE}`).toBeDefined();
      return hit as string;
    };
    const { calls } = rsyncRun(target, [
      find(/^TARGET=/, 'target-building'),
      find(/rsync --list-only/, 'listing'),
      // NEWEST is set by the listing line; the fetch line uses it.
      find(/rsync -t /, 'fetch'),
    ]);
    expect(calls.length, 'expected one listing and one fetch').toBe(2);
    expect(calls[0].at(-1), 'what the restore test lists').toBe(listed);
    expect(calls[1].at(-2), 'what the restore test fetches').toBe(fetched);
  });

  it.each(forms)('the off-site copy mirrors to %s exactly as written', (target, _l, _f, mirrored) => {
    const { calls, src } = rsyncRun(target, copySteps(['fresh', 'excludes', 'rsync']));
    expect(calls.length).toBe(1);
    expect(calls[0].at(-1), 'the destination').toBe(mirrored);
    expect(calls[0].at(-2), 'the source').toBe(src);
  });
});

describe('the off-site copy and a backup that is still being written', () => {
  const OLD = 'makrai-20261008-000001.sql.gz.gpg';

  // The copy's own lines, run in order against a stand-in rsync: what it leaves out,
  // what it says it did, and whether it fails.
  const run = (backups: { name: string; ageMin: number }[]) =>
    rsyncRun('user@host:', copySteps(COPY_ORDER.filter((role) => role !== 'ping')), backups);
  const excluded = (calls: string[][]): string[] => calls[0].filter((a) => a.startsWith('--exclude=/'));
  // rsync applies the first rule that matches. An exclusion placed after the
  // include never applies: the fresh file is copied while the log still says
  // "Skipped". So position in the argument list matters, not only presence.
  const excludesFirst = (args: string[]): boolean => {
    const include = args.indexOf('--include=makrai-*.sql.gz.gpg');
    const last = args.reduce((acc, a, i) => (a.startsWith('--exclude=/') ? i : acc), -1);
    return include > -1 && last > -1 && last < include;
  };
  const NEWER = 'makrai-20261009-000001.sql.gz.gpg';

  it('copies every file and reports the count when nothing was written in the last 2 minutes', () => {
    const r = run([
      { name: OLD, ageMin: 60 },
      { name: NEWER, ageMin: 30 },
    ]);
    expect(r.status).toBe(0);
    expect(excluded(r.calls)).toEqual([]);
    expect(r.logs).toContain('Off-site copy complete: 2 backup file(s) mirrored.');
    expect(r.logs.filter((l) => l.startsWith('Skipped'))).toEqual([]);
  });

  it('skips, and names, a file written less than 2 minutes ago, and counts only what it mirrored', () => {
    // The backup script writes its .gpg in place, so at 00:30 a long run could
    // leave a half-written file that the copy would send. rsync is told to
    // exclude anything touched in the last two minutes, by name, at the top level.
    // Here the fresh one is not the newest, so the run is still a success.
    const r = run([
      { name: OLD, ageMin: 1 },
      { name: NEWER, ageMin: 60 },
    ]);
    expect(excluded(r.calls)).toEqual([`--exclude=/${OLD}`]);
    expect(excludesFirst(r.calls[0]), 'the exclusion must come before the include').toBe(true);
    expect(r.logs.some((l) => l.startsWith(`Skipped ${OLD}:`))).toBe(true);
    expect(r.logs).toContain('Off-site copy complete: 1 backup file(s) mirrored.');
    expect(r.status).toBe(0);
  });

  it('fails, with the reason, when the file it skipped is the newest backup', () => {
    // The newest backup is the one the 01:00 restore test needs. Skipping it, and
    // then pinging success, would hide a day of off-site lag.
    const r = run([
      { name: OLD, ageMin: 60 },
      { name: NEWER, ageMin: 1 },
    ]);
    expect(r.status, 'must exit non-zero so on_exit sends /fail and the alert').toBe(1);
    expect(r.note).toBe('newest backup not copied: still being written');
    expect(excluded(r.calls)).toEqual([`--exclude=/${NEWER}`]);
    expect(excludesFirst(r.calls[0]), 'the exclusion must come before the include').toBe(true);
    expect(r.logs.some((l) => l.startsWith(`Skipped ${NEWER}:`))).toBe(true);
    expect(r.logs.some((l) => l.startsWith('ERROR: newest backup not copied'))).toBe(true);
    expect(r.logs.some((l) => l.startsWith('Off-site copy complete')), 'must not claim completion').toBe(false);
  });

  it('judges "newest" by the nightly name, so a hand-named file cannot hide a fresh nightly', () => {
    // makrai-manual.sql.gz.gpg sorts after every dated name. Taken as the newest, it
    // would leave a fresh nightly as "not the newest": skipped, named, and then
    // reported as a success, which is the silent day of off-site lag again.
    const r = run([
      { name: OLD, ageMin: 60 },
      { name: NEWER, ageMin: 1 },
      { name: 'makrai-manual.sql.gz.gpg', ageMin: 600 },
    ]);
    expect(r.status, 'the fresh nightly is the newest backup: the run must fail').toBe(1);
    expect(r.note).toBe('newest backup not copied: still being written');
    expect(excluded(r.calls)).toEqual([`--exclude=/${NEWER}`]);
  });

  it('a fresh hand-named file is skipped and reported, and is not a failure', () => {
    const r = run([
      { name: OLD, ageMin: 60 },
      { name: NEWER, ageMin: 30 },
      { name: 'makrai-manual.sql.gz.gpg', ageMin: 1 },
    ]);
    expect(r.status).toBe(0);
    expect(excluded(r.calls)).toEqual(['--exclude=/makrai-manual.sql.gz.gpg']);
    expect(r.logs.some((l) => l.startsWith('Skipped makrai-manual.sql.gz.gpg:'))).toBe(true);
    expect(r.logs).toContain('Off-site copy complete: 2 backup file(s) mirrored.');
  });

  it('runs its steps in order: lists, excludes, guard, rsync, skip report, newest check, completion, ping', () => {
    // A step in the wrong place can pass every presence check: a newest check after
    // the completion log still fails the run but claims completion first, and one
    // after the success ping sends /fail after a success.
    const lines = code(OFFSITE);
    const at = COPY_ORDER.map((role) => {
      const [re, what] = COPY_LINES[role];
      const i = lines.findIndex((l) => re.test(l));
      expect(i, `no ${what} line`).toBeGreaterThan(-1);
      return { role, i };
    });
    const wrong = at.filter((x, k) => k > 0 && x.i <= at[k - 1].i).map((x) => `${x.role} is not after the step before it`);
    expect(wrong, `the steps are out of order: ${at.map((x) => `${x.role}@${x.i}`).join(' ')}`).toEqual([]);
  });

  it('puts the reason in the subject of the alert it sends', () => {
    // The mail is what the owner reads first. "off-site copy FAILED" alone does not
    // say whether the copy broke or the newest backup was merely too fresh.
    const joined = text(OFFSITE);
    expect(joined).toContain('alert "off-site copy FAILED${NOTE:+: ${NOTE}}"');
    expect(code(OFFSITE), 'NOTE starts empty, before the handler is installed').toContain('NOTE=');
  });

  it('after a wait, sleeps until the backup it waited for is past the 2-minute window', () => {
    // pgrep sees the backup end within a minute of its last write, so without this
    // the file is always younger than 2 minutes and is skipped: a day of off-site
    // lag, and (before the newest-backup check) no signal at all.
    const lines = code(OFFSITE);
    const settle = lines.findIndex((l) => /^\[ "\$waited" -eq 0 \] \|\| sleep \d+$/.test(l));
    expect(settle, 'no settle sleep that runs only after a wait').toBeGreaterThan(-1);
    const seconds = Number(/sleep (\d+)$/.exec(lines[settle])?.[1]);
    const windowMin = Number(/-mmin -(\d+)/.exec(lines.join('\n'))?.[1]);
    expect(windowMin, 'the freshness window is 2 minutes').toBe(2);
    expect(seconds, 'must outlast the freshness window').toBeGreaterThan(windowMin * 60);
    expect(lines.indexOf('done'), 'the settle sleep comes after the wait loop').toBeLessThan(settle);
    const firstList = lines.findIndex((l) => COPY_LINES.all[0].test(l));
    expect(settle, 'and before the files are listed').toBeLessThan(firstList);
  });

  it('waits for a running makrai-backup.sh, for at most 30 minutes, then fails', () => {
    const joined = text(OFFSITE);
    expect(joined).toContain("pgrep -f 'makrai-backup\\.sh'");
    expect(joined).toMatch(/^readonly BACKUP_WAIT_MIN=30$/m);
    expect(joined).toContain('sleep 60');
    expect(joined).toContain('-mmin -2');
    // Too long a wait is a failure like any other: exit 1 runs on_exit, which
    // sends /fail and the alert.
    expect(joined).toMatch(/\[ "\$waited" -ge "\$BACKUP_WAIT_MIN" \]/);
    // The wait comes before the mirror.
    expect(joined.indexOf('pgrep'), 'pgrep must come before rsync').toBeLessThan(joined.indexOf('rsync -a'));
  });
});

describe('the off-site copy and the deletion limit', () => {
  // The guard cannot see a source that has shrunk but is not empty (a mount that
  // dropped, with tonight's file written into the bare mount point). `--max-delete`
  // is the structural cap: one rotation removes one or two files, so a run that
  // would remove more is stopped by rsync (exit 25) and fails loudly.
  const nightlies = [
    { name: 'makrai-20261008-000001.sql.gz.gpg', ageMin: 600 },
    { name: 'makrai-20261009-000001.sql.gz.gpg', ageMin: 300 },
  ];
  const run = (env: Record<string, string> = {}) =>
    rsyncRun('user@host:', copySteps(COPY_ORDER.filter((role) => role !== 'ping')), nightlies, env);

  it('tells rsync to delete at most 3 files in one run', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0], 'the mirror must carry the cap').toContain('--max-delete=3');
    expect(r.calls[0]).toContain('--delete');
    expect(r.logs).toContain('Off-site copy complete: 2 backup file(s) mirrored.');
  });

  it('fails when rsync stops the deletions (exit 25), says why, and does not claim completion', () => {
    const r = run({ FAKE_RSYNC_RC: '25' });
    expect(r.status, 'exit 25 must not be swallowed: on_exit sends /fail and the alert only on non-zero').toBe(25);
    expect(r.note, 'the alert subject is built from NOTE').toBe('off-site deletions exceeded limit');
    expect(r.logs.some((l) => l.startsWith('ERROR: off-site deletions exceeded limit'))).toBe(true);
    expect(r.logs.some((l) => l.startsWith('Off-site copy complete')), 'must not claim completion').toBe(false);
  });

  it('fails on any other rsync error too, with no limit reason', () => {
    const r = run({ FAKE_RSYNC_RC: '23' });
    expect(r.status).toBe(23);
    expect(r.note, 'only exit 25 means the limit stopped the deletions').toBe('');
    expect(r.logs.some((l) => l.startsWith('Off-site copy complete'))).toBe(false);
  });
});

/** The text of a runbook section: from its heading to the next heading or rule. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  expect(start, `no section "${heading}" in the runbook`).toBeGreaterThan(-1);
  const end = lines.findIndex((l, i) => i > start && (/^#{1,3} /.test(l) || l === '---'));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
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

describe('the runbook and the README', () => {
  const RUNBOOK = readFileSync('docs/runbooks/backup-restore.md', 'utf8');
  const README = readFileSync(path.join(HOST_DIR, 'README.md'), 'utf8');

  it('the install steps pre-create each new log, owned by the operator, without truncating one', () => {
    // The scripts create their logs as the operator, before any trap exists. If
    // the operator cannot create a file in /srv/makrai, the first run fails with
    // no ping, no alert and no output. `install ... /dev/null` would truncate a
    // log that exists, so each is guarded.
    const logs = [OFFSITE, RESTORE].map((f) => {
      const m = /^readonly LOG=(\S+)$/m.exec(text(f));
      expect(m, `no LOG constant in ${f}`).not.toBeNull();
      return (m as RegExpExecArray)[1];
    });
    expect(logs.length).toBe(2);
    for (const [name, doc] of [['the runbook', RUNBOOK], ['the README', README]] as const) {
      for (const log of logs) expect(doc, `${name} never mentions ${log}`).toContain(log);
      expect(doc, `${name} has no install command for the logs`).toContain(
        'install -m 600 -o <operator> -g <operator> /dev/null',
      );
      expect(doc, `${name} does not guard against truncating an existing log`).toMatch(/\[ -e "\$log" \] \|\|/);
    }
  });

  it.each([['### 4.2a'], ['### 4.5a']])('%s derives the roles from the migrations and names none', (heading) => {
    // The roles are whatever the migrations create. A list written into the
    // runbook would be wrong the day a migration adds one, and on a new cluster
    // that is the day it matters.
    const derive = /grep -hoE ('[^']+') \/srv\/makrai\/app\/prisma\/migrations/.exec(text(RESTORE));
    expect(derive, 'cannot find the restore test\'s role derivation').not.toBeNull();
    const code = fenced(section(RUNBOOK, heading)).join('\n');
    expect(code, `${heading} must derive roles with the same grep as the restore test`).toContain(
      `grep -hoE ${(derive as RegExpExecArray)[1]} prisma/migrations/*/migration.sql`,
    );
    expect(code, `${heading} names a role in a command`).not.toMatch(/makrai_(app|identity)\b/);
  });

  it('no runbook command displays the backup passphrase', () => {
    // Its only use in a command is the here-string that feeds gpg's file
    // descriptor 3. Anything else (grep, echo, cat of .env) prints it.
    const shown = fenced(RUNBOOK).filter((l) => /PASSPHRASE/.test(l) && !/3<<<"\$BACKUP_PASSPHRASE"/.test(l));
    expect(shown, `these commands can display the passphrase:\n  ${shown.join('\n  ')}`).toEqual([]);
    // The off-server copy is checked with a hidden prompt and the same descriptor.
    expect(fenced(RUNBOOK).join('\n')).toMatch(/read -rs [^\n]*\n[^]*3<<<"\$pp"/);
  });

  it('section 5 says what the copy skips and reports, what it does after a wait, and not to chain commands', () => {
    // Prose is hard-wrapped, so compare with whitespace collapsed.
    const doc = section(RUNBOOK, '## 5. Off-site copy').replace(/\s+/g, ' ');
    expect(doc).toContain('a further 125 seconds');
    expect(doc.toLowerCase()).toContain('immediately before `rsync`');
    expect(doc).toContain('names each in the log');
    // The guard counts settled nightlies, not files; the cap covers what it cannot see.
    expect(doc).toContain('only a hand-named file');
    expect(doc).toContain('`--max-delete=3`');
    expect(doc).toContain('off-site deletions exceeded limit');
    expect(doc, 'how a deliberate larger prune is run').toContain('A deliberate larger prune is run by hand');
    expect(doc).toContain('`--max-delete` raised for that one run');
    expect(doc).toContain('newest backup not copied: still being written');
    // pgrep -f matches any process whose command line names makrai-backup.sh,
    // and that includes the copy's own parent when both are chained in one line.
    expect(doc).toContain('never chained in one command line');
  });

  it('documents every field the restore test can print', () => {
    const script = text(RESTORE);
    const fields = new Set<string>();
    for (const m of script.matchAll(/\bfail (\w+)/g)) fields.add(m[1]);
    for (const m of script.matchAll(/\b(?:STAGE|FIELD)=(\w+)/g)) fields.add(m[1]);
    fields.delete('setup'); // listed with the others below, checked explicitly
    // The paragraph that defines `<field>`, not just any mention of a name in the
    // section: another paragraph can quote `interrupted` while the list lacks it.
    const doc = section(RUNBOOK, '## 6. Restore test');
    const definition = doc.split('\n\n').find((para) => para.startsWith('`<field>` is'));
    expect(definition, 'section 6 has no paragraph that defines `<field>`').toBeDefined();
    const missing = [...fields, 'setup'].filter((f) => !(definition as string).includes(`\`${f}\``));
    expect(fields.has('interrupted'), 'the parser did not find `interrupted`').toBe(true);
    expect(missing, `section 6 does not list these fields: ${missing.join(', ')}`).toEqual([]);
  });

  it('states the deploy window, and that a missing .env is caught by the absent ping', () => {
    // Prose is hard-wrapped, so compare with whitespace collapsed.
    const flat = (t: string): string => t.replace(/\s+/g, ' ');
    const doc = flat(section(RUNBOOK, '## 6. Restore test'));
    expect(doc).toContain('Do not deploy a migration between 00:00 and 01:10 UTC');
    expect(doc).toContain('MISMATCH migrations');
    expect(doc).toContain('Do not deploy a policy change between 00:00 and 01:10 UTC');
    expect(doc).toContain('MISMATCH policies');
    const all = flat(RUNBOOK);
    expect(all).toContain('A `.env` that cannot be loaded stops either job before its failure handler exists');
    expect(all).toContain('the dead-man check alerts on the absence');
  });
});

describe('the restore test', () => {
  it('stays off the live cluster', () => {
    const lines = code(RESTORE);
    const joined = lines.join('\n');
    expect(joined).not.toContain('docker_postgres_data');
    // Named makrai-restore-test-*, which is what the owner's post-check and the
    // cleanup both look for, and run under exactly that name.
    expect(joined).toMatch(/^NAME="makrai-restore-test-[^"]+"$/m);
    expect(joined).toContain('--name "$NAME"');
    expect(joined).toContain('docker rm -fv "$NAME"');
    expect(joined).toContain('--network none');
    expect(joined).toContain('--mount type=tmpfs,destination=/var/lib/postgresql/data');
    expect(joined).toContain('docker rm -fv');
    expect(joined).toContain("docker inspect -f '{{.Image}}' docker-postgres-1");

    // The container shares no storage and no port with another one. Checked on the
    // `docker run` line only: `-v` is also a psql flag.
    const run = lines.filter((l) => /\bdocker run\b/.test(l));
    expect(run.length, 'expected exactly one docker run').toBe(1);
    expect(run[0]).not.toMatch(/--volumes-from|--volume\b|\s-v\s|--publish|\s-p\s|--privileged|--network (host|container)/);

    // The live container is read by one form only: a single-statement count. A
    // pattern that merely contained `SELECT` would let through a statement that
    // starts with SELECT and goes on to change data after a `;`, so the whole line
    // is anchored and no `;` can appear inside the statement. Its image is
    // inspected. That is all.
    const live = lines.filter((l) => l.includes('docker-postgres-1'));
    expect(live.length, 'the restore test never compares against the live cluster').toBeGreaterThan(0);
    const other = live.filter(
      (l) =>
        !/^\w+=\$\(docker exec docker-postgres-1 psql -U "\$POSTGRES_USER" -d "\$POSTGRES_DB" -Atc "SELECT count\(\*\) FROM [^";]*" 2>>"\$LOG"\)$/.test(l) &&
        !/docker inspect -f '\{\{\.Image\}\}' docker-postgres-1/.test(l),
    );
    expect(other, `these lines touch the live container other than with a one-count SELECT:\n  ${other.join('\n  ')}`).toEqual([]);
  });

  it('never prints a row', () => {
    const lines = code(RESTORE);
    const joined = lines.join('\n');

    // Stdout is rebound to the log before anything runs; the single result goes to fd 4.
    expect(joined).toContain('exec 4>&1 >>"$LOG" 2>&1');

    // Every psql either writes to the log, or returns one count that the script compares.
    const psql = lines.filter((l) => /\bpsql\b/.test(l));
    expect(psql.length, 'no psql invocation found').toBeGreaterThan(0);
    const leaky = psql.filter(
      (l) =>
        !/\s>>"\$LOG" 2>&1$/.test(l) &&
        !/\$\(.*\bpsql\b.* -Atc "SELECT count\(\*\) FROM [^";]*" 2>>"\$LOG"\)/.test(l),
    );
    expect(
      leaky,
      `these psql calls can print a row (or an error with row context) to the session:\n  ${leaky.join('\n  ')}`,
    ).toEqual([]);

    // The only echo that is not a log line is the result.
    const echoes = lines.filter((l) => /\becho\b/.test(l));
    const stray = echoes.filter(
      (l) => !/>>"\$LOG"/.test(l) && !/\becho "RESTORE (MATCH|MISMATCH [^"]+)" >&4$/.test(l),
    );
    expect(stray, `these echo lines can reach stdout:\n  ${stray.join('\n  ')}`).toEqual([]);
    expect(joined).toMatch(/echo "RESTORE MATCH" >&4/);
    expect(joined).toMatch(/echo "RESTORE MISMATCH [^"]+" >&4/);
  });

  it('restore creates every role a migration creates', () => {
    const joined = text(RESTORE);
    const derive =
      /grep -hoE '([^']+)' \/srv\/makrai\/app\/prisma\/migrations\/\*\/migration\.sql \| awk '\{print \$3\}' \| sort -u/;
    const m = derive.exec(joined);
    expect(m, 'the role derivation `grep -hoE ... migration.sql | awk ... | sort -u` is missing').not.toBeNull();
    const re = new RegExp(m![1]);

    const actual = new Set<string>();
    const derived = new Set<string>();
    for (const dir of readdirSync('prisma/migrations', { withFileTypes: true })) {
      const sql = path.join('prisma/migrations', dir.name, 'migration.sql');
      if (!dir.isDirectory() || !existsSync(sql)) continue;
      for (const line of readFileSync(sql, 'utf8').split('\n')) {
        const hit = re.exec(line);
        if (hit) derived.add(hit[0].split(/\s+/)[2]);
        const real = /^(?!\s*--).*\bCREATE\s+ROLE\s+"?([A-Za-z0-9_$]+)"?/i.exec(line);
        if (real) actual.add(real[1]);
      }
    }
    expect(actual.size, 'no CREATE ROLE found in prisma/migrations: the check would be vacuous').toBeGreaterThan(0);
    const missed = [...actual].filter((r) => !derived.has(r));
    expect(
      missed,
      `a migration creates ${missed.join(', ')} but the restore test's grep would not find it, so the ` +
        `restore would fail with "role does not exist" on a database that is fine`,
    ).toEqual([]);
    expect(joined, 'roles are created NOLOGIN').toMatch(/CREATE ROLE [^"]*NOLOGIN/);
  });

  it('restore starts the cluster as the backup owner', () => {
    // The dump carries ALTER ... OWNER TO <owner>, so a cluster whose superuser
    // is anyone else fails the restore on its first ownership statement.
    const joined = text(RESTORE);
    expect(joined).toContain('-e POSTGRES_USER="$POSTGRES_USER"');
    expect(joined).toContain('-e POSTGRES_DB="$POSTGRES_DB"');
  });

  it('restore gives the throwaway cluster a random password, never the real one', () => {
    // load_env exports the whole .env, including the production POSTGRES_PASSWORD.
    // A bare `-e POSTGRES_PASSWORD` would hand that to the throwaway container.
    const lines = code(RESTORE);
    const joined = lines.join('\n');
    // The name is built from parts only so a secret scanner does not read this
    // test's regex as an assignment.
    const pw = ['POSTGRES', 'PASSWORD'].join('_');
    expect(joined).toMatch(new RegExp(`${pw}="?\\$\\([^)]*/dev/urandom`));
    const real = lines.filter((l) => new RegExp(`${pw}="?\\$\\{?${pw}`).test(l));
    expect(real, `passes the real database password on: ${real.join(' | ')}`).toEqual([]);
  });

  it('restore requires non-zero users and organizations', () => {
    // A schema-only dump restores "successfully" and has no rows. Matching
    // policy and migration counts alone would call that a pass.
    const joined = text(RESTORE);
    for (const table of ['users', 'organizations']) {
      expect(joined, `no count of restored ${table}`).toMatch(
        new RegExp(`docker exec "\\$NAME" .*SELECT count\\(\\*\\) FROM ${table}"`),
      );
      expect(joined, `restored ${table} are not required to be above 0`).toMatch(
        new RegExp(`-gt 0 \\] \\|\\| fail ${table}\\b`),
      );
    }
  });

  it('compares policy and migration counts with the live cluster', () => {
    const joined = text(RESTORE);
    expect(joined).toMatch(/docker exec docker-postgres-1 .*SELECT count\(\*\) FROM pg_policies WHERE schemaname='public'/);
    expect(joined).toMatch(/docker exec docker-postgres-1 .*SELECT count\(\*\) FROM _prisma_migrations/);
    expect(joined).toMatch(/docker exec "\$NAME" .*SELECT count\(\*\) FROM pg_policies WHERE schemaname='public'/);
    expect(joined).toMatch(/docker exec "\$NAME" .*SELECT count\(\*\) FROM _prisma_migrations/);
    expect(joined).toMatch(/fail policies/);
    expect(joined).toMatch(/fail migrations/);
  });

  it('restore refuses a stale backup', () => {
    const lines = code(RESTORE);
    const joined = lines.join('\n');
    expect(joined, 'the age limit is 26 hours').toMatch(/^(readonly )?RESTORE_MAX_AGE_MIN=1560$/m);
    expect(joined).toMatch(/-gt "\$RESTORE_MAX_AGE_MIN" \] && fail age/);
  });

  it('writes the evidence line the rotation check reads, then a verdict as its last line', () => {
    const joined = text(RESTORE);
    expect(joined).toMatch(/log "fetched=\$\{?NEWEST\}? age_min=\$\{?AGE_MIN\}?"/);
    expect(joined).toContain('log "Restore test PASSED"');
    expect(joined).toMatch(/log "Restore test FAILED: \$\{?FIELD\}?"/);
    expect(joined).toContain('LOG=/srv/makrai/restore-test.log');
    expect(joined).toContain('umask 077');
    expect(joined).toContain('chmod 600 "$LOG"');
    expect(joined).toMatch(/mktemp -d/);
    expect(joined).toMatch(/\bping_ok HC_RESTORE_PING_URL\b/);
    expect(joined).toMatch(/\bping_fail HC_RESTORE_PING_URL\b/);
    expect(joined).toMatch(/\balert\b/);
  });

  it('decrypts with the passphrase on a file descriptor, never in argv', () => {
    const joined = text(RESTORE);
    expect(joined).toMatch(/gpg --batch --decrypt --passphrase-fd 3 /);
  });

  it('stops the load at the first error', () => {
    // Without ON_ERROR_STOP psql carries on past an error and exits 0: a restore
    // with objects missing that reports success. It has to be on the line that
    // loads the dump, not merely somewhere in the file (the role line has it too).
    const load = code(RESTORE).filter((l) => /docker exec -i /.test(l));
    expect(load.length, 'expected exactly one line that loads the dump').toBe(1);
    expect(load[0]).toContain('-v ON_ERROR_STOP=1');
  });

  it('removes everything it created on every exit, and shreds the encrypted copy', () => {
    const joined = text(RESTORE);
    expect(joined, 'the EXIT trap is what runs on every way out').toContain('trap finish EXIT');
    expect(joined).toContain('shred -u');
    expect(joined).toContain('docker rm -fv "$NAME"');
  });

  it('fails closed: only a run that reached its last line can pass', () => {
    // A signal makes bash run the EXIT trap with $? left over from the last command
    // that finished, usually 0. A pass decided on $? alone therefore reported
    // RESTORE MATCH, logged "Restore test PASSED" and pinged success for a restore
    // that had compared nothing. The pass needs a flag that only the final
    // statement sets.
    const lines = code(RESTORE);
    expect(lines.filter((l) => l === 'COMPLETED='), 'the flag starts empty').toHaveLength(1);
    expect(lines.at(-1), 'the last statement sets the flag').toBe('COMPLETED=1');
    const verdict = lines.filter((l) => /^if \[ "\$rc" -eq 0 \]/.test(l));
    expect(verdict, 'one pass test, on rc, FIELD and the flag').toEqual([
      'if [ "$rc" -eq 0 ] && [ -z "$FIELD" ] && [ "$COMPLETED" = 1 ]; then',
    ]);
    // Reaching the end of the file is the only place the flag may be set.
    expect(lines.filter((l) => /^COMPLETED=1\b/.test(l))).toHaveLength(1);
  });

  it('reports a signal as FAILED: interrupted, with the fail ping and an alert', () => {
    const lines = code(RESTORE);
    const joined = lines.join('\n');
    for (const sig of ['HUP', 'INT', 'TERM']) {
      expect(joined, `no handler for ${sig}`).toMatch(new RegExp(`trap interrupted [A-Z ]*\\b${sig}\\b`));
    }
    expect(joined).toMatch(/^interrupted\(\) \{ FIELD=interrupted; exit 1; \}$/m);
    // A run that exits 0 without finishing (a signal that left $? at 0, or an early
    // `exit 0`) is also labelled interrupted, not given the step it happened in.
    expect(joined).toMatch(/\[ "\$rc" -eq 0 \] && FIELD=interrupted/);
    // The handler must not be cut short by a second signal while it cleans up.
    const handler = lines.slice(lines.indexOf('trap - EXIT'));
    expect(handler.slice(0, 6).join('\n')).toMatch(/trap '' HUP INT TERM/);
  });

  it('logs the two counts when a comparison fails, to the log and never to stdout', () => {
    // A bare "MISMATCH policies" says nothing about by how much. Counts are
    // allowed output, but only in the mode-600 log: fail() writes through log().
    const joined = text(RESTORE);
    expect(joined).toMatch(/fail policies "live=\$\{live_policies\} restored=\$\{rest_policies\}"/);
    expect(joined).toMatch(/fail migrations "live=\$\{live_migrations\} restored=\$\{rest_migrations\}"/);
    expect(joined).toMatch(/fail users "restored=\$\{rest_users\}"/);
    expect(joined).toMatch(/fail organizations "restored=\$\{rest_orgs\}"/);
    expect(joined).toMatch(/^fail\(\) \{ FIELD=\$1; \[ -z "\$\{2:-\}" \] \|\| log "\$1: \$2"; exit 1; \}$/m);
  });
});
