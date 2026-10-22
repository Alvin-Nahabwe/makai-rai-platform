/**
 * A sandbox for `ops/host/makrai-rotate-secrets.sh`.
 *
 * The script is run for real, as bash, against a directory that stands in for `/` (the script's
 * `MAKRAI_ROTATE_ROOT`) and a first-on-PATH set of stand-ins for the programs it drives: `docker`
 * (a small fake world: two containers, a database whose role passwords are files, Compose with its
 * real precedence of process environment over `--env-file`), `sudo`, `gpg`, `openssl`, `curl`, `pgrep`,
 * `date` (a clock that `sleep` advances), `journalctl`, `rsync`, `git`, and the three backup scripts
 * with the log lines and exit codes the chain reads. Every other program the script runs (awk, grep,
 * sed, cmp, find, install, shred ...) is the real one behind a wrapper that records its argv, so a
 * value that reached any process's argument list is found by searching `rec/argv`.
 *
 * No secret here is real. Every value is derived from a fixture seed.
 */
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

/** The script under test; ROTATE_SCRIPT points the suite at a mutated copy when proving a test can fail. */
export const SCRIPT = process.env.ROTATE_SCRIPT ?? 'ops/host/makrai-rotate-secrets.sh';
/** ROTATE_STUBS points the suite at a mutated copy of the stand-ins when proving that a test of them can fail. */
const STUBS = process.env.ROTATE_STUBS ?? path.join(__dirname, 'rotate-stubs');

export const hex = (seed: string): string => createHash('sha256').update(`rotate-fixture-${seed}`).digest('hex');

/** The values production holds before Task 24, invented. */
export const OLD = {
  nextauth: hex('old-nextauth'),
  pgpw: hex('old-owner'),
  apppw: hex('old-app'),
  identity: hex('identity'),
  pass: `old-pass-${hex('old-pass').slice(0, 35)}`,
  admin: hex('old-admin'),
  quotedPct: 'pa@ss%word', // the decoded form of the percent-encoded makrai_app password below
};
export const NEW_PASS_TYPED = `typed-${hex('typed').slice(0, 30)}`;

export const NOW = '2026-10-16T12:20:05Z';

export type EnvOpts = {
  /** APP_DATABASE_URL in double quotes. */
  quotedApp?: boolean;
  /** A percent-encoded makrai_app password. */
  percentApp?: boolean;
  /** A legacy DATABASE_URL line: the owner's, or one that names another role or password. */
  legacy?: boolean | 'other-user' | 'other-pw';
  admin?: boolean;
  /** Lines to append. */
  extra?: string[];
  /** Replace the default lines wholesale. */
  lines?: string[];
};

export function appUrl(pw: string, db = 'makrai'): string {
  return `postgresql://makrai_app:${pw}@postgres:5432/${db}`;
}

export function envLines(o: EnvOpts = {}): string[] {
  if (o.lines) return o.lines;
  const appPw = o.percentApp ? 'pa%40ss%25word' : OLD.apppw;
  const app = appUrl(appPw);
  const lines = [
    '# production',
    'NODE_ENV=production',
    'POSTGRES_USER=makrai',
    'POSTGRES_DB=makrai',
    `POSTGRES_PASSWORD=${OLD.pgpw}`,
    'NEXTAUTH_URL=https://makrai.org',
    `NEXTAUTH_SECRET=${OLD.nextauth}`,
    o.quotedApp ? `APP_DATABASE_URL="${app}"` : `APP_DATABASE_URL=${app}`,
    `IDENTITY_DATABASE_URL=postgresql://makrai_identity:${OLD.identity}@postgres:5432/makrai`,
    `BACKUP_PASSPHRASE=${OLD.pass}`,
    'OFFSITE_TARGET=sub1@box.invalid:',
    'HEALTHCHECK_PING_URL=https://hc.invalid/backup-ping-0001',
    'RESEND_API_KEY=re_invented_0123456789abcdef',
  ];
  if (o.legacy) {
    const user = o.legacy === 'other-user' ? 'someone' : 'makrai';
    const pw = o.legacy === 'other-pw' ? hex('legacy-other') : OLD.pgpw;
    lines.push(`DATABASE_URL=postgresql://${user}:${pw}@postgres:5432/makrai`);
  }
  if (o.admin) lines.push(`ADMIN_PASSWORD=${OLD.admin}`);
  return [...lines, ...(o.extra ?? [])];
}

