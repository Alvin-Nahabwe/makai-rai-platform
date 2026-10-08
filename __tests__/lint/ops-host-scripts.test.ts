import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const EXPECTED_SCRIPTS = [
  'makrai-backup-check.sh',
  'makrai-backup.sh',
  LIB,
  OFFSITE,
  RESTORE,
];

function hostFiles(): string[] {
  return readdirSync(HOST_DIR).sort();
}

function hostScripts(): string[] {
  return hostFiles().filter((f) => f.endsWith('.sh'));
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
    const wrong = hostScripts().filter((f) => code(f)[0] !== 'set -Eeuo pipefail');
    expect(
      wrong,
      `these scripts do not start with \`set -Eeuo pipefail\`, so a failing command in them ` +
        `is ignored and the run goes on to report success: ${wrong.join(', ')}`,
    ).toEqual([]);
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
    expect(joined).toContain('HC_OFFSITE_PING_URL');
    expect(joined, 'a failure must reach the dead-man check as /fail').toContain('ping_fail');
    expect(joined, 'a failure must also alert').toMatch(/\balert\b/);
  });

  it('reaches the Storage Box on port 23, with its own key, without prompting', () => {
    // The restore test uses the same string, so the two cannot disagree.
    const lib = text(LIB);
    expect(lib).toContain('ssh -p 23 -i $HOME/.ssh/makrai_offsite -o BatchMode=yes');
    expect(lib).toContain('-o StrictHostKeyChecking=yes');
    expect(text(RESTORE)).toContain('-e "$OFFSITE_SSH"');
  });

  it('will not mirror an empty directory over the only off-site copy', () => {
    // `rsync --delete` from an empty or unmounted source deletes every remote
    // backup. The script must look for a local backup before it deletes.
    const joined = text(OFFSITE);
    const guard = joined.indexOf('-name');
    const sync = joined.indexOf('rsync');
    expect(guard, 'no check for a local backup before rsync').toBeGreaterThanOrEqual(0);
    expect(guard, 'the check for a local backup must come before rsync').toBeLessThan(sync);
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
`;

/** Runs the given script lines, in order, with `rsync` replaced; returns each rsync call's arguments. */
function rsyncCalls(target: string, lines: string[]): string[][] {
  const dir = mkdtempSync(path.join(tmpdir(), 'ops-host-'));
  try {
    mkdirSync(path.join(dir, 'bin'));
    mkdirSync(path.join(dir, 'work'));
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
        'SRC=/srv/makrai/backups/',
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
    };
    lines.forEach((l, i) => (env[`LINE_${i}`] = l));
    execFileSync('bash', [driver, target], { env, stdio: 'pipe' });
    return readFileSync(record, 'utf8').trim().split('\n').map((l) => l.split(' '));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    const calls = rsyncCalls(target, [
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
    const line = code(OFFSITE).find((l) => /rsync -a --delete/.test(l));
    expect(line, `no rsync line found in ${OFFSITE}`).toBeDefined();
    const calls = rsyncCalls(target, [line as string]);
    expect(calls.length).toBe(1);
    expect(calls[0].at(-1), 'the destination').toBe(mirrored);
    expect(calls[0].at(-2), 'the source').toBe('/srv/makrai/backups/');
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

    // The live container is read, with SELECT, and its image is inspected. That is all.
    const live = lines.filter((l) => l.includes('docker-postgres-1'));
    expect(live.length, 'the restore test never compares against the live cluster').toBeGreaterThan(0);
    const other = live.filter(
      (l) =>
        !/docker exec docker-postgres-1 .*SELECT /.test(l) &&
        !/docker inspect -f '\{\{\.Image\}\}' docker-postgres-1/.test(l),
    );
    expect(other, `these lines touch the live container other than with SELECT:\n  ${other.join('\n  ')}`).toEqual([]);
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
    expect(joined).toContain('HC_RESTORE_PING_URL');
    expect(joined).toContain('ping_fail');
    expect(joined).toMatch(/\balert\b/);
  });

  it('decrypts with the passphrase on a file descriptor, never in argv', () => {
    const joined = text(RESTORE);
    expect(joined).toMatch(/gpg --batch --decrypt --passphrase-fd 3 /);
    expect(joined).toContain('ON_ERROR_STOP=1');
  });
});
