import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

/**
 * NFR-MNT-03 (unit H0). `scripts/test-db/slot.sh up <K>` and `down <K>` create and remove one builder's Postgres
 * (contract "Per-builder database and ports"). A builder runs them on its own slot number only. These cases read
 * the script, and run it against a stand-in `docker` and `npx` that record what they were asked, so no case
 * touches a real container, volume or database.
 */

const SCRIPT = 'scripts/test-db/slot.sh';
// `NodeJS.ProcessEnv` requires NODE_ENV under this project's types; the script is given only what it is named.
const childEnv = (env: Record<string, string>) => env as NodeJS.ProcessEnv;
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

it('NFR-MNT-03 (harness): slot.sh parses, pulls nothing, binds 127.0.0.1, keeps data on a named volume and refuses a slot outside 1 to 10', () => {
  expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
  const s = readFileSync(SCRIPT, 'utf8');
  expect(s).toContain('--pull=never');
  expect(s).toMatch(/-p 127\.0\.0\.1:\$\{?PORT_PG/);
  expect(s).not.toMatch(/docker pull/);
  expect(s).toMatch(/-v "?v060-pg-b\$\{?K\}?-data"?:\/var\/lib\/postgresql\/data/);
  expect(s).not.toMatch(/--tmpfs/); // finding WI-02: `docker stop` empties a tmpfs data directory
  expect(s).toMatch(/docker rm -f -v "?v060-pg-b\$\{?K\}?/);
  expect(s).toMatch(/docker volume rm "?v060-pg-b\$\{?K\}?-data/);
  expect(spawnSync('bash', [SCRIPT, 'up', '11']).status).not.toBe(0);
});

/** A directory of stand-ins that log each call to `calls.log`, and a `.env` file naming the slot's port. */
function sandbox(
  opts: {
    K: number;
    envPort?: number;
    /** The worktree's env file: absent, or holding other lines only. Default: a NEXTAUTH_URL on the slot's port. */
    env?: 'absent' | 'no-port';
    existing?: 'container' | 'volume';
    daemon?: 'down';
  } = { K: 5 },
) {
  const dir = mkdtempSync(join(tmpdir(), 'slot-script-'));
  made.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const state = opts.existing ?? '';
  stub(
    'docker',
    `echo "docker $*" >> "${log}"
case "$1" in
  info) [ "${opts.daemon ?? ''}" = down ] && exit 1 || exit 0 ;;
esac
case "$1 $2" in
  "container inspect") [ "${state}" = container ] && exit 0 || exit 1 ;;
  "volume inspect")    [ "${state}" = volume ] && exit 0 || exit 1 ;;
esac
case "$1" in
  # The init line comes first and a lot follows it, as in a real container's log: a reader that stops at the first match
  # closes the pipe on this writer, which then exits 141, and under pipefail that must not read as "not ready".
  logs) echo "PostgreSQL init process complete; ready for start up."; head -c 3000000 /dev/zero | tr '\\0' 'x'; echo ;;
  exec) cat > /dev/null 2>&1 || true ;;
esac
exit 0`,
  );
  // prisma is stubbed too; it records the database it was pointed at, without the password.
  stub('npx', `echo "npx $* -> $(echo "$DATABASE_URL" | sed -E 's#://[^@]*@#://#')" >> "${log}"; exit 0`);
  const envFile = join(dir, 'env');
  if (opts.env === 'no-port') writeFileSync(envFile, 'AUTH_TRUST_HOST=true\nSOME_OTHER_SETTING=1\n');
  else if (opts.env !== 'absent') writeFileSync(envFile, `NEXTAUTH_URL="http://localhost:${opts.envPort ?? 3100 + opts.K}"\n`);
  const run = (args: string[]) => {
    const r = spawnSync('bash', [SCRIPT, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
      env: childEnv({ PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? '', SLOT_ENV_FILE: envFile, NO_COLOR: '1' }),
    });
    // The output is matched as text, so any escape that arrives is removed first.
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
    return { status: r.status, out: `${r.stdout}${r.stderr}`.replace(ansi, ''), calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  };
  return { run };
}

it('NFR-MNT-03 (harness): slot.sh up creates the container with a named volume, a loopback port and no pull, then migrates and provisions both databases', () => {
  const { run } = sandbox({ K: 5 });
  const r = run(['up', '5']);
  expect(r.status, r.out).toBe(0);
  const dockerRun = r.calls.find((c) => c.startsWith('docker run')) ?? '';
  expect(dockerRun).toContain('--name v060-pg-b5');
  expect(dockerRun).toContain('--pull=never');
  expect(dockerRun).toContain('-p 127.0.0.1:5445:5432');
  expect(dockerRun).toContain('-v v060-pg-b5-data:/var/lib/postgresql/data');
  expect(dockerRun).not.toContain('--tmpfs');
  expect(dockerRun).toMatch(/postgres:16-alpine$/);
  expect(r.calls.some((c) => c.startsWith('docker pull'))).toBe(false);
  expect(r.calls).toContain('docker exec v060-pg-b5 createdb -U makrai makrai');
  // Migrations run on both databases, and the roles are provisioned on both through this slot's container only.
  const migrations = r.calls.filter((c) => c.startsWith('npx prisma migrate deploy'));
  expect(migrations.map((c) => c.split('-> ')[1])).toEqual(['postgresql://localhost:5445/makrai_test', 'postgresql://localhost:5445/makrai']);
  const psql = r.calls.filter((c) => c.startsWith('docker exec -i v060-pg-b5 psql -U makrai'));
  expect(psql.length).toBeGreaterThanOrEqual(4); // two roles on each of two databases
  expect(r.calls.filter((c) => /v060-pg-b(?!5)/.test(c))).toEqual([]); // no other slot is named
  expect(r.out).toMatch(/slot 5 \(v060-pg-b5\) ready on 127\.0\.0\.1:5445/);
  expect(r.out).not.toContain('makrai_dev_password'); // the dev password is used, never printed
});

it('NFR-MNT-03 (harness): slot.sh down removes this slot\'s container and its volume and nothing else', () => {
  const { run } = sandbox({ K: 5, existing: 'container' });
  const r = run(['down', '5']);
  expect(r.status, r.out).toBe(0);
  expect(r.calls).toContain('docker rm -f -v v060-pg-b5');
  expect(r.calls.filter((c) => /^docker (rm|volume rm|stop|kill|network|image|system|prune)/.test(c))).toEqual(['docker rm -f -v v060-pg-b5']);

  const both = sandbox({ K: 5, existing: 'volume' }).run(['down', '5']);
  expect(both.calls).toContain('docker volume rm v060-pg-b5-data');
  // A slot that is already gone is not an error, and nothing is removed.
  const gone = sandbox({ K: 5 }).run(['down', '5']);
  expect(gone.status, gone.out).toBe(0);
  expect(gone.calls.filter((c) => /^docker (rm|volume rm)/.test(c))).toEqual([]);
});

it('NFR-MNT-03 (harness): slot.sh refuses a slot number outside 1 to 10, an unknown command, a slot that exists, and a worktree that is on another slot', () => {
  for (const bad of ['0', '11', '5x', '', '-1', '05', '1;id', '$(id)']) {
    const { run } = sandbox({ K: 5 });
    const r = run(['up', bad]);
    expect(r.status, bad).toBe(2);
    expect(r.calls, bad).toEqual([]); // judged before docker was called
  }
  expect(sandbox({ K: 5 }).run(['restart', '5']).status).toBe(2);
  expect(sandbox({ K: 5 }).run([]).status).toBe(2);

  // `up` never replaces a slot: a leftover container or volume would hand its old data to the new database.
  for (const existing of ['container', 'volume'] as const) {
    const r = sandbox({ K: 5, existing }).run(['up', '5']);
    expect(r.status, existing).toBe(1);
    expect(r.out).toMatch(/slot\.sh down 5/);
    expect(r.calls.some((c) => c.startsWith('docker run'))).toBe(false);
  }

  // The worktree's .env names its own app port; another slot's number is refused before any docker call.
  const wrong = sandbox({ K: 5, envPort: 3106 });
  for (const command of ['up', 'down']) {
    const r = wrong.run([command, '5']);
    expect(r.status, command).toBe(2);
    expect(r.out).toMatch(/3105/);
    expect(r.calls, command).toEqual([]);
  }
});

it('NFR-MNT-03 (harness): slot.sh up waits for the init line without reading a closed pipe as "not ready"', () => {
  // The stand-in's log is the init line followed by 3 MB. With `grep -q` the reader stops at the first line, the writer dies of
  // SIGPIPE, and under pipefail the check fails for ever (here: until the 60 second limit of the run).
  const r = sandbox({ K: 5 }).run(['up', '5']);
  expect(r.status, r.out).toBe(0);
  expect(readFileSync(SCRIPT, 'utf8')).not.toMatch(/grep -q 'PostgreSQL init process complete'/);
});

it('NFR-MNT-03 (harness): slot.sh down asks the docker daemon first, so "absent" means absent', () => {
  const down = sandbox({ K: 5, existing: 'container', daemon: 'down' }).run(['down', '5']);
  expect(down.status).toBe(1);
  expect(down.out).toMatch(/docker daemon/);
  // Nothing was inspected or removed: the answer to "is there a container" would be a lie.
  expect(down.calls.filter((c) => !c.startsWith('docker info'))).toEqual([]);
  // With the daemon up, as before.
  const ok = sandbox({ K: 5, existing: 'container' }).run(['down', '5']);
  expect(ok.status, ok.out).toBe(0);
  expect(ok.calls[0]).toBe('docker info');
});

it('NFR-MNT-03 (harness): slot.sh up accepts a worktree with no env file yet, and refuses only an env file that names another slot', () => {
  // 00-master.md E2 writes the env file after the database exists, so `up` is the first command a new worktree runs.
  const noFile = sandbox({ K: 5, env: 'absent' }).run(['up', '5']);
  expect(noFile.status, noFile.out).toBe(0);
  expect(noFile.calls.some((c) => c.startsWith('docker run'))).toBe(true);
  // An env file that names no port at all names no other slot either.
  const noPort = sandbox({ K: 5, env: 'no-port' }).run(['up', '5']);
  expect(noPort.status, noPort.out).toBe(0);
  // One that names another slot's port is still refused, before any docker call.
  const other = sandbox({ K: 5, envPort: 3106 }).run(['up', '5']);
  expect(other.status).toBe(2);
  expect(other.out).toMatch(/3106[\s\S]*3105/);
  expect(other.calls).toEqual([]);
  // `down` removes data, so it keeps asking for the env file to name the slot.
  for (const env of ['absent', 'no-port'] as const) {
    const r = sandbox({ K: 5, env, existing: 'container' }).run(['down', '5']);
    expect(r.status, env).toBe(2);
    expect(r.calls, env).toEqual([]);
  }
});