/** Programs the script runs that are real, behind a wrapper that records argv. */
const WRAPPED = [
  'awk', 'sed', 'grep', 'cut', 'tr', 'tail', 'head', 'sort', 'uniq', 'cmp', 'install', 'mktemp', 'shred', 'stat',
  'find', 'ls', 'wc', 'paste', 'sha256sum', 'gunzip', 'df', 'cat', 'mv', 'rm', 'env', 'timeout', 'touch',
  'mkdir', 'bash', 'sh', 'dd', 'stty',
];

export type BoxOpts = EnvOpts & {
  /** Which awk the script gets. */
  awk?: 'mawk' | 'gawk';
  /** The fake clock at the start. */
  now?: string;
  /** The test is running as root: .env must still belong to someone else. */
  noBackups?: boolean;
};

export type Run = {
  status: number;
  stdout: string;
  stderr: string;
  /** stdout then stderr: everything a person at the terminal could see. */
  all: string;
  last: string;
};

export type RunOpts = {
  input?: string;
  env?: Record<string, string>;
  timeout?: number;
  shellArgs?: string[];
  /**
   * Run under script(1), so that stdin is a terminal (a pty), and strip the carriage returns it adds.
   * With an object, the input is typed `inputDelayMs` after the start (so it arrives while the script is busy, before its
   * prompt), and `then` runs in the same terminal when the script has finished (the shell the owner would be left in).
   */
  tty?: boolean | { inputDelayMs?: number; then?: string };
};

const shq = (a: string): string => `'${a.replace(/'/g, `'\\''`)}'`;

export type Box = ReturnType<typeof makeBox>;

const realBin = (name: string): string => {
  for (const d of ['/usr/bin', '/bin']) if (existsSync(path.join(d, name))) return path.join(d, name);
  throw new Error(`no ${name} on this machine`);
};

export function encrypt(pass: string): Buffer {
  return Buffer.concat([Buffer.from(`GPGSTUB ${pass}\n`), gzipSync('-- dump\n-- PostgreSQL database dump complete\n')]);
}

const nightlyAt = (d: string) => `makrai-${d.replace(/-/g, '')}-000001.sql.gz.gpg`;

export function makeBox(o: BoxOpts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rotate-secrets-'));
  const root = path.join(dir, 'fs');
  const world = path.join(dir, 'world');
  const rec = path.join(dir, 'rec');
  const bin = path.join(dir, 'bin');
  const app = path.join(root, 'srv/makrai/app');
  const rhome = path.join(root, 'root');
  const backups = path.join(root, 'srv/makrai/backups');
  for (const d of [
    path.join(app, 'docker'), path.join(app, 'scripts'), backups, rhome, path.join(root, 'usr/local/bin'),
    path.join(root, 'usr/local/sbin'), path.join(root, 'var/log/makrai'), path.join(world, 'db'),
    path.join(world, 'containers'), path.join(world, 'box'), rec, bin,
  ]) mkdirSync(d, { recursive: true });

  // The checkout: the real compose file and the real provisioning script (its hash is checked).
  copyFileSync('docker/docker-compose.prod.yml', path.join(app, 'docker/docker-compose.prod.yml'));
  copyFileSync('scripts/provision-app-db-role.sh', path.join(app, 'scripts/provision-app-db-role.sh'));
  // The operator's library, with the one path it hard-codes pointed into the sandbox.
  const envPath = path.join(app, '.env');
  writeFileSync(
    path.join(root, 'usr/local/bin/makrai-lib.sh'),
    readFileSync('ops/host/makrai-lib.sh', 'utf8').split('/srv/makrai/app/.env').join(envPath),
  );
  copyFileSync(SCRIPT, path.join(root, 'usr/local/sbin/makrai-rotate-secrets.sh'));
  mkdirSync(path.join(root, 'home', userInfo().username), { recursive: true });

  // PATH: stand-ins, then wrappers over the real tools. Compose runs with an empty environment (env -i),
  // so no stand-in may count on REC, WORLD or the sandbox root being set: each carries its own defaults.
  const prologue = `: "\${REC:=${rec}}" "\${WORLD:=${world}}" "\${MAKRAI_ROTATE_ROOT:=${root}}"`;
  const install = (name: string, body: string): void => {
    const lines = body.split('\n');
    writeFileSync(path.join(bin, name), [lines[0], prologue, ...lines.slice(1)].join('\n'));
    chmodSync(path.join(bin, name), 0o755);
  };
  for (const f of readdirSync(STUBS).filter((n) => !n.endsWith('.sh'))) install(f, readFileSync(path.join(STUBS, f), 'utf8'));
  for (const f of readdirSync(STUBS).filter((n) => n.endsWith('.sh'))) {
    const body = readFileSync(path.join(STUBS, f), 'utf8').split('\n');
    writeFileSync(path.join(root, 'usr/local/bin', f), [body[0], prologue, ...body.slice(1)].join('\n'));
    chmodSync(path.join(root, 'usr/local/bin', f), 0o755);
  }
  for (const name of WRAPPED) {
    const real = name === 'awk' && o.awk ? realBin(o.awk) : realBin(name);
    const head = `#!${realBin('bash')}\nprintf '%s\\n' "${name} $*" >> "$REC/argv"\n`;
    // awk-drop-line: the first awk that writes a new .env line loses its last output line (an awk that mangles its output)
    // root-owned: files the stand-in reports as root's (a test cannot chown): `stat -L -c FORMAT FILE` on one of them, or on a
    // descriptor that names one, prints root for %U (SEC-HARDLINK: set_env makes .env.new as root).
    const owner = name === 'stat'
      ? `if [ -e "$WORLD/app-owner" ] && [ "$1" = -c ] && [ "$2" = %U ] && [ "$3" = ${app} ]; then\n  cat "$WORLD/app-owner"\n  exit 0\nfi\n`
        + `if [ -e "$WORLD/root-owned" ] && [ "$1" = -L ] && [ "$2" = -c ] && [ $# -eq 4 ]; then\n  t=$(/usr/bin/readlink -f -- "$4" 2>/dev/null) || t=\n  if [ -n "$t" ] && /usr/bin/grep -qxF -- "$t" "$WORLD/root-owned"; then exec ${real} -L -c "\${3//%U/root}" -- "$4"; fi\nfi\n`
      : '';
    const drop = name === 'awk'
      ? `if [ -e "$WORLD/awk-drop-line" ] && [ ! -e "$REC/awk-dropped" ] && case "$*" in *'print k "=" ENVIRON'*) true ;; *) false ;; esac; then\n  : > "$REC/awk-dropped"\n  ${real} "$@" | /usr/bin/sed '$d'\n  exit "\${PIPESTATUS[0]}"\nfi\n`
      : '';
    install(name, `${head}${drop}${owner}exec ${real} "$@"\n`);
  }

  // The world.
  const w = (f: string, s: string): void => { mkdirSync(path.dirname(path.join(world, f)), { recursive: true }); writeFileSync(path.join(world, f), s); };
  w('now', `${o.now ?? NOW}\n`);
  w('dump.sql', '-- dump\n-- PostgreSQL database dump complete\n');
  w('login_code', '200');
  w('health', '{"status":"ok"}');
  w('hba', '1\n');
  w('login_roles', 'makrai,makrai_app,makrai_identity\n');
  w('pg_settings', [
    'log_min_duration_sample=-1', 'log_min_duration_statement=-1', 'log_min_error_statement=error', 'log_statement=none',
    'log_transaction_sample_rate=0', 'logging_collector=off', 'password_encryption=scram-sha-256', 'shared_preload_libraries=',
  ].join('\n') + '\n');
  w('jobs', '0\n');
  w('upgrades', '0\n');
  w('migrate-rc', '0\n');
  const lines = envLines(o);
  const envText = `${lines.join('\n')}\n`;
  writeFileSync(envPath, envText, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  if (process.getuid?.() === 0) chownSync(envPath, 65534, 65534);
  const appOf = (text: string): string => {
    const m = /^APP_DATABASE_URL=("?)postgresql:\/\/makrai_app:([^@]*)@/m.exec(text);
    const raw = m ? m[2] : OLD.apppw;
    return raw.includes('%') ? decodeURIComponent(raw) : raw;
  };
  w('db/makrai.pw', OLD.pgpw);
  w('db/makrai_app.pw', appOf(envText));
  w('db/makrai_identity.pw', OLD.identity);
  const nextEnv = ['NEXTAUTH_SECRET', 'APP_DATABASE_URL', 'IDENTITY_DATABASE_URL', 'NEXTAUTH_URL']
    .map((k) => `${k}=${(new RegExp(`^${k}="?([^"\\n]*)"?$`, 'm').exec(envText) ?? [])[1] ?? ''}`)
    .join('\n');
  w('containers/docker-nextjs-1.env', `${nextEnv}\nNODE_ENV=production\n`);
  w('containers/docker-postgres-1.env', `POSTGRES_USER=makrai\nPOSTGRES_DB=makrai\nPOSTGRES_PASSWORD=${OLD.pgpw}\n`);
  w('containers/docker-nextjs-1.started', '2026-10-14T08:00:00.000000000Z\n');
  w('containers/docker-postgres-1.started', '2026-10-14T07:59:00.000000000Z\n');

  // Backups, logs and the box: a healthy night.
  const today = (o.now ?? NOW).slice(0, 10);
  const yday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const nightlies = [nightlyAt(yday), nightlyAt(today)];
  if (!o.noBackups) {
    for (const [i, n] of nightlies.entries()) {
      const age = (nightlies.length - i) * 12 * 3600 * 1000;
      for (const where of [path.join(backups, n), path.join(world, 'box', n)]) {
        writeFileSync(where, encrypt(OLD.pass));
        const t = new Date(Date.now() - age);
        utimesSync(where, t, t);
      }
    }
  }
  const stamp = (t: string): string => `[${t}+00:00]`;
  writeFileSync(path.join(root, 'srv/makrai/backup.log'), [
    `${stamp(`${today}T00:00:01`)} Starting backup...`,
    `${stamp(`${today}T00:00:09`)} Backup verified and encrypted: ${backups}/${nightlies[1]} (4096 bytes before encryption)`,
    `${stamp(`${today}T00:00:10`)} watchdog pinged`,
    `${stamp(`${today}T00:00:10`)} Backup complete.`,
  ].join('\n') + '\n');
  writeFileSync(path.join(root, 'srv/makrai/offsite-copy.log'), [
    `${stamp(`${today}T00:30:01`)} Starting off-site copy...`,
    `${stamp(`${today}T00:30:09`)} Off-site copy complete: 2 backup file(s) mirrored.`,
    `${stamp(`${today}T00:30:10`)} watchdog pinged`,
  ].join('\n') + '\n');
  writeFileSync(path.join(root, 'srv/makrai/restore-test.log'), [
    `${stamp(`${today}T01:00:01`)} Starting restore test...`,
    `${stamp(`${today}T01:00:20`)} fetched=${nightlies[1]} age_min=30`,
    `${stamp(`${today}T01:00:44`)} Restore test PASSED`,
  ].join('\n') + '\n');
  writeFileSync(path.join(root, 'var/log/makrai/synthetic.log'), [
    'step=csrf status=200', `result=pass at=${today}T12:07:04Z`,
  ].join('\n') + '\n');

  // Only what the script is meant to see: nothing from the test runner's environment, none of .env.
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
    ({
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      TZ: 'UTC',
      REC: rec,
      WORLD: world,
      MAKRAI_ROTATE_ROOT: root,
      // A run against a test tree cannot pass a check without this; the tests that show it can leave it out.
      MAKRAI_ROTATE_TEST_TREE: '1',
      ...extra,
    }) as unknown as NodeJS.ProcessEnv; // the project's NODE_ENV typing is required; the script is meant to get none

  const readIf = (f: string): string => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const box = {
    dir, root, world, rec, bin, app, rhome, backups, envPath,
    prevA: path.join(rhome, 'env.prev-a'),
    prevB: path.join(rhome, 'env.prev-b'),
    prevAdmin: path.join(rhome, 'env.prev-admin'),
    stagedProvision: path.join(rhome, 'makrai-stage/t24-provision-app-db-role.sh'),
    state: path.join(rhome, '.makrai-rotate-state'),
    nightlies,
    typed: [] as string[],

    run(args: string[], r: RunOpts = {}): Run {
      const script = path.join(root, 'usr/local/sbin/makrai-rotate-secrets.sh');
      const ttyOpts = typeof r.tty === 'object' ? r.tty : {};
      const inner = ['bash', ...(r.shellArgs ?? []), script, ...args].map(shq).join(' ');
      const p = r.tty
        ? spawnSync('/usr/bin/bash', ['-c', `(/usr/bin/sleep ${(ttyOpts.inputDelayMs ?? 0) / 1000}; /usr/bin/cat) | /usr/bin/script -qefc ${shq(`${inner}${ttyOpts.then ? `; ${ttyOpts.then}` : ''}`)} /dev/null`], {
            encoding: 'utf8', input: r.input ?? '', timeout: r.timeout ?? 120_000, cwd: dir, env: env(r.env),
          })
        : spawnSync('bash', [...(r.shellArgs ?? []), script, ...args], {
            encoding: 'utf8', input: r.input ?? '', timeout: r.timeout ?? 120_000, cwd: dir, env: env(r.env),
          });
      const stdout = (p.stdout ?? '').replace(/\r/g, '');
      const stderr = (p.stderr ?? '').replace(/\r/g, '');
      return {
        status: p.status ?? -1,
        stdout,
        stderr,
        all: stdout + stderr,
        last: stdout.trimEnd().split('\n').at(-1) ?? '',
      };
    },
    procEnv: env,
    /** Run a shell command in the sandbox's environment (to follow an instruction the script printed). */
    sh(cmd: string): { status: number; stdout: string; stderr: string } {
      const p = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', cwd: dir, env: env() });
      return { status: p.status ?? -1, stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
    },
    readEnv: (): string => readFileSync(envPath, 'utf8'),
    writeEnv(text: string): void { writeFileSync(envPath, text); },
    envValue(key: string, file = envPath): string | undefined {
      let v: string | undefined;
      for (const l of readFileSync(file, 'utf8').split('\n')) if (l.startsWith(`${key}=`)) v = l.slice(key.length + 1);
      return v;
    },
    setWorld: w,
    world_: (f: string): string => readIf(path.join(world, f)),
    flag(name: string, on = true): void {
      if (on) writeFileSync(path.join(world, name), '1\n');
      else rmSync(path.join(world, name), { force: true });
    },
    setNow(iso: string): void { writeFileSync(path.join(world, 'now'), `${iso}\n`); },
    db: (role: string): string => readFileSync(path.join(world, `db/${role}.pw`), 'utf8'),
    container: (name: string, key: string): string | undefined => {
      let v: string | undefined;
      for (const l of readIf(path.join(world, `containers/${name}.env`)).split('\n')) if (l.startsWith(`${key}=`)) v = l.slice(key.length + 1);
      return v;
    },
    recFile: (f: string): string[] => readIf(path.join(rec, f)).split('\n').filter(Boolean),
    argv: (): string[] => readIf(path.join(rec, 'argv')).split('\n').filter(Boolean),
    generated: (): string[] => readIf(path.join(rec, 'generated')).split('\n').filter(Boolean),
    stateText: (): string => readIf(path.join(rhome, '.makrai-rotate-state')),
    stateGet(key: string): string | undefined {
      const l = this.stateText().split('\n').find((x) => x.startsWith(`${key}=`));
      return l?.slice(key.length + 1);
    },
    rhomeFiles: (): string[] => readdirSync(rhome).sort(),
    exists: (f: string): boolean => existsSync(f),
    read: (f: string): string => readFileSync(f, 'utf8'),
    mode: (f: string): string => (statSync(f).mode & 0o777).toString(8),
    ino: (f: string): number => statSync(f).ino,
    addBackup(name: string, pass: string, ageMs = 0): void {
      const f = path.join(backups, name);
      writeFileSync(f, encrypt(pass));
      const t = new Date(Date.now() - ageMs);
      utimesSync(f, t, t);
    },
    append(f: string, text: string): void { appendFileSync(f, text); },
    /** Every secret the sandbox has held or made: what no output may contain. */
    secrets(extra: string[] = []): string[] {
      const all = [OLD.nextauth, OLD.pgpw, OLD.apppw, OLD.identity, OLD.pass, OLD.admin, OLD.quotedPct, 'pa%40ss%25word', ...box.generated(), ...box.typed, ...extra];
      return [...new Set(all.filter((s) => s.length >= 8))];
    },
    cleanup(): void { rmSync(dir, { recursive: true, force: true }); },
  };
  return box;
}

/** The names of the files in rec/ that are searched for secrets: everything that records an argument list or a name. */
export const ARGV_RECORDS = ['argv', 'compose-env', 'compose-cwd', 'sleep', 'tcp', 'compose-up', 'compose-run'];

/**
 * Everything a read-only command could change: every file and directory under the sandbox's / and its fake world (path,
 * mode, size, mtime, sha256), the symlinks, and the counts of the restarts and database sessions it made.
 */
export function fsSnapshot(box: Box): string {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = lstatSync(p);
      const r = path.join(rel, name);
      if (st.isSymbolicLink()) out.push(`l ${r} -> ${readlinkSync(p)}`);
      else if (st.isDirectory()) { out.push(`d ${r} ${(st.mode & 0o7777).toString(8)} ${st.mtimeMs}`); walk(p, r); }
      else out.push(`f ${r} ${(st.mode & 0o7777).toString(8)} ${st.size} ${st.mtimeMs} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(box.root, 'fs');
  walk(box.world, 'world');
  out.push(`restarts ${box.recFile('compose-up').length}`, `psql-sessions ${box.recFile('psql-n').join(',') || 0}`);
  return out.join('\n');
}

/** Where a secret appears in what a run printed or any process was handed. Empty is the pass. */
export function leaks(box: Box, runs: Run[], extra: string[] = []): string[] {
  const found: string[] = [];
  const seen = box.secrets(extra);
  const surfaces: Array<[string, string]> = [
    ...runs.map((r, i): [string, string] => [`output of run ${i}`, r.all]),
    ...ARGV_RECORDS.map((f): [string, string] => [`rec/${f}`, box.recFile(f).join('\n')]),
  ];
  for (const [where, text] of surfaces) {
    for (const s of seen) {
      // The whole value, and for a long one its first and last 12 characters: a printed prefix is a leak too.
      const parts = s.length >= 24 ? [s, s.slice(0, 12), s.slice(-12)] : [s];
      for (const part of parts) {
        if (text.includes(part)) found.push(`${where} contains ${part === s ? 'a secret' : 'a fragment of a secret'} (${part.slice(0, 4)}…, ${part.length} of ${s.length} chars)`);
      }
    }
  }
  return found;
}
