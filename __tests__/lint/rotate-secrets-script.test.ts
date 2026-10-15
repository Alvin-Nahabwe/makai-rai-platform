import { afterAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  type Box,
  OLD,
  type Run,
  SCRIPT,
  appUrl,
  hex,
  leaks,
  makeBox,
} from './helpers/rotate-sandbox';

/**
 * `ops/host/makrai-rotate-secrets.sh` rotates the production secrets an AI-run process held (Task 24):
 * NEXTAUTH_SECRET, the owner role's password, makrai_app's password, BACKUP_PASSPHRASE, and optionally
 * ADMIN_PASSWORD. It replaces a pasted runbook, so what the runbook and its adversarial verification
 * (`task-24-preflight.md`, defects T24-C1..C4 and T24-V1..V18) required is held here.
 *
 * TWO KINDS OF TEST. The static ones read the script as text and pin the properties that keep a value out
 * of argv, off the screen and out of an environment (and the facts it shares with other files: the
 * reviewed provisioning hash, the job list the gate waits for, the log lines of the three backup
 * scripts). The behaviour ones RUN the script, as bash, in a sandbox (`helpers/rotate-sandbox.ts`):
 * a directory standing in for `/`, stand-ins for docker (a fake world with a database whose role
 * passwords are files, and Compose with its real precedence of process environment over `--env-file`),
 * sudo, gpg, openssl, curl, pgrep, journalctl, rsync, git and a clock that `sleep` advances, and the
 * three backup scripts with the log lines and exit codes the chain reads. Every other program is the
 * real one behind a wrapper that records its argv, so a value that reached any argument list is found.
 *
 * WHAT THIS CANNOT SHOW. The sandbox's Postgres is a set of files. That scram over TCP refuses an old
 * password, that Compose recreates the container, that `prisma migrate status` exits 0: the real server
 * settles those, through `precheck` before the owner starts and `check-a` and `check-b` after each stage.
 *
 * Each behaviour test below was made to fail by a deliberate mutation of the script before it was
 * trusted (ROTATE_SCRIPT points the suite at a mutated copy; the report lists them).
 */

vi.setConfig({ testTimeout: 180_000 });

const boxes: Box[] = [];
const newBox = (o: Parameters<typeof makeBox>[0] = {}): Box => {
  const b = makeBox(o);
  boxes.push(b);
  return b;
};
afterAll(() => { for (const b of boxes) b.cleanup(); });

const SUBCOMMANDS = [
  'gate', 'precheck', 'save-prev-a', 'stage-a', 'verify-a', 'fix-owner', 'check-a', 'rollback-a', 'save-prev-b',
  'escrow-check', 'stage-b', 'backup-chain', 'check-b', 'rollback-b', 'admin-password', 'check-next', 'shred-prev',
];

// ---------------------------------------------------------------------------------------------------------
// The script as text
// ---------------------------------------------------------------------------------------------------------

const SRC = readFileSync(SCRIPT, 'utf8');

/** Executable lines: continuations joined, whole-line comments and blank lines dropped. */
function scriptCode(src = SRC): string[] {
  const out: string[] = [];
  let pending = '';
  for (const raw of src.split('\n')) {
    const t = raw.trim();
    if (pending === '' && (t === '' || t.startsWith('#'))) continue;
    if (t.endsWith('\\')) { pending += t.slice(0, -1).trim() + ' '; continue; }
    out.push((pending + t).trim());
    pending = '';
  }
  return out;
}
const CODE = scriptCode();
const CODE_TEXT = CODE.join('\n');

/** The body of one shell function, from `name() {` to its closing `}` at column 0. */
function fn(name: string): string {
  const lines = SRC.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  expect(start, `no function ${name}`).toBeGreaterThan(-1);
  if (lines[start].trimEnd().endsWith('}') && lines[start].includes('{ ') && !lines[start].trimEnd().endsWith('{')) return lines[start];
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return lines.slice(start, end + 1).join('\n');
}

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('makrai-rotate-secrets.sh: what it may do', () => {
  it('starts as the other root scripts do, and refuses an xtrace that would print values', () => {
    expect(CODE.slice(0, 4)).toEqual([
      'set -Eeuo pipefail',
      "case $- in *x*) echo 'ROTATE STOP: xtrace is on, which would print values'; exit 1 ;; esac",
      'cd /',
      'umask 077',
    ]);
    expect(statSync(SCRIPT).mode & 0o111, 'committed executable').not.toBe(0);
  });

  it('never sources a file as root, and never uses sed -i', () => {
    // The only `. file` is inside the `bash -c` string that the operator account runs (opcheck, box_has).
    const sourcing = CODE.filter((l) => /(^|[;&|(]\s*)(\.|source)\s/.test(l));
    expect(sourcing, sourcing.join('\n')).toEqual([]);
    expect(CODE_TEXT).not.toMatch(/\bsed\s+(-[A-Za-z]*i|--in-place)/);
    expect(CODE_TEXT).not.toMatch(/\beval\b/);
    expect(CODE_TEXT).not.toMatch(/set -a\b/);
    // The two places that do source run as the operator, through sudo.
    const viaOperator = CODE.filter((l) => /bash -c '\. "\$1"; load_env/.test(l));
    expect(viaOperator.length).toBeGreaterThanOrEqual(2);
    for (const l of viaOperator) expect(l).toMatch(/sudo -u "\$OP" bash -c/);
  });

  it('exports nothing but the locale, and reads .env as text with builtins', () => {
    expect(CODE.filter((l) => /^export\b/.test(l))).toEqual(['export LC_ALL=C']);
    const reader = fn('envget');
    expect(reader).toContain('IFS= read -r __l');
    expect(reader).toContain('${__l%$\'\\r\'}');
    expect(reader).toMatch(/\[ ! -L "\$__file" \]/);
    // A missing or unreadable file is a different answer from "the key is not there" (T24-V1).
    expect(reader).toContain('|| return 2');
    expect(reader).toContain('return 1');
  });

  it('writes .env only as its owner, from a temp file proven complete, never truncating first', () => {
    const w = fn('write_env');
    expect(w).toContain(`sudo -u "$OP" sh -c 'cat > "$1"' sh "$ENVF" < "$t"`);
    expect(w).toContain('[ -s "$t" ]');
    expect(w).toContain('cmp -s "$t" "$ENVF"');
    // The temp file is in root's directory, not the operator-writable app directory (T24-C15).
    expect(CODE_TEXT).toContain('mktemp "$RHOME/.t24-env.XXXXXX"');
    expect(CODE_TEXT).not.toMatch(/mktemp[^\n]*\$APP/);
    // The copy is not interrupted: a signal would otherwise leave .env half-written and shred the one complete copy.
    const copy = w.indexOf('sudo -u');
    expect(w.lastIndexOf("trap '' HUP INT TERM", copy), 'signals are ignored before the copy').toBeGreaterThan(-1);
    expect(w.indexOf("trap 'STOPMSG=interrupted; exit 130' HUP INT TERM", copy), 'and heard again after it').toBeGreaterThan(copy);
    // Verified before the write: the new line once and exactly, every other line unchanged.
    const p = fn('put_key');
    expect(p.indexOf('did not verify')).toBeGreaterThan(-1);
    expect(p.indexOf('did not verify')).toBeLessThan(p.indexOf('write_env'));
    expect(p).toContain('ENVIRON["V"]');
    expect(p).not.toMatch(/awk[^\n]*-v [A-Za-z]*="\$NEWV"/);
    // No other command writes to .env.
    const writes = CODE.filter((l) => /(>|>>)\s*"?\$(ENVF|APP\/\.env)/.test(l) || /\b(tee|dd|cp|mv|install)\b[^\n]*\$ENVF"?\s*$/.test(l));
    expect(writes, writes.join('\n')).toEqual([]);
  });

  it('refuses a symlinked or foreign .env before it writes', () => {
    const t = fn('env_target');
    expect(t).toContain('[ ! -L "$ENVF" ]');
    expect(t).toContain('stat -c %U "$ENVF"');
    expect(t).toContain('$OP != root');
  });

  it('reads the inode it checked, not the path, wherever a read feeds a write (T22-3)', () => {
    // The checkout is the operator's to write: the path can become a symlink to a root-only file at any moment.
    const pin = fn('pin_env');
    expect(pin).toContain('exec 8<"$ENVF"');
    expect(pin).toContain('ENVR=/proc/$$/fd/8');
    expect(pin).toContain("stat -L -c '%F:%U' \"$ENVR\"");
    expect(pin).toContain('= "regular file:$OP"');
    expect(fn('env_target')).toContain('pin_env && return 0');
    for (const f of ['put_key', 'drop_key', 'save_prev']) {
      const body = fn(f);
      expect(body, f).toContain('"$ENVR"');
      expect(body.replace(/\$ENVF"?\s*<\s*"\$t"/g, ''), `${f} must not read through the path`).not.toMatch(/(grep|awk|cmp|install|cat)\b[^\n]*"\$ENVF"/);
    }
  });

  it('shows nothing Compose or the per-URL check prints without passing it through the redaction filter', () => {
    expect(fn('redact')).toContain("sed -E 's/[A-Za-z0-9+\\/=]{32,}/<redacted>/g'");
    const ups = CODE.filter((l) => /\bcompose up\b/.test(l));
    for (const l of ups) expect(l, l).toContain('2>&1 | redact');
    expect(fn('url_checks')).toContain('| redact');
  });

  it('runs Compose from one place, with an empty environment, and restarts nextjs once with --wait', () => {
    expect(CODE.filter((l) => /\bdocker compose\b/.test(l))).toEqual([
      'compose() { ( cd "$COMPOSE_DIR" && env -i PATH="$PATH" HOME="$RHOME" docker compose --env-file ../.env -f docker-compose.prod.yml "$@" ); }',
    ]);
    expect(CODE).toContain('readonly APP=$R/srv/makrai/app');
    expect(CODE).toContain('readonly COMPOSE_DIR=$APP/docker');
    const ups = CODE.filter((l) => /\bcompose up\b/.test(l));
    expect(ups.length).toBeGreaterThanOrEqual(4);
    for (const l of ups) expect(l).toContain('compose up -d --no-deps --wait --wait-timeout 120 nextjs');
    // Stage A reaches it once.
    expect(fn('stage_a_steps').match(/compose up/g)).toHaveLength(1);
  });

  it('hands the provisioning script only to root\'s own copy, checked against the reviewed hash', () => {
    const pin = /^readonly PROV_SHA256=([0-9a-f]{64})$/m.exec(SRC)?.[1];
    expect(pin, 'no PROV_SHA256').toBeDefined();
    // The pin is the file in this repository: changing scripts/provision-app-db-role.sh without this
    // script (and a new review of how it is called) fails here.
    expect(pin).toBe(sha256('scripts/provision-app-db-role.sh'));
    const s = fn('stage_provision');
    expect(s).toContain('sha256sum -c --strict');
    expect(s).toContain('install -m 0700 "$PROV_SRC" "$PROV"');
    expect(CODE).toContain('readonly PROV=$STAGE_DIR/t24-provision-app-db-role.sh');
    expect(CODE).toContain('readonly STAGE_DIR=$RHOME/makrai-stage');
    const a = fn('app_provision');
    expect(a).toContain('APP_DB_PASSWORD="$pw" PSQL_CMD="docker exec -i $PG psql -U $PGU" "$PROV" "$PGD" makrai_app');
    expect(a).not.toContain('PROV_SRC');
    expect(a.indexOf('stage_provision')).toBeLessThan(a.indexOf('"$PROV" "$PGD"'));
  });

  it('alters the owner role with the provisioning script\'s own statement block', () => {
    const provision = readFileSync('scripts/provision-app-db-role.sh', 'utf8');
    const sets = [...provision.matchAll(/^\s*(?:'(SET [^']+;)'|"(SET [^"]+;)") \\$/gm)].map((m) => m[1] ?? m[2]);
    expect(sets.length, 'found the SET lines of the provisioning script').toBe(8);
    const owner = fn('owner_alter');
    for (const s of sets) expect(owner, s).toContain(s);
    expect(owner).toContain("'\\set VERBOSITY terse'");
    expect(owner).toContain(`"\\\\set pw '$esc'"`);
    expect(owner).toContain(`ALTER ROLE \\"$PGU\\" WITH PASSWORD :'pw';`);
    expect(owner).toContain('psql -X -q -v ON_ERROR_STOP=1 -U "$PGU" -d "$PGD" >/dev/null 2>&1');
    expect(owner).toContain('esc=${p//\\\\/\\\\\\\\}; esc=${esc//\\\'/\\\\\\\'}');
  });

  it('generates every value with openssl rand -hex 32 and nothing else', () => {
    const calls = CODE.filter((l) => /\$\(openssl\b/.test(l));
    expect(calls.length).toBe(2);
    for (const l of calls) expect(l).toContain('openssl rand -hex 32');
    expect(CODE_TEXT).not.toMatch(/\/dev\/u?random|\$RANDOM|\bhead -c\b|\bbase64\b|\buuidgen\b/);
  });

  it('keeps every secret out of argv: gpg takes the passphrase on a descriptor, curl nothing secret', () => {
    expect(CODE_TEXT).not.toMatch(/--passphrase(?![-\w])/);
    expect(CODE_TEXT).not.toMatch(/-H\s*["']Authorization/i);
    const gpg = CODE.filter((l) => /\bgpg --/.test(l));
    expect(gpg).toHaveLength(1);
    expect(gpg[0]).toContain('--passphrase-fd 3');
    expect(gpg[0]).toContain('3<<<"$pp"');
    expect(gpg[0]).toContain('--no-symkey-cache');
    expect(gpg[0]).toContain('2>/dev/null');
    // The prompt is the script's own, hidden, and read as one line (T24-V3).
    expect(fn('decrypts_ok')).toContain('IFS= read -rs pp');
    // Nothing that prints is given a variable that holds a value. (The behaviour tests below search
    // everything the script printed, and every argument list, for the values themselves.)
    const prints = CODE.filter((l) => /^(say|info|echo|printf '[^']*\\n' ["']?[^|]*$)/.test(l) && !/^printf '%s\\n' "\$v"/.test(l));
    const shown = prints.filter((l) => /^(say|info|echo)\b/.test(l) && /\$\{?(NEWV|pp|pw|esc|lp|dec|url|lv)\b/.test(l));
    expect(shown, shown.join('\n')).toEqual([]);
  });

  it('runs the three backup scripts as their own commands, each on a line of its own', () => {
    const scripts = ['makrai-backup.sh', 'makrai-offsite-copy.sh', 'makrai-restore-test.sh'];
    for (const s of scripts) {
      const lines = CODE.filter((l) => l.includes(`${s}"`));
      expect(lines, s).toHaveLength(1);
      expect(lines[0]).toMatch(new RegExp(`^(out=\\$\\()?sudo -u "\\$OP" "\\$BIN/${s.replace(/\./g, '\\.')}"\\)?( \\|\\| rc=\\$\\?)?$`));
    }
    const several = CODE.filter((l) => scripts.filter((s) => l.includes(s)).length > 1);
    expect(several, 'a line that names two of them chains them').toEqual([]);
  });

  it('waits 130 seconds before the off-site copy, and checks nothing under 2 minutes old is left', () => {
    const chain = fn('cmd_backup_chain');
    const sleep = chain.indexOf('sleep 130');
    expect(sleep).toBeGreaterThan(-1);
    expect(chain.indexOf('-mmin -2')).toBeGreaterThan(sleep);
    expect(chain.indexOf('makrai-offsite-copy.sh')).toBeGreaterThan(chain.indexOf('-mmin -2'));
    expect(chain.indexOf('makrai-restore-test.sh')).toBeGreaterThan(chain.indexOf('makrai-offsite-copy.sh'));
    // The new escrow is proven before anything leaves the server.
    expect(chain.indexOf('B5 escrow_decrypt')).toBeGreaterThan(chain.indexOf('makrai-backup.sh'));
    expect(chain.indexOf('B5 escrow_decrypt')).toBeLessThan(sleep);
    // fetched= must be the new file.
    expect(chain).toContain('"fetched=$nb"');
  });

  it('uses the log lines, file names and fields the three backup scripts really write', () => {
    const backup = readFileSync('ops/host/makrai-backup.sh', 'utf8');
    const offsite = readFileSync('ops/host/makrai-offsite-copy.sh', 'utf8');
    const restore = readFileSync('ops/host/makrai-restore-test.sh', 'utf8');
    for (const [name, text] of [
      ['Backup verified and encrypted: ', backup], ['Backup complete.', backup], ['watchdog pinged', backup],
      ['WARNING: watchdog ping failed', backup], ['Off-site copy complete', offsite], ['watchdog pinged', offsite],
      ['Skipped ${f}', offsite], ['Restore test PASSED', restore], ['fetched=${NEWEST}', restore],
      ['RESTORE MATCH', restore], ['RESTORE MISMATCH', restore],
    ] as const) {
      expect(text, `the real script no longer logs "${name}"`).toContain(name);
      expect(CODE_TEXT.replace(/\$\{?[a-z_]+\}?/g, '').length).toBeGreaterThan(0);
    }
    for (const [name] of [
      ['Backup verified and encrypted: '], ['Backup complete'], ['watchdog pinged'], ['WARNING: watchdog ping failed'],
      ['Off-site copy complete'], ['Skipped '], ['Restore test PASSED'], ['fetched='], ['RESTORE MATCH'], ['RESTORE MISMATCH '],
    ] as const) expect(SRC, `the rotate script does not look for "${name}"`).toContain(name);
    // The restore test's fields that mean something to the chain.
    for (const f of ['fetch', 'restore', 'cluster', 'roles', 'policies', 'migrations', 'users', 'organizations']) {
      expect(restore, f).toMatch(new RegExp(`(fail ${f}\\b|STAGE=${f}\\b)`));
      expect(fn('chain_advice'), f).toContain(f);
    }
    // The nightly name is the restore test's filter, character for character.
    const nightly = /readonly NIGHTLY='([^']+)'/.exec(SRC)?.[1];
    expect(nightly).toBe('^makrai-[0-9]{8}-[0-9]{6}\\.sql\\.gz\\.gpg$');
    expect(restore).toContain("grep -E '^makrai-[0-9]{8}-[0-9]{6}\\.sql\\.gz\\.gpg$'");
  });

  it('waits for every job the crontabs run, and the package upgrades that could replace docker', () => {
    const re = /readonly JOBS_RE='([^']+)'/.exec(SRC)?.[1] ?? '';
    expect(re).toBe('[m]akrai-(backup|offsite-copy|restore-test|synthetic|auditlog|email-scan|prefix-export)');
    const jobs = new RegExp(re.replace(/\[m\]/, 'm'));
    const cron = ['crontab.root', 'crontab.operator'].flatMap((f) => readFileSync(path.join('ops/host', f), 'utf8').split('\n'))
      .filter((l) => /^[\d*]/.test(l.trim()))
      .map((l) => /\/(makrai-[a-z-]+\.sh)/.exec(l)?.[1] ?? '');
    expect(cron.length, 'found the cron jobs').toBeGreaterThanOrEqual(7);
    for (const j of cron) expect(j, `a cron job the gate does not wait for`).toMatch(jobs);
    expect(SRC).toContain("readonly UPGRADE_RE='[b]in/unattended-upgrade( |$)|[a]pt\\.systemd\\.daily'");
  });

  it('is run through exactly the subcommands its header, its dispatch and the README list', () => {
    const dispatch = [...SRC.matchAll(/^  ([a-z][a-z-]*)\)\s+NAME=([A-Z-]+);\s+cmd_([a-z_]+) "\$@" ;;$/gm)];
    expect(dispatch.map((m) => m[1])).toEqual(SUBCOMMANDS);
    for (const m of dispatch) {
      expect(m[2], `${m[1]}'s marker name`).toBe(m[1].toUpperCase());
      expect(m[3]).toBe(m[1].replace(/-/g, '_'));
    }
    const header = SRC.split('\nset -Eeuo')[0];
    for (const s of SUBCOMMANDS) expect(header, `${s} is missing from the header table`).toMatch(new RegExp(`^# ${s.replace(/-/g, '[- ]')}\\b`, 'm'));
    // One place prints the final marker, from an EXIT trap, so a `set -e` abort or an unset variable still ends in STOP.
    const fin = fn('finish');
    expect(fin).toContain("printf '%s OK\\n' \"$NAME\"");
    expect(fin).toContain("printf '%s STOP%s\\n' \"$NAME\"");
    expect(CODE).toContain('trap finish EXIT');
    expect(fin).toContain('[ "$rc" -ne 0 ] || rc=1');
  });

  it('takes the lock before any command that changes something', () => {
    const changing = ['cmd_save_prev_a', 'cmd_stage_a', 'cmd_fix_owner', 'cmd_rollback_a', 'cmd_save_prev_b', 'cmd_escrow_check', 'cmd_stage_b', 'cmd_backup_chain', 'cmd_rollback_b', 'cmd_admin_password', 'cmd_shred_prev'];
    for (const f of changing) expect(fn(f), f).toContain('lock_or_stop');
    for (const f of ['cmd_precheck', 'cmd_check_a', 'cmd_check_b', 'cmd_check_next', 'cmd_gate']) expect(fn(f), `${f} writes nothing`).not.toContain('lock_or_stop');
  });

  it('names no person, address or home path', () => {
    // ops-host-scripts.test.ts holds this for every host file; this is the rotate script in particular, where the operator is the owner of .env.
    expect(SRC).not.toMatch(/\/home\//);
    expect(SRC).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(CODE_TEXT).toContain('stat -c %U "$ENVF"');
  });
});

// ---------------------------------------------------------------------------------------------------------
// The sandbox, driven
// ---------------------------------------------------------------------------------------------------------

/** Take the root copy and run Stage A at 12:20Z. */
function stageA(box: Box, extraEnv: Record<string, string> = {}): { save: Run; stage: Run } {
  const save = box.run(['save-prev-a'], { env: extraEnv });
  expect(save.last, save.all).toBe('SAVE-PREV-A OK');
  const stage = box.run(['stage-a'], { env: extraEnv });
  return { save, stage };
}

/** Stage A, then everything before the chain of Stage B (B0, B1, B2), at 13:20Z. Returns every run. */
function toStageBWritten(box: Box): Run[] {
  const runs: Run[] = [];
  const a = stageA(box);
  runs.push(a.save, a.stage);
  expect(a.stage.last, a.stage.all).toBe('STAGE-A OK');
  box.setNow('2026-10-16T13:20:05Z');
  runs.push(box.run(['save-prev-b']));
  expect(runs.at(-1)?.last, runs.at(-1)?.all).toBe('SAVE-PREV-B OK');
  runs.push(box.run(['escrow-check', 'pre'], { input: `${OLD.pass}\n` }));
  expect(runs.at(-1)?.last, runs.at(-1)?.all).toBe('ESCROW-CHECK OK');
  box.typed.push(OLD.pass);
  runs.push(box.run(['stage-b']));
  expect(runs.at(-1)?.last, runs.at(-1)?.all).toBe('STAGE-B OK');
  return runs;
}

/** Everything through the chain of Stage B. */
function toChainDone(box: Box): Run[] {
  const runs = toStageBWritten(box);
  const pass = box.envValue('BACKUP_PASSPHRASE') as string;
  runs.push(box.run(['backup-chain'], { input: `${pass}\n` }));
  expect(runs.at(-1)?.last, runs.at(-1)?.all).toBe('BACKUP-CHAIN OK');
  syntheticPassed(box, '2026-10-16T13:07:04Z');
  return runs;
}

/** The hourly synthetic journey passed at this time (the :07 run after Stage A). */
const syntheticPassed = (box: Box, at: string): void => box.append(path.join(box.root, 'var/log/makrai/synthetic.log'), `result=pass at=${at}\n`);

const envMinus = (text: string, keys: string[]): string[] =>
  text.split('\n').filter((l) => l !== '' && !keys.some((k) => l.startsWith(`${k}=`)));

describe('makrai-rotate-secrets.sh: the precheck', () => {
  it('passes on a healthy production, writes nothing, and ends in PRECHECK OK', () => {
    const box = newBox();
    const before = box.readEnv();
    const r = box.run(['precheck']);
    expect(r.status, r.all).toBe(0);
    expect(r.last).toBe('PRECHECK OK');
    expect(r.stdout.split('\n').filter((l) => l.startsWith('FAIL'))).toEqual([]);
    for (const want of [
      'ok    login=200', 'ok    health={"status":"ok"}', 'ok    jobs_running=0', 'ok    tcp_owner_env=ACCEPTED',
      'ok    tcp_makrai_app_env=ACCEPTED', 'ok    nextjs_DATABASE_URL=0', 'ok    app_url_tail_is_postgres_5432_db=SAME',
      'ok    login_roles=makrai,makrai_app,makrai_identity', 'ok    operator_load_env=ok',
      'ok    nextjs_vs_env_NEXTAUTH_SECRET=SAME', 'ok    postgres_vs_env_POSTGRES_PASSWORD=SAME',
    ]) expect(r.stdout, want).toContain(want);
    // Read-only: .env, the world and root's directory are as they were.
    expect(box.readEnv()).toBe(before);
    expect(box.rhomeFiles().filter((f) => f !== '.makrai-rotate.lock')).toEqual([]);
    expect(box.db('makrai')).toBe(OLD.pgpw);
    expect(leaks(box, [r])).toEqual([]);
  });

  it.each<[string, (b: Box) => void, string]>([
    ['a job is running', (b) => b.setWorld('jobs', '1\n'), 'FAIL  jobs_running=1'],
    ['the site is down', (b) => b.setWorld('health', '{"status":"error"}'), 'FAIL  health='],
    ['login does not answer 200', (b) => b.setWorld('login_code', '502'), 'FAIL  login=502'],
    ['the last restore test failed', (b) => b.append(path.join(b.root, 'srv/makrai/restore-test.log'), '[2026-10-16T01:30:00+00:00] Restore test FAILED: restore\n'), 'FAIL  restore_last_passed=0'],
    ['the checkout is dirty', (b) => b.setWorld('git-status', ' M scripts/provision-app-db-role.sh\n'), 'FAIL  checkout_dirty=1'],
    ['the provisioning script is not the reviewed one', (b) => b.append(path.join(b.app, 'scripts/provision-app-db-role.sh'), '# tampered\n'), 'FAIL  provision_sha256_is_the_reviewed_one=no'],
    ['an extra role can log in', (b) => b.setWorld('login_roles', 'makrai,makrai_app,makrai_identity,intruder\n'), 'FAIL  login_roles='],
    ['statement logging is on', (b) => b.setWorld('pg_settings', 'log_min_duration_sample=-1\nlog_min_duration_statement=-1\nlog_min_error_statement=error\nlog_statement=all\nlog_transaction_sample_rate=0\npassword_encryption=scram-sha-256\nshared_preload_libraries=\n'), 'FAIL  pg_settings='],
    ['the owner password is not accepted over TCP', (b) => b.setWorld('db/makrai.pw', 'something-else'), 'FAIL  tcp_owner_env=REFUSED'],
    ['the web container holds a DATABASE_URL', (b) => b.append(path.join(b.world, 'containers/docker-nextjs-1.env'), 'DATABASE_URL=x\n'), 'FAIL  nextjs_DATABASE_URL=1'],
    ['the container is not the .env value', (b) => b.setWorld('containers/docker-nextjs-1.env', 'NEXTAUTH_SECRET=stale\nAPP_DATABASE_URL=x\nIDENTITY_DATABASE_URL=y\n'), 'FAIL  nextjs_vs_env_NEXTAUTH_SECRET=DIFFERENT'],
    ['the web container is unhealthy', (b) => b.setWorld('containers/docker-nextjs-1.health', 'unhealthy'), 'FAIL  inspect_docker-nextjs-1=running unhealthy'],
    ['.env has an export line', (b) => b.writeEnv(`${b.readEnv()}export SOMETHING=1\n`), 'FAIL  prefixed_or_indented=1'],
    ['.env is not mode 600', (b) => chmodSync(b.envPath, 0o640), 'FAIL  env_stat=640 regular file'],
    ['the operator\'s jobs cannot source .env', (b) => b.writeEnv(`${b.readEnv()}NOT A VALID LINE\n`), 'FAIL  operator_load_env=failed'],
    ['the synthetic journey is failing', (b) => b.append(path.join(b.root, 'var/log/makrai/synthetic.log'), 'result=fail at=2026-10-16T12:07:09Z\n'), 'FAIL  synthetic_last_result=result=fail'],
  ])('stops, with a FAIL line and a non-zero status, when %s', (name, arrange, want) => {
    const box = newBox();
    arrange(box);
    const r = box.run(['precheck']);
    expect(r.status, r.all).not.toBe(0);
    expect(r.stdout, name).toContain(want);
    expect(r.last).toMatch(/^PRECHECK STOP: \d+ check\(s\) failed$/);
  });

  it('stops when the host is not on UTC, because the journal windows and the gate are read as UTC (T24-V9)', () => {
    const box = newBox();
    const r = box.run(['precheck'], { env: { TZ: 'Africa/Kampala' } });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('FAIL  tz=EAT (expected UTC)');
    expect(box.run(['precheck']).last).toBe('PRECHECK OK');
  });

  it('keeps going to a verdict when a fact is missing, and does not die half-way (set -e with pipefail)', () => {
    const noBackups = newBox();
    rmSync(noBackups.backups, { recursive: true });
    const r = noBackups.run(['precheck']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('FAIL  newest_backup_is_from_today=no');
    expect(r.stdout, 'it got to the last check').toContain('url_app=');
    expect(r.last).toMatch(/^PRECHECK STOP: \d+ check\(s\) failed$/);
    const after = newBox();
    stageA(after);
    after.writeEnv(after.readEnv().replace(/^APP_DATABASE_URL=.*\n/m, ''));
    const c = after.run(['check-a']);
    expect(c.status).not.toBe(0);
    expect(c.stdout).toContain('FAIL  leak_patterns=2 (expected 3)');
    expect(c.stdout).toContain('FAIL  leak_scan not run');
    expect(c.last).toMatch(/^CHECK-A STOP: \d+ check\(s\) failed$/);
  });

  it('reports a DATABASE_URL that names the owner with its password as removable, and any other as a STOP', () => {
    const ok = newBox({ legacy: true });
    const r = ok.run(['precheck']);
    expect(r.last, r.all).toBe('PRECHECK OK');
    expect(r.stdout).toContain('ok    legacy_url_user_is_owner=SAME');
    expect(r.stdout).toContain('ok    legacy_pw_is_owner_pw=SAME');
    expect(r.stdout).toContain('ok    legacy_url_read_by_host_scripts=0');
    for (const kind of ['other-user', 'other-pw'] as const) {
      const bad = newBox({ legacy: kind });
      const s = bad.run(['precheck']);
      expect(s.status, kind).not.toBe(0);
      expect(s.stdout).toMatch(kind === 'other-user' ? /FAIL  legacy_url_user_is_owner=DIFFERENT/ : /FAIL  legacy_pw_is_owner_pw=DIFFERENT/);
    }
  });

  it('tells a precheck after a rollback from one before Stage A: postgres_vs_env may differ only with --post-rollback', () => {
    const box = newBox();
    box.setWorld('containers/docker-postgres-1.env', 'POSTGRES_PASSWORD=old-container-value\n');
    const strict = box.run(['precheck']);
    expect(strict.stdout).toContain('FAIL  postgres_vs_env_POSTGRES_PASSWORD=DIFFERENT');
    expect(strict.status).not.toBe(0);
    const post = box.run(['precheck', '--post-rollback']);
    expect(post.stdout).toContain('info  postgres_vs_env_POSTGRES_PASSWORD=DIFFERENT');
    expect(post.last, post.all).toBe('PRECHECK OK');
  });

  it('refuses outside root, with xtrace on, and with an unknown argument, each with a marker', () => {
    const box = newBox();
    const nonRoot = box.run(['precheck'], { env: { STUB_UID: '1000' } });
    expect(nonRoot.status).not.toBe(0);
    expect(nonRoot.last).toBe('PRECHECK STOP: this script runs as root');
    const traced = box.run(['precheck'], { shellArgs: ['-x'] });
    expect(traced.status).not.toBe(0);
    expect(traced.stdout).toContain('ROTATE STOP: xtrace is on');
    expect(traced.stderr).not.toContain(OLD.pgpw);
    const bad = box.run(['precheck', '--nope']);
    expect(bad.status).not.toBe(0);
    expect(bad.last).toBe('PRECHECK STOP: usage: precheck [--post-rollback]');
    const none = box.run([]);
    expect(none.status).not.toBe(0);
    expect(none.last).toBe('ROTATE STOP: usage');
  });
});

describe('makrai-rotate-secrets.sh: the timing gate', () => {
  const at = (hh: string, mm: string): string => `2026-10-16T${hh}:${mm}:30Z`;
  const closed: Array<[string, string, string]> = [
    ['12', '14', 'between hh:15 and hh:50'], ['12', '51', 'between hh:15 and hh:50'], ['12', '00', 'between hh:15 and hh:50'],
    ['21', '59', 'between hh:15 and hh:50'],
    ['22', '30', 'not in the hours'], ['23', '30', 'not in the hours'], ['00', '30', 'not in the hours'], ['01', '30', 'not in the hours'],
    ['02', '30', 'not in the hours'], ['03', '30', 'not in the hours'], ['06', '30', 'not in the hours'],
  ];
  it.each(closed)('refuses %s:%s UTC', (hh, mm, why) => {
    const box = newBox();
    box.setNow(at(hh, mm));
    const r = box.run(['gate']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain(why);
    expect(r.last).toMatch(/^GATE STOP/);
  });
  it.each([['04', '30'], ['05', '30'], ['07', '15'], ['12', '20'], ['12', '50'], ['15', '15'], ['21', '30']])('opens at %s:%s UTC', (hh, mm) => {
    const box = newBox();
    box.setNow(at(hh, mm));
    const r = box.run(['gate']);
    expect(r.status, r.all).toBe(0);
    expect(r.last).toBe('GATE OK');
  });
  it('refuses while a scheduled job runs, and while a package upgrade runs', () => {
    const box = newBox();
    box.setWorld('jobs', '2\n');
    const a = box.run(['gate']);
    expect(a.status).not.toBe(0);
    expect(a.stdout).toContain('scheduled jobs running: 2');
    expect(a.stdout).toContain('GATE: a scheduled job is running');
    box.setWorld('jobs', '0\n');
    box.setWorld('upgrades', '1\n');
    const b = box.run(['gate']);
    expect(b.status).not.toBe(0);
    expect(b.stdout).toContain('GATE: a package upgrade is running');
  });
  it('asks pgrep for the jobs the crontabs run, and for unattended-upgrade', () => {
    const box = newBox();
    box.run(['gate']);
    const asks = box.argv().filter((l) => l.startsWith('pgrep '));
    expect(asks).toContain('pgrep -fc [m]akrai-(backup|offsite-copy|restore-test|synthetic|auditlog|email-scan|prefix-export)');
    expect(asks.some((l) => l.includes('unattended-upgrade'))).toBe(true);
  });
  it.each(['stage-a', 'stage-b', 'backup-chain', 'rollback-b', 'admin-password'])('%s changes nothing when the gate is closed', (sub) => {
    const box = newBox({ admin: true });
    // Bring the box to the point each command's own gate is the first thing it meets.
    const setup: Run[] = [];
    if (sub === 'stage-a') setup.push(box.run(['save-prev-a']));
    if (sub === 'stage-b') {
      setup.push(box.run(['save-prev-a']), box.run(['stage-a']));
      box.setNow('2026-10-16T13:20:05Z');
      setup.push(box.run(['save-prev-b']), box.run(['escrow-check', 'pre'], { input: `${OLD.pass}\n` }));
    }
    if (sub === 'backup-chain' || sub === 'rollback-b') setup.push(...toStageBWritten(box));
    const before = box.readEnv();
    const generated = box.generated().length;
    box.setNow('2026-10-16T23:30:00Z');
    const args = sub === 'rollback-b' ? [sub, 'line'] : [sub];
    const r = box.run(args);
    expect(r.status, `${setup.length} setup runs; ${r.all}`).not.toBe(0);
    expect(r.stdout).toContain('GATE: not in the hours');
    expect(r.last).toMatch(new RegExp(`^${sub.toUpperCase()} STOP`));
    expect(box.readEnv()).toBe(before);
    expect(box.generated().length, 'no value was generated').toBe(generated);
  });
});

describe('makrai-rotate-secrets.sh: Stage A, then Stage B, then the next night', () => {
  it('rotates the three Stage A values, restarts nextjs once, and every check passes', () => {
    const box = newBox();
    const oldEnv = box.readEnv();
    const ino = box.ino(box.envPath);
    const { stage } = stageA(box);
    expect(stage.status, stage.all).toBe(0);
    expect(stage.last).toBe('STAGE-A OK');
    const out = stage.stdout.split('\n');
    const markers = out.filter((l) => /^(T0=|gate: open|A\d OK|OWNER-ALTER OK|APP-PROVISION OK|DATABASE_URL: no line|A6 )/.test(l));
    expect(markers).toEqual([
      'gate: open', 'T0=2026-10-16T12:20:05Z', 'A1 OK', 'OWNER-ALTER OK', 'A2 OK', 'DATABASE_URL: no line, nothing to do', 'A3 OK',
      'APP-PROVISION OK', 'A4 OK', 'A5 OK', 'A6 health=ok', 'A6 migrate-status rc=0',
    ]);
    const now = box.readEnv();
    // The same file: owner, mode and inode kept.
    expect(box.ino(box.envPath)).toBe(ino);
    expect(box.mode(box.envPath)).toBe('600');
    // Three lines changed, in shape; nothing else moved, in order.
    expect(now.split('\n').filter((l) => /^(NEXTAUTH_SECRET|POSTGRES_PASSWORD)=[0-9a-f]{64}$/.test(l))).toHaveLength(2);
    expect(now).toMatch(/^APP_DATABASE_URL=postgresql:\/\/makrai_app:[0-9a-f]{64}@postgres:5432\/makrai$/m);
    expect(envMinus(now, ['NEXTAUTH_SECRET', 'POSTGRES_PASSWORD', 'APP_DATABASE_URL'])).toEqual(envMinus(oldEnv, ['NEXTAUTH_SECRET', 'POSTGRES_PASSWORD', 'APP_DATABASE_URL']));
    expect(now.split('\n').map((l) => l.split('=')[0])).toEqual(oldEnv.split('\n').map((l) => l.split('=')[0]));
    // The database holds exactly what .env does.
    const newPw = box.envValue('POSTGRES_PASSWORD');
    expect(box.db('makrai')).toBe(newPw);
    expect(box.db('makrai')).not.toBe(OLD.pgpw);
    const appPw = /makrai_app:([0-9a-f]{64})@/.exec(box.envValue('APP_DATABASE_URL') ?? '')?.[1];
    expect(box.db('makrai_app')).toBe(appPw);
    expect(box.db('makrai_identity'), 'makrai_identity is not rotated').toBe(OLD.identity);
    expect(box.envValue('IDENTITY_DATABASE_URL')).toContain(OLD.identity);
    // The container was restarted once, with the new values; postgres was not touched.
    expect(box.recFile('compose-up')).toEqual(['compose up -d --no-deps --wait --wait-timeout 120 nextjs']);
    expect(box.container('docker-nextjs-1', 'NEXTAUTH_SECRET')).toBe(box.envValue('NEXTAUTH_SECRET'));
    expect(box.container('docker-nextjs-1', 'APP_DATABASE_URL')).toBe(box.envValue('APP_DATABASE_URL'));
    expect(box.world_('containers/docker-postgres-1.started')).toBe('2026-10-14T07:59:00.000000000Z\n');
    expect(box.stateGet('A_DONE')).toBe('1');
    expect(leaks(box, [stage])).toEqual([]);
    const check = box.run(['check-a']);
    expect(check.status, check.all).toBe(0);
    expect(check.last).toBe('CHECK-A OK');
    for (const want of [
      'ok    nextjs_NEXTAUTH_SECRET_vs_prev=DIFFERENT', 'ok    nextjs_APP_DATABASE_URL_vs_prev=DIFFERENT',
      'ok    nextjs_IDENTITY_DATABASE_URL_vs_prev=SAME', 'ok    tcp_owner_env=ACCEPTED', 'ok    tcp_owner_prev_a=REFUSED',
      'ok    tcp_makrai_app_env=ACCEPTED', 'ok    tcp_makrai_app_prev_a=REFUSED', 'ok    postgres_start_unchanged=SAME',
      'ok    nextjs_started_after_T0=yes', 'ok    keydiff_names=APP_DATABASE_URL,NEXTAUTH_SECRET,POSTGRES_PASSWORD',
      'ok    leak_patterns=3',
    ]) expect(check.stdout, want).toContain(want);
    expect(leaks(box, [stage, check])).toEqual([]);
  });

  it('rotates the passphrase, proves both escrows, runs the chain in order, and the next night closes it', () => {
    const box = newBox();
    const runs = toChainDone(box);
    const chain = runs.at(-1) as Run;
    // Hex, from openssl, differing from the old value; the old line's neighbours are unmoved.
    const pass = box.envValue('BACKUP_PASSPHRASE') as string;
    expect(pass).toMatch(/^[0-9a-f]{64}$/);
    expect(box.generated()).toContain(pass);
    expect(pass).not.toBe(OLD.pass);
    const out = chain.stdout.split('\n');
    expect(out.filter((l) => /^(B\d|NEWBACKUP=)/.test(l))).toEqual([
      'B4 OK', 'NEWBACKUP=makrai-20261016-132005.sql.gz.gpg', 'B5 escrow_decrypt=1', 'B6 OK', 'B7 rc=0', 'B7 box_has_new=yes', 'B7 OK',
      'B8 result=RESTORE MATCH rc=0', 'B8 FETCHED-NEW', 'B8 OK',
    ]);
    // The order of the calls: hand backup, the escrow decrypt of the new file, the wait, the copy, the restore.
    const calls = box.argv();
    const idx = (re: RegExp, from = 0): number => { const i = calls.findIndex((l, n) => n >= from && re.test(l)); expect(i, String(re)).toBeGreaterThan(-1); return i; };
    const backup = idx(/makrai-backup\.sh$/);
    const decrypt = idx(/^gpg .*makrai-20261016-132005/, backup);
    const wait = idx(/^sleep 130$/, decrypt);
    const offsite = idx(/makrai-offsite-copy\.sh$/, wait);
    const restore = idx(/makrai-restore-test\.sh$/, offsite);
    expect(backup < decrypt && decrypt < wait && wait < offsite && offsite < restore).toBe(true);
    for (const s of ['makrai-backup.sh', 'makrai-offsite-copy.sh', 'makrai-restore-test.sh']) {
      const asked = calls.filter((l) => l.startsWith('sudo -u ') && l.endsWith(`/${s}`));
      expect(asked, `${s} is run once, by sudo -u <operator>`).toHaveLength(1);
      expect(asked[0]).toMatch(/^sudo -u \S+ \S*\/usr\/local\/bin\//);
    }
    expect(box.stateGet('B_DONE')).toBe('1');
    const check = box.run(['check-b']);
    expect(check.status, check.all).toBe(0);
    expect(check.last).toBe('CHECK-B OK');
    expect(check.stdout).toContain('ok    keydiff_names=BACKUP_PASSPHRASE');
    expect(check.stdout).toContain('ok    restore_last_fetched_is_N=SAME');
    // Not yet: the next night's chain has not run.
    const early = box.run(['check-next']);
    expect(early.status).not.toBe(0);
    expect(early.stdout).toContain('FAIL  newest_local_is_after_N=no');
    const refuse = box.run(['shred-prev']);
    expect(refuse.status).not.toBe(0);
    expect(refuse.last).toMatch(/^SHRED-PREV STOP: the next night's chain is not proven/);
    for (const f of [box.prevA, box.prevB, box.stagedProvision]) expect(existsSync(f), `${f} is kept`).toBe(true);
    // The next night: 00:00 backup under the new passphrase, the copy, the restore test.
    const nightly = 'makrai-20261017-000001.sql.gz.gpg';
    box.addBackup(nightly, pass, 1000);
    const log = (f: string, lines: string[]): void => box.append(path.join(box.root, 'srv/makrai', f), `${lines.join('\n')}\n`);
    log('backup.log', ['[2026-10-17T00:00:09+00:00] Backup verified and encrypted: x', '[2026-10-17T00:00:10+00:00] watchdog pinged', '[2026-10-17T00:00:10+00:00] Backup complete.']);
    log('offsite-copy.log', ['[2026-10-17T00:30:09+00:00] Off-site copy complete: 3 backup file(s) mirrored.', '[2026-10-17T00:30:10+00:00] watchdog pinged']);
    log('restore-test.log', [`[2026-10-17T01:00:20+00:00] fetched=${nightly} age_min=60`, '[2026-10-17T01:00:44+00:00] Restore test PASSED']);
    box.append(path.join(box.root, 'var/log/makrai/synthetic.log'), 'result=pass at=2026-10-17T07:07:04Z\n');
    box.setNow('2026-10-17T07:30:00Z');
    const next = box.run(['check-next']);
    expect(next.status, next.all).toBe(0);
    expect(next.last).toBe('CHECK-NEXT OK');
    const shred = box.run(['shred-prev']);
    expect(shred.status, shred.all).toBe(0);
    expect(shred.stdout).toContain('env_prev_files=0');
    expect(shred.last).toBe('SHRED-PREV OK');
    for (const f of [box.prevA, box.prevB, box.stagedProvision]) expect(existsSync(f), `${f} is gone`).toBe(false);
    expect(leaks(box, [...runs, check, early, refuse, next, shred])).toEqual([]);
    // After the shred no rollback exists: it says so, and .env is untouched.
    const env = box.readEnv();
    const late = box.run(['rollback-a', 'all']);
    expect(late.status).not.toBe(0);
    expect(late.stdout).toContain('no rollback exists: roll forward only');
    expect(box.readEnv()).toBe(env);
    const lateB = box.run(['rollback-b', 'line']);
    expect(lateB.status).not.toBe(0);
    expect(box.readEnv()).toBe(env);
  });

  it('prints OK or STOP as its last line in every subcommand, with a non-zero status exactly on STOP', () => {
    const oks = new Set<string>();
    const box = newBox({ admin: true });
    const note = (r: Run, sub: string): void => {
      if (r.status === 0) { expect(r.last, r.all).toBe(`${sub.toUpperCase()} OK`); oks.add(sub); }
      else expect(r.last, r.all).toMatch(new RegExp(`^${sub.toUpperCase()} STOP`));
    };
    note(box.run(['gate']), 'gate');
    note(box.run(['precheck']), 'precheck');
    note(box.run(['save-prev-a']), 'save-prev-a');
    note(box.run(['stage-a']), 'stage-a');
    note(box.run(['verify-a']), 'verify-a');
    note(box.run(['fix-owner']), 'fix-owner');
    note(box.run(['check-a']), 'check-a');
    box.setNow('2026-10-16T13:20:05Z');
    note(box.run(['admin-password']), 'admin-password');
    note(box.run(['save-prev-b']), 'save-prev-b');
    note(box.run(['escrow-check', 'pre'], { input: `${OLD.pass}\n` }), 'escrow-check');
    note(box.run(['stage-b']), 'stage-b');
    note(box.run(['backup-chain'], { input: `${box.envValue('BACKUP_PASSPHRASE')}\n` }), 'backup-chain');
    syntheticPassed(box, '2026-10-16T13:07:04Z');
    note(box.run(['check-b']), 'check-b');
    note(box.run(['rollback-b', 'line']), 'rollback-b');
    note(box.run(['rollback-a', 'DATABASE_URL']), 'rollback-a');
    box.setNow('2026-10-17T07:30:00Z');
    note(box.run(['check-next']), 'check-next');
    note(box.run(['shred-prev']), 'shred-prev');
    // Every subcommand also stops cleanly when it cannot start: the same box with its state removed.
    const bare = newBox();
    for (const sub of SUBCOMMANDS) {
      if (['gate', 'precheck', 'save-prev-a', 'verify-a', 'fix-owner', 'admin-password'].includes(sub)) continue;
      const args = sub === 'rollback-a' ? [sub, 'all'] : sub === 'rollback-b' ? [sub, 'line'] : sub === 'escrow-check' ? [sub, 'pre'] : [sub];
      const r = bare.run(args, { input: 'x\n' });
      expect(r.status, `${sub}: ${r.all}`).not.toBe(0);
      expect(r.last, sub).toMatch(new RegExp(`^${sub.toUpperCase()} STOP: .+`));
    }
    expect([...oks].sort()).toEqual(['admin-password', 'backup-chain', 'check-a', 'check-b', 'escrow-check', 'fix-owner', 'gate', 'precheck', 'rollback-a', 'rollback-b', 'save-prev-a', 'save-prev-b', 'stage-a', 'stage-b', 'verify-a'].sort());
  });
});

// ---------------------------------------------------------------------------------------------------------
// T24-C1..C4 and the verification's corrections, one behaviour at a time
// ---------------------------------------------------------------------------------------------------------

const hasPsql = (box: Box): boolean => box.argv().some((l) => l.startsWith('docker exec') && l.includes(' psql '));
const composeUps = (box: Box): number => box.recFile('compose-up').length;
const oldLine = (box: Box, key: string): string => `${key}=${box.envValue(key, box.prevA)}`;

describe('makrai-rotate-secrets.sh: no value is ever shown, logged or put in an argument list', () => {
  it('holds through every stage, with quoted and percent-encoded lines, a legacy URL and the admin password', () => {
    const box = newBox({ quotedApp: true, percentApp: true, legacy: true, admin: true });
    const runs: Run[] = [];
    runs.push(box.run(['precheck']));
    expect(runs[0].last, runs[0].all).toBe('PRECHECK OK');
    runs.push(...toChainDone(box));
    runs.push(box.run(['check-a']), box.run(['check-b']));
    box.setNow('2026-10-16T14:20:00Z');
    runs.push(box.run(['admin-password']));
    runs.push(box.run(['admin-password', 'rollback']));
    runs.push(box.run(['rollback-b', 'line']));
    // The rollback of the makrai_app line decodes the old, percent-encoded password; the whole-file one is refused now.
    runs.push(box.run(['rollback-a', 'APP_DATABASE_URL']));
    runs.push(box.run(['rollback-a', 'all']));
    expect(runs.at(-1)?.status).not.toBe(0);
    // Positive controls: the search could find a value, and the values did travel, by the routes meant for them.
    expect(box.generated().length).toBeGreaterThanOrEqual(5);
    expect(box.secrets()).toEqual(expect.arrayContaining([OLD.pgpw, OLD.pass, OLD.quotedPct, ...box.generated()]));
    const stdin = readdirSync(box.rec).filter((f) => f.startsWith('psql-stdin-')).map((f) => box.read(path.join(box.rec, f))).join('\n');
    const newPg = box.generated()[1];
    expect(stdin, 'the owner password went to psql on stdin').toContain(`\\set pw '${newPg}'`);
    expect(stdin, 'the percent-decoded old makrai_app password went to psql on stdin').toContain(`\\set pw '${OLD.quotedPct}'`);
    expect(box.argv().filter((l) => l.startsWith('gpg '))).not.toEqual([]);
    for (const l of box.argv().filter((x) => x.startsWith('gpg '))) {
      expect(l).toContain('--passphrase-fd 3');
      expect(l).toContain('--no-symkey-cache');
    }
    expect(leaks(box, runs)).toEqual([]);
    // The one command that carries .env's path is the owner's write; it carries no value.
    expect(box.argv().filter((l) => /^sudo .* sh -c cat > "\$1" sh /.test(l)).length).toBeGreaterThan(5);
  });

  it('redacts what Compose prints when it quotes a value in an error', () => {
    const box = newBox();
    box.run(['save-prev-a']);
    box.flag('fail-compose');
    box.flag('compose-echo');
    const r = box.run(['stage-a']);
    expect(r.status).not.toBe(0);
    expect(r.all).toContain('invalid interpolation near <redacted>');
    expect(leaks(box, [r])).toEqual([]);
    // The write itself reads the descriptor it pinned.
    expect(box.argv().some((l) => /^awk .* \/proc\/\d+\/fd\/8$/.test(l)), 'awk read the pinned descriptor').toBe(true);
  });

  it('holds when the steps fail', () => {
    const runs: Run[] = [];
    const cases: Array<[string, string]> = [['fail-alter-makrai', 'OWNER-ALTER FAILED'], ['fail-alter-makrai_app', 'APP-PROVISION FAILED'], ['fail-compose', 'OUTAGE']];
    for (const [flag, say] of cases) {
      const box = newBox();
      box.flag(flag);
      const { stage } = stageA(box);
      expect(stage.stdout).toContain(say);
      runs.push(stage);
      expect(leaks(box, [stage]), flag).toEqual([]);
    }
  });

  it('keeps nothing of .env in the environment of Compose, even when the shell exported the old values (T24-C1)', () => {
    const box = newBox();
    // As if root had sourced .env, or SETENV had exported it.
    const planted = { NEXTAUTH_SECRET: OLD.nextauth, POSTGRES_PASSWORD: OLD.pgpw, APP_DATABASE_URL: appUrl(OLD.apppw), BACKUP_PASSPHRASE: OLD.pass };
    const pre = box.run(['precheck'], { env: planted });
    expect(pre.stdout).toContain('info  inherited_env_keys_unset=4');
    const { stage } = stageA(box, planted);
    expect(stage.last, stage.all).toBe('STAGE-A OK');
    // Compose's own precedence would have put the old values back in the container.
    expect(box.container('docker-nextjs-1', 'NEXTAUTH_SECRET')).toBe(box.envValue('NEXTAUTH_SECRET'));
    expect(box.container('docker-nextjs-1', 'NEXTAUTH_SECRET')).not.toBe(OLD.nextauth);
    expect(box.container('docker-nextjs-1', 'APP_DATABASE_URL')).toBe(box.envValue('APP_DATABASE_URL'));
    const names = box.recFile('compose-env');
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => !['HOME', 'PATH', 'PWD', 'SHLVL', '_', 'OLDPWD'].includes(n)), 'the environment Compose was given').toEqual([]);
    expect(names).toContain('PATH');
    expect(box.recFile('compose-cwd').every((d) => d.endsWith('/srv/makrai/app/docker'))).toBe(true);
    expect(box.argv().filter((l) => l.startsWith('docker compose'))[0]).toBe('docker compose --env-file ../.env -f docker-compose.prod.yml up -d --no-deps --wait --wait-timeout 120 nextjs');
    expect(box.run(['check-a'], { env: planted }).last).toBe('CHECK-A OK');
  });

  it('refuses to run with xtrace on, before it reads or prints anything', () => {
    const box = newBox();
    const r = box.run(['stage-a'], { shellArgs: ['-x'] });
    expect(r.status).not.toBe(0);
    expect(r.all).not.toContain(OLD.pgpw);
    expect(box.argv().filter((l) => !l.startsWith('bash ')), 'nothing but the shell itself was started').toEqual([]);
    const viaEnv = box.run(['stage-a'], { env: { SHELLOPTS: 'xtrace' } });
    expect(viaEnv.status).not.toBe(0);
    expect(viaEnv.stdout).toContain('xtrace is on');
  });
});

describe('makrai-rotate-secrets.sh: writing .env', () => {
  it('gives the same file under mawk and gawk', () => {
    const results = (['mawk', 'gawk'] as const).map((awk) => {
      const box = newBox({ awk });
      const { stage } = stageA(box);
      expect(stage.last, `${awk}: ${stage.all}`).toBe('STAGE-A OK');
      return box.readEnv();
    });
    expect(results[0]).toBe(results[1]);
  });

  it('keeps the intended file, leaves .env as it was, and says how to finish when the write fails before it starts', () => {
    const box = newBox();
    box.run(['save-prev-a']);
    const before = box.readEnv();
    box.flag('sudo-fail');
    const r = box.run(['stage-a']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('env: WRITE FAILED');
    expect(r.last).toMatch(/^STAGE-A STOP/);
    expect(box.readEnv()).toBe(before);
    const kept = box.rhomeFiles().filter((f) => f.startsWith('.t24-env.'));
    expect(kept, 'the intended file is kept').toHaveLength(1);
    const intended = box.read(path.join(box.rhome, kept[0]));
    expect(intended.split('\n').filter((l) => /^NEXTAUTH_SECRET=[0-9a-f]{64}$/.test(l))).toHaveLength(1);
    expect(envMinus(intended, ['NEXTAUTH_SECRET'])).toEqual(envMinus(before, ['NEXTAUTH_SECRET']));
    // The printed recovery command is guarded: it needs a non-empty file and writes as the owner.
    const cmd = /env: free space, then: (.*)$/m.exec(r.stdout)?.[1] as string;
    expect(cmd).toMatch(/^test -s \S+ && sudo -u \S+ sh -c 'cat > "\$1"' sh \S+ < \S+ && shred -u \S+$/);
    box.flag('sudo-fail', false);
    expect(box.sh(cmd).status).toBe(0);
    expect(box.readEnv()).toBe(intended);
    expect(box.rhomeFiles().filter((f) => f.startsWith('.t24-env.'))).toEqual([]);
    expect(leaks(box, [r])).toEqual([]);
  });

  it('keeps the whole intended file when the disk fills part-way through the write', () => {
    const box = newBox();
    box.run(['save-prev-a']);
    const before = box.readEnv();
    box.flag('sudo-truncate');
    const r = box.run(['stage-a']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('env: WRITE FAILED');
    expect(box.readEnv(), '.env was truncated by the failed write').toBe('');
    const kept = box.rhomeFiles().filter((f) => f.startsWith('.t24-env.'));
    expect(kept).toHaveLength(1);
    const intended = box.read(path.join(box.rhome, kept[0]));
    expect(intended.length).toBeGreaterThan(before.length - 1);
    box.flag('sudo-truncate', false);
    const cmd = /env: free space, then: (.*)$/m.exec(r.stdout)?.[1] as string;
    expect(box.sh(cmd).status).toBe(0);
    expect(box.readEnv()).toBe(intended);
    // The root copy is the other way back, and is intact.
    expect(box.read(box.prevA)).toBe(before);
  });

  it('refuses a symlinked .env: nothing is written to, or through, it', () => {
    const box = newBox({ admin: true });
    box.run(['save-prev-a']);
    const other = path.join(box.dir, 'elsewhere.env');
    writeFileSync(other, box.readEnv());
    rmSync(box.envPath);
    symlinkSync(other, box.envPath);
    const before = box.read(other);
    for (const args of [['stage-a'], ['admin-password'], ['rollback-a', 'all'], ['rollback-a', 'DATABASE_URL'], ['save-prev-b'], ['precheck'], ['fix-owner']]) {
      const r = box.run(args);
      expect(r.status, args.join(' ')).not.toBe(0);
      expect(r.last).toMatch(/STOP/);
      expect(box.read(other), args.join(' ')).toBe(before);
    }
    expect(hasPsql(box), 'no database change was attempted').toBe(false);
  });

  it('refuses an env.prev copy that is missing, empty, a symlink, or not an .env, and never reads that as "the key is absent" (T24-V1, V2)', () => {
    const box = newBox();
    stageA(box);
    const afterA = box.readEnv();
    const copy = box.read(box.prevA);
    const keep = (): void => { writeFileSync(box.prevA, copy); chmodSync(box.prevA, 0o600); };
    const damage: Array<[string, () => void]> = [
      ['missing', () => rmSync(box.prevA)],
      ['empty', () => writeFileSync(box.prevA, '')],
      ['not an .env', () => writeFileSync(box.prevA, 'hello\n')],
      ['a symlink', () => { rmSync(box.prevA); symlinkSync(path.join(box.dir, 'rec/generated'), box.prevA); }],
    ];
    const ups = composeUps(box);
    for (const [what, doIt] of damage) {
      doIt();
      for (const key of ['all', 'NEXTAUTH_SECRET', 'POSTGRES_PASSWORD', 'APP_DATABASE_URL', 'DATABASE_URL']) {
        const r = box.run(['rollback-a', key]);
        expect(r.status, `${what} ${key}: ${r.all}`).not.toBe(0);
        expect(r.last).toMatch(/^ROLLBACK-A STOP/);
        expect(box.readEnv(), `${what} ${key}: .env must not change`).toBe(afterA);
      }
      rmSync(box.prevA, { force: true });
      keep();
    }
    expect(composeUps(box), 'nothing was restarted').toBe(ups);
    expect(box.db('makrai')).toBe(box.envValue('POSTGRES_PASSWORD'));
    // The message names the consequence once the copies are shredded.
    rmSync(box.prevA);
    expect(box.run(['rollback-a', 'all']).stdout).toContain('no rollback exists: roll forward only');
  });

  it('serialises the commands that change something', () => {
    const box = newBox();
    const lock = path.join(box.rhome, '.makrai-rotate.lock');
    const script = path.join(box.root, 'usr/local/sbin/makrai-rotate-secrets.sh');
    const held = spawnSync('flock', [lock, 'bash', script, 'save-prev-a'], { encoding: 'utf8', env: box.procEnv() });
    expect(held.status).not.toBe(0);
    expect(held.stdout).toContain('SAVE-PREV-A STOP: another makrai-rotate-secrets.sh command is running');
    expect(existsSync(box.prevA)).toBe(false);
    // The read-only checks do not take it.
    const ro = spawnSync('flock', [lock, 'bash', script, 'precheck'], { encoding: 'utf8', env: box.procEnv() });
    expect(ro.status, ro.stdout).toBe(0);
  });

  it('refuses every subcommand but the gate when it is not root', () => {
    const box = newBox();
    for (const sub of SUBCOMMANDS.filter((s) => s !== 'gate')) {
      const r = box.run([sub, ...(sub === 'rollback-a' ? ['all'] : sub === 'rollback-b' ? ['line'] : sub === 'escrow-check' ? ['pre'] : [])], { env: { STUB_UID: '1000' } });
      expect(r.status, sub).not.toBe(0);
      expect(r.last, sub).toBe(`${sub.toUpperCase()} STOP: this script runs as root`);
    }
    expect(box.argv().filter((l) => !l.startsWith('id ') && !l.startsWith('bash ')), 'nothing but the root check ran').toEqual([]);
  });
});

describe('makrai-rotate-secrets.sh: Stage A refuses what it could not undo', () => {
  const unchanged = (box: Box, before: string): void => {
    expect(box.readEnv()).toBe(before);
    expect(hasPsql(box)).toBe(false);
    expect(composeUps(box)).toBe(0);
    expect(box.stateGet('T0')).toBeUndefined();
    expect(box.generated()).toEqual([]);
  };

  it.each<[string, (b: Box) => void]>([
    ['a query string after the database', (b) => b.writeEnv(b.readEnv().replace(/^APP_DATABASE_URL=.*$/m, `APP_DATABASE_URL=${appUrl(OLD.apppw)}?sslmode=require`))],
    ['another database', (b) => b.writeEnv(b.readEnv().replace(/^APP_DATABASE_URL=.*$/m, `APP_DATABASE_URL=${appUrl(OLD.apppw, 'other')}`))],
    ['another host', (b) => b.writeEnv(b.readEnv().replace(/^APP_DATABASE_URL=.*$/m, `APP_DATABASE_URL=postgresql://makrai_app:${OLD.apppw}@db.internal:5432/makrai`))],
    ['another role', (b) => b.writeEnv(b.readEnv().replace(/^APP_DATABASE_URL=.*$/m, `APP_DATABASE_URL=postgresql://someone:${OLD.apppw}@postgres:5432/makrai`))],
    ['no password', (b) => b.writeEnv(b.readEnv().replace(/^APP_DATABASE_URL=.*$/m, 'APP_DATABASE_URL=postgresql://makrai_app:@postgres:5432/makrai'))],
    ['two lines', (b) => b.writeEnv(`${b.readEnv()}APP_DATABASE_URL=${appUrl(OLD.apppw)}\n`)],
    ['two NEXTAUTH_SECRET lines', (b) => b.writeEnv(`${b.readEnv()}NEXTAUTH_SECRET=${OLD.nextauth}\n`)],
    ['a POSTGRES_USER that is not a role name', (b) => b.writeEnv(b.readEnv().replace(/^POSTGRES_USER=.*$/m, 'POSTGRES_USER=Make;Role'))],
  ])('stops before it changes anything when APP_DATABASE_URL or a key has %s', (_name, mutate) => {
    const box = newBox();
    mutate(box);
    expect(box.run(['save-prev-a']).last).toBe('SAVE-PREV-A OK');
    const before = box.readEnv();
    const r = box.run(['stage-a']);
    expect(r.status, r.all).not.toBe(0);
    expect(r.last).toMatch(/^STAGE-A STOP: /);
    unchanged(box, before);
  });

  it.each<[string, (b: Box) => void, string]>([
    ['a DATABASE_URL for another role', (b) => b.writeEnv(b.readEnv().replace('DATABASE_URL=postgresql://makrai:', 'DATABASE_URL=postgresql://someone:')), 'legacy_url_user_is_owner=DIFFERENT'],
    ['a DATABASE_URL with another password', (b) => b.writeEnv(b.readEnv().replace(/^DATABASE_URL=postgresql:\/\/makrai:[0-9a-f]+@/m, `DATABASE_URL=postgresql://makrai:${hex('other')}@`)), 'legacy_pw_is_owner_pw=DIFFERENT'],
    ['two DATABASE_URL lines', (b) => b.writeEnv(`${b.readEnv()}DATABASE_URL=postgresql://makrai:${OLD.pgpw}@postgres:5432/makrai\n`), 'legacy_url_lines=2'],
    ['the web container holding a DATABASE_URL', (b) => b.append(path.join(b.world, 'containers/docker-nextjs-1.env'), 'DATABASE_URL=x\n'), 'legacy_url_in_web_container=1'],
    ['a compose file that interpolates it', (b) => b.append(path.join(b.app, 'docker/docker-compose.prod.yml'), '      LEGACY: ${DATABASE_URL}\n'), 'legacy_url_interpolated_by_compose=1'],
    ['a host script that reads it', (b) => writeFileSync(path.join(b.root, 'usr/local/bin/makrai-extra.sh'), '#!/usr/bin/env bash\necho "$DATABASE_URL"\n'), 'legacy_url_read_by_host_scripts=1'],
  ])('stops, naming why, when the legacy DATABASE_URL line cannot go: %s', (_name, mutate, want) => {
    const box = newBox({ legacy: true });
    mutate(box);
    expect(box.run(['save-prev-a']).last).toBe('SAVE-PREV-A OK');
    const before = box.readEnv();
    const r = box.run(['stage-a']);
    expect(r.status, r.all).not.toBe(0);
    expect(r.stdout).toContain(`FAIL  ${want}`);
    expect(r.last).toMatch(/^STAGE-A STOP: the legacy DATABASE_URL line may not be removed/);
    unchanged(box, before);
  });

  it('refuses when .env changed since env.prev-a, when env.prev-a is missing, and once it is complete', () => {
    const box = newBox();
    const noPrev = box.run(['stage-a']);
    expect(noPrev.last).toBe('STAGE-A STOP: no usable env.prev-a: run save-prev-a first');
    box.run(['save-prev-a']);
    box.writeEnv(`${box.readEnv()}EXTRA=1\n`);
    const stale = box.run(['stage-a']);
    expect(stale.last).toMatch(/^STAGE-A STOP: \.env differs from env\.prev-a/);
    expect(box.generated()).toEqual([]);
    const second = box.run(['save-prev-a']);
    expect(second.last, 'a stale copy is never overwritten').toMatch(/^SAVE-PREV-A STOP/);
    expect(second.stdout).toContain('PREV-STALE');
    // Complete: a second run must not rotate again.
    const fresh = newBox();
    stageA(fresh);
    const again = fresh.run(['stage-a']);
    expect(again.last).toBe('STAGE-A STOP: Stage A is already complete; run check-a');
    expect(fresh.generated()).toHaveLength(3);
  });

  it('keeps an env.prev-a that equals .env, and says so', () => {
    const box = newBox();
    box.run(['save-prev-a']);
    const second = box.run(['save-prev-a']);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('PREV-CURRENT');
    expect(box.mode(box.prevA)).toBe('600');
  });
});

describe('makrai-rotate-secrets.sh: Stage A stops at each step, and carries on from it (T24-V6)', () => {
  it('stops after a failed owner ALTER with the service untouched, and a second run finishes without new values', () => {
    const box = newBox();
    box.flag('fail-alter-makrai');
    const { stage } = stageA(box);
    expect(stage.status).not.toBe(0);
    expect(stage.stdout).toContain('OWNER-ALTER FAILED');
    expect(stage.stdout).toContain('STAGE A STOPPED at A2b');
    expect(stage.last).toMatch(/^STAGE-A STOP/);
    expect(composeUps(box), 'the container is not restarted').toBe(0);
    expect(box.container('docker-nextjs-1', 'NEXTAUTH_SECRET')).toBe(OLD.nextauth);
    expect(box.db('makrai'), 'the database still has the old owner password').toBe(OLD.pgpw);
    expect(box.envValue('POSTGRES_PASSWORD')).toBe(box.generated()[1]);
    expect(box.stateGet('A_STEP')).toBe('A2a');
    const nextauth = box.envValue('NEXTAUTH_SECRET');
    const pgpw = box.envValue('POSTGRES_PASSWORD');
    box.flag('fail-alter-makrai', false);
    const resumed = box.run(['stage-a']);
    expect(resumed.status, resumed.all).toBe(0);
    expect(resumed.last).toBe('STAGE-A OK');
    expect(box.envValue('NEXTAUTH_SECRET'), 'carried on, not regenerated').toBe(nextauth);
    expect(box.envValue('POSTGRES_PASSWORD')).toBe(pgpw);
    expect(box.generated()).toHaveLength(3);
    expect(box.db('makrai')).toBe(pgpw);
    expect(composeUps(box)).toBe(1);
    expect(box.run(['check-a']).last).toBe('CHECK-A OK');
    expect(leaks(box, [stage, resumed])).toEqual([]);
  });

  it('puts the old values back, key by key, after a failed owner ALTER, and then refuses to resume', () => {
    const box = newBox();
    const original = box.readEnv();
    box.flag('fail-alter-makrai');
    stageA(box);
    box.flag('fail-alter-makrai', false);
    const a = box.run(['rollback-a', 'POSTGRES_PASSWORD']);
    expect(a.last, a.all).toBe('ROLLBACK-A OK');
    expect(a.stdout).toContain('OWNER-ALTER OK');
    expect(box.envValue('POSTGRES_PASSWORD')).toBe(OLD.pgpw);
    expect(box.db('makrai')).toBe(OLD.pgpw);
    const b = box.run(['rollback-a', 'NEXTAUTH_SECRET']);
    expect(b.last, b.all).toBe('ROLLBACK-A OK');
    expect(box.readEnv(), 'every line is as it was').toBe(original);
    const resume = box.run(['stage-a']);
    expect(resume.last).toMatch(/^STAGE-A STOP: a partial rollback was done \(POSTGRES_PASSWORD,NEXTAUTH_SECRET\)/);
    const full = box.run(['rollback-a', 'all']);
    expect(full.last, full.all).toBe('ROLLBACK-A OK');
    expect(box.stateGet('A_ROLLBACK')).toBeUndefined();
    expect(box.stateGet('A_STEP')).toBeUndefined();
    const again = box.run(['stage-a']);
    expect(again.last, again.all).toBe('STAGE-A OK');
  });

  it('stops after a failed makrai_app provision with the old container still working, and can go forward or back', () => {
    const forward = newBox();
    forward.flag('fail-alter-makrai_app');
    const { stage } = stageA(forward);
    expect(stage.stdout).toContain('APP-PROVISION FAILED');
    expect(stage.stdout).toContain('STAGE A STOPPED at A4b');
    expect(composeUps(forward)).toBe(0);
    expect(forward.db('makrai_app')).toBe(OLD.apppw);
    expect(forward.container('docker-nextjs-1', 'APP_DATABASE_URL')).toContain(OLD.apppw);
    expect(forward.stateGet('A_STEP')).toBe('A4a');
    const url = forward.envValue('APP_DATABASE_URL');
    forward.flag('fail-alter-makrai_app', false);
    const resumed = forward.run(['stage-a']);
    expect(resumed.last, resumed.all).toBe('STAGE-A OK');
    expect(forward.envValue('APP_DATABASE_URL'), 'the URL written before the failure is the one provisioned').toBe(url);
    expect(forward.generated()).toHaveLength(3);

    const back = newBox();
    const original = back.readEnv();
    back.flag('fail-alter-makrai_app');
    stageA(back);
    back.flag('fail-alter-makrai_app', false);
    const r = back.run(['rollback-a', 'APP_DATABASE_URL']);
    expect(r.last, r.all).toBe('ROLLBACK-A OK');
    expect(back.envValue('APP_DATABASE_URL')).toBe(appUrl(OLD.apppw));
    expect(back.db('makrai_app')).toBe(OLD.apppw);
    expect(envMinus(back.readEnv(), ['NEXTAUTH_SECRET', 'POSTGRES_PASSWORD'])).toEqual(envMinus(original, ['NEXTAUTH_SECRET', 'POSTGRES_PASSWORD']));
  });

  it('ends an outage at the restart without waiting for the gate, and keeps the first T0', () => {
    const box = newBox();
    box.flag('fail-compose');
    const { stage } = stageA(box);
    expect(stage.stdout).toContain('OUTAGE');
    expect(stage.stdout).toContain('STAGE A STOPPED at A5');
    expect(box.stateGet('A_STEP')).toBe('A4b');
    const t0 = box.stateGet('T0');
    box.flag('fail-compose', false);
    box.setNow('2026-10-16T12:57:00Z');
    const resumed = box.run(['stage-a']);
    expect(resumed.status, resumed.all).toBe(0);
    expect(resumed.stdout).not.toContain('GATE');
    expect(resumed.stdout).toContain(`T0=${t0}`);
    expect(resumed.last).toBe('STAGE-A OK');
    expect(box.container('docker-nextjs-1', 'NEXTAUTH_SECRET')).toBe(box.envValue('NEXTAUTH_SECRET'));
    expect(box.run(['check-a']).last).toBe('CHECK-A OK');
  });

  it('goes back from an outage with the two per-key rollbacks, which restart nextjs on the old values', () => {
    const box = newBox();
    box.flag('fail-compose');
    stageA(box);
    box.flag('fail-compose', false);
    const a = box.run(['rollback-a', 'NEXTAUTH_SECRET']);
    expect(a.last, a.all).toBe('ROLLBACK-A OK');
    const b = box.run(['rollback-a', 'APP_DATABASE_URL']);
    expect(b.last, b.all).toBe('ROLLBACK-A OK');
    expect(box.db('makrai_app')).toBe(OLD.apppw);
    expect(box.container('docker-nextjs-1', 'APP_DATABASE_URL')).toBe(appUrl(OLD.apppw));
    expect(box.container('docker-nextjs-1', 'NEXTAUTH_SECRET')).toBe(OLD.nextauth);
    // POSTGRES_PASSWORD stays rotated: the precheck after it says DIFFERENT only with --post-rollback.
    expect(box.run(['precheck']).stdout).toContain('FAIL  postgres_vs_env_POSTGRES_PASSWORD=DIFFERENT');
    expect(box.run(['precheck', '--post-rollback']).last).toBe('PRECHECK OK');
  });

  it.each<[string, string, string]>([
    ['1', 'A1', 'NEXTAUTH_SECRET: no value generated; nothing written'],
    ['2', 'A2a', 'POSTGRES_PASSWORD: no value generated; nothing written'],
    ['3', 'A4a', 'APP-URL STOP: no value generated'],
  ])('refuses a value that is not 64 hex (openssl call %s), writes nothing for it, and the next run carries on', (call, step, message) => {
    const box = newBox();
    box.run(['save-prev-a']);
    box.setWorld('openssl-bad-at', `${call}\n`);
    const r = box.run(['stage-a']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain(message);
    expect(r.stdout).toContain(`STAGE A STOPPED at ${step}`);
    expect(box.readEnv()).not.toContain('not-hex');
    const generated = box.generated().length;
    const again = box.run(['stage-a']);
    expect(again.last, again.all).toBe('STAGE-A OK');
    expect(box.generated().length - generated, 'only the step that failed generated again').toBe(3 - Number(call) + 1);
    expect(box.run(['check-a']).last).toBe('CHECK-A OK');
  });

  it('can be run again after the gate refused it, and changed nothing when it refused', () => {
    const box = newBox();
    box.run(['save-prev-a']);
    const before = box.readEnv();
    box.setNow('2026-10-16T12:55:00Z');
    const refused = box.run(['stage-a']);
    expect(refused.stdout).toContain('GATE: start only between hh:15 and hh:50');
    expect(box.readEnv()).toBe(before);
    expect(box.stateGet('T0')).toBeUndefined();
    box.setNow('2026-10-16T13:15:00Z');
    expect(box.run(['stage-a']).last).toBe('STAGE-A OK');
  });

  it('refuses to carry on when .env no longer shows what the recorded steps did, and when a rollback key is unknown', () => {
    const box = newBox();
    box.flag('fail-alter-makrai');
    const { stage } = stageA(box);
    expect(stage.stdout).toContain('STAGE A STOPPED at A2b');
    // Someone puts the old NEXTAUTH_SECRET back by hand: the state file says A1 is done.
    box.writeEnv(box.readEnv().replace(/^NEXTAUTH_SECRET=.*$/m, `NEXTAUTH_SECRET=${OLD.nextauth}`));
    box.flag('fail-alter-makrai', false);
    const before = box.readEnv();
    const r = box.run(['stage-a']);
    expect(r.status).not.toBe(0);
    expect(r.last).toBe('STAGE-A STOP: the state file and .env disagree about what is done; nothing was changed. Use rollback-a all.');
    expect(box.readEnv()).toBe(before);
    expect(box.run(['rollback-a', 'nope']).last).toBe('ROLLBACK-A STOP: usage: rollback-a NEXTAUTH_SECRET|POSTGRES_PASSWORD|APP_DATABASE_URL|DATABASE_URL|all');
    expect(box.run(['rollback-a']).last).toMatch(/^ROLLBACK-A STOP: usage/);
  });

  it('removes a legacy DATABASE_URL line that names the owner with its password, and puts it back exactly', () => {
    const box = newBox({ legacy: true });
    const original = box.readEnv();
    const { stage } = stageA(box);
    expect(stage.last, stage.all).toBe('STAGE-A OK');
    expect(stage.stdout).not.toContain('no line, nothing to do');
    expect(box.readEnv()).not.toMatch(/^DATABASE_URL=/m);
    const check = box.run(['check-a']);
    expect(check.stdout).toContain('keydiff REMOVED DATABASE_URL');
    expect(check.stdout).toContain('ok    keydiff_names=APP_DATABASE_URL,DATABASE_URL,NEXTAUTH_SECRET,POSTGRES_PASSWORD');
    expect(check.last).toBe('CHECK-A OK');
    const r = box.run(['rollback-a', 'DATABASE_URL']);
    expect(r.last, r.all).toBe('ROLLBACK-A OK');
    expect(box.readEnv().split('\n').filter((l) => l.startsWith('DATABASE_URL='))).toEqual([original.split('\n').find((l) => l.startsWith('DATABASE_URL=')) as string]);
  });

  it('rewrites a quoted, percent-encoded APP_DATABASE_URL from known parts, and rolls it back to the exact quoted line (T24-C3)', () => {
    const box = newBox({ quotedApp: true, percentApp: true });
    const original = box.readEnv();
    expect(box.run(['precheck']).stdout).toContain('info  key_APP_DATABASE_URL_quoted=1');
    const { stage } = stageA(box);
    expect(stage.last, stage.all).toBe('STAGE-A OK');
    const line = box.readEnv().split('\n').find((l) => l.startsWith('APP_DATABASE_URL=')) as string;
    expect(line).toMatch(/^APP_DATABASE_URL=postgresql:\/\/makrai_app:[0-9a-f]{64}@postgres:5432\/makrai$/);
    expect(line, 'no quote survives into the new line').not.toMatch(/["']/);
    expect(box.db('makrai_app')).toBe(/makrai_app:([0-9a-f]{64})@/.exec(line)?.[1]);
    expect(box.run(['check-a']).last).toBe('CHECK-A OK');
    const key = box.run(['rollback-a', 'APP_DATABASE_URL']);
    expect(key.last, key.all).toBe('ROLLBACK-A OK');
    expect(box.envValue('APP_DATABASE_URL'), 'the exact old line, quotes and %-escapes kept').toBe(`"${appUrl('pa%40ss%25word')}"`);
    expect(box.db('makrai_app'), 'the old password, decoded as pg decodes it').toBe(OLD.quotedPct);
    const full = newBox({ quotedApp: true, percentApp: true, legacy: true, admin: true });
    const fullOriginal = full.readEnv();
    stageA(full);
    expect(full.run(['rollback-a', 'all']).last).toBe('ROLLBACK-A OK');
    expect(full.readEnv(), 'RA-full gives back every byte').toBe(fullOriginal);
    expect(full.db('makrai_app')).toBe(OLD.quotedPct);
    expect(full.db('makrai')).toBe(OLD.pgpw);
    expect(full.container('docker-nextjs-1', 'NEXTAUTH_SECRET')).toBe(OLD.nextauth);
    expect(original).toContain('"postgresql://makrai_app:pa%40ss%25word@');
  });

  it('gives back every byte, the database and the container with rollback-a all, and a second attempt then works', () => {
    const box = newBox({ legacy: true });
    const original = box.readEnv();
    stageA(box);
    expect(box.readEnv()).not.toBe(original);
    const ino = box.ino(box.envPath);
    const r = box.run(['rollback-a', 'all']);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain('RA env restored');
    expect(r.stdout).toContain('OWNER-ALTER OK');
    expect(r.stdout).toContain('APP-PROVISION OK');
    expect(r.last).toBe('ROLLBACK-A OK');
    expect(box.readEnv()).toBe(original);
    expect(box.ino(box.envPath), 'the same file, so its owner and mode are the same').toBe(ino);
    expect(box.mode(box.envPath)).toBe('600');
    expect(box.db('makrai')).toBe(OLD.pgpw);
    expect(box.db('makrai_app')).toBe(OLD.apppw);
    expect(box.container('docker-nextjs-1', 'APP_DATABASE_URL')).toBe(appUrl(OLD.apppw));
    expect(box.run(['precheck']).last, 'reads as before Stage A').toBe('PRECHECK OK');
    const second = box.run(['stage-a']);
    expect(second.last, second.all).toBe('STAGE-A OK');
    expect(leaks(box, [r, second])).toEqual([]);
  });

  it.each(['NEXTAUTH_SECRET', 'POSTGRES_PASSWORD', 'APP_DATABASE_URL', 'DATABASE_URL'])('puts back only %s, exactly, with its database effect', (key) => {
    const box = newBox({ legacy: true });
    stageA(box);
    const mid = box.readEnv();
    const r = box.run(['rollback-a', key]);
    expect(r.status, r.all).toBe(0);
    expect(r.last).toBe('ROLLBACK-A OK');
    const now = box.readEnv();
    expect(now.split('\n').find((l) => l.startsWith(`${key}=`))).toBe(oldLine(box, key));
    expect(envMinus(now, [key])).toEqual(envMinus(mid, [key]));
    if (key === 'POSTGRES_PASSWORD') expect(box.db('makrai')).toBe(OLD.pgpw);
    if (key === 'APP_DATABASE_URL') { expect(box.db('makrai_app')).toBe(OLD.apppw); expect(box.container('docker-nextjs-1', 'APP_DATABASE_URL')).toBe(appUrl(OLD.apppw)); }
    if (key === 'NEXTAUTH_SECRET') expect(box.container('docker-nextjs-1', 'NEXTAUTH_SECRET')).toBe(OLD.nextauth);
  });

  it('escapes an old owner password with a quote and a backslash for psql, and gives it back exactly', () => {
    const box = newBox();
    const odd = `ow'ner\\pw${hex('odd').slice(0, 8)}`;
    box.writeEnv(box.readEnv().replace(/^POSTGRES_PASSWORD=.*$/m, `POSTGRES_PASSWORD="${odd}"`));
    box.setWorld('db/makrai.pw', odd);
    const original = box.readEnv();
    stageA(box);
    expect(box.db('makrai')).toBe(box.envValue('POSTGRES_PASSWORD'));
    const r = box.run(['rollback-a', 'POSTGRES_PASSWORD']);
    expect(r.last, r.all).toBe('ROLLBACK-A OK');
    expect(box.db('makrai'), 'psql read the value back as it was').toBe(odd);
    expect(box.readEnv().split('\n').find((l) => l.startsWith('POSTGRES_PASSWORD='))).toBe(`POSTGRES_PASSWORD="${odd}"`);
    const stdin = readdirSync(box.rec).filter((f) => f.startsWith('psql-stdin-')).map((f) => box.read(path.join(box.rec, f))).join('\n');
    expect(stdin, 'the quote and the backslash are escaped for \\set').toContain(`\\set pw '${odd.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
    const full = newBox();
    full.writeEnv(full.readEnv().replace(/^POSTGRES_PASSWORD=.*$/m, `POSTGRES_PASSWORD="${odd}"`));
    full.setWorld('db/makrai.pw', odd);
    const fullOriginal = full.readEnv();
    stageA(full);
    expect(full.run(['rollback-a', 'all']).last).toBe('ROLLBACK-A OK');
    expect(full.readEnv()).toBe(fullOriginal);
    expect(full.db('makrai')).toBe(odd);
    expect(original).toBe(fullOriginal);
    expect(leaks(box, [r], [odd])).toEqual([]);
  });

  it('refuses the whole-file restore once Stage B has started, and leaves .env alone', () => {
    const box = newBox();
    toStageBWritten(box);
    const before = box.readEnv();
    const r = box.run(['rollback-a', 'all']);
    expect(r.status).not.toBe(0);
    expect(r.last).toBe('ROLLBACK-A STOP: Stage B has started (env.prev-b exists): a whole-file restore would undo it. Roll back key by key.');
    expect(box.readEnv()).toBe(before);
  });

  it('fix-owner makes the owner role equal to .env, and says so', () => {
    const box = newBox();
    stageA(box);
    box.setWorld('db/makrai.pw', 'drifted');
    const r = box.run(['fix-owner']);
    expect(r.last, r.all).toBe('FIX-OWNER OK');
    expect(box.db('makrai')).toBe(box.envValue('POSTGRES_PASSWORD'));
    box.setWorld('migrate-rc', '1\n');
    const v = box.run(['verify-a']);
    expect(v.status).not.toBe(0);
    expect(v.stdout).toContain('A6 migrate-status rc=1');
    expect(v.stdout).toContain('Run fix-owner, then verify-a');
  });
});

describe('makrai-rotate-secrets.sh: the escrow check', () => {
  /** A box at B0 with Stage A done. */
  function atB0(o: Parameters<typeof makeBox>[0] = {}): Box {
    const box = newBox(o);
    const { stage } = stageA(box);
    expect(stage.last, stage.all).toBe('STAGE-A OK');
    box.setNow('2026-10-16T13:20:05Z');
    expect(box.run(['save-prev-b']).last).toBe('SAVE-PREV-B OK');
    return box;
  }

  it('prints 1 for the value that opens the newest backup, records it, and never shows the value (T24-C4)', () => {
    const box = atB0();
    const r = box.run(['escrow-check', 'pre'], { input: `${OLD.pass}\n` });
    box.typed.push(OLD.pass);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain('escrow_decrypt=1');
    expect(r.last).toBe('ESCROW-CHECK OK');
    expect(r.all).not.toContain(OLD.pass);
    expect(r.stderr, 'the prompt names the file and says hidden').toContain('(hidden):');
    expect(box.stateGet('ESCROW_PRE')).toBe('makrai-20261016-000001.sql.gz.gpg');
    const gpg = box.argv().filter((l) => l.startsWith('gpg '));
    expect(gpg).toEqual([expect.stringMatching(/^gpg --batch --quiet --no-symkey-cache --decrypt --passphrase-fd 3 \S+makrai-20261016-000001\.sql\.gz\.gpg$/)]);
    expect(leaks(box, [r])).toEqual([]);
  });

  it('prints 0 and stops for a value that does not open it, for an empty entry, and for no input', () => {
    const box = atB0();
    for (const input of ['a-wrong-value\n', '\n', '']) {
      const r = box.run(['escrow-check', 'pre'], { input });
      box.typed.push('a-wrong-value');
      expect(r.status, JSON.stringify(input)).not.toBe(0);
      expect(r.stdout).toContain('escrow_decrypt=0');
      expect(r.last).toMatch(/^ESCROW-CHECK STOP: the typed value does not open makrai-20261016-000001\.sql\.gz\.gpg$/);
      expect(box.stateGet('ESCROW_PRE')).toBeUndefined();
    }
    expect(leaks(box, [])).toEqual([]);
  });

  it('reads one line, so a pasted second line is never run or used (T24-V3)', () => {
    const box = atB0();
    const marker = path.join(box.dir, 'ran-second-line');
    const r = box.run(['escrow-check', 'pre'], { input: `${OLD.pass}\ntouch ${marker}\n` });
    expect(r.last).toBe('ESCROW-CHECK OK');
    expect(existsSync(marker)).toBe(false);
    const wrong = box.run(['escrow-check', 'pre'], { input: `wrong\n${OLD.pass}\n` });
    expect(wrong.status, 'the second line is not tried either').not.toBe(0);
  });

  it('keeps leading and trailing spaces and backslashes in what is typed, as the backup script does', () => {
    const box = atB0();
    const odd = '  sp\\ace pass  ';
    box.addBackup('makrai-20261016-120000.sql.gz.gpg', odd, 0);
    // The newest file is now one made under that passphrase; B0 again records it as LASTOLD.
    expect(box.run(['save-prev-b']).stdout).toContain('LASTOLD=makrai-20261016-120000.sql.gz.gpg');
    const ok = box.run(['escrow-check', 'pre'], { input: `${odd}\n` });
    expect(ok.last, ok.all).toBe('ESCROW-CHECK OK');
    for (const wrong of ['sp\\ace pass', '  space pass  ', '  sp\\ace pass  x']) {
      const r = box.run(['escrow-check', 'pre'], { input: `${wrong}\n` });
      expect(r.status, wrong).not.toBe(0);
    }
  });

  it('proves a named backup (V4: the file the 00:00 run wrote), and refuses a name that is not a backup', () => {
    const box = atB0();
    const ok = box.run(['escrow-check', 'makrai-20261015-000001.sql.gz.gpg'], { input: `${OLD.pass}\n` });
    expect(ok.last, ok.all).toBe('ESCROW-CHECK OK');
    expect(box.stateGet('ESCROW_PRE'), 'a named file does not record the pre-rotation proof').toBeUndefined();
    for (const name of ['../../etc/passwd', 'makrai-evil.sql.gz.gpg', 'makrai-20261016-000001.sql.gz.gpg; touch x', 'nope']) {
      const r = box.run(['escrow-check', name], { input: 'x\n' });
      expect(r.status, name).not.toBe(0);
      expect(r.last, name).toMatch(/^ESCROW-CHECK STOP: (not a backup file in the backups directory|usage)/);
    }
  });

  it('is required, against the right file, before the passphrase is rotated', () => {
    const box = atB0();
    const before = box.readEnv();
    const generated = box.generated().length;
    const none = box.run(['stage-b']);
    expect(none.status).not.toBe(0);
    expect(none.last).toMatch(/^STAGE-B STOP: the pre-rotation escrow is not proven against makrai-20261016-000001\.sql\.gz\.gpg: run escrow-check pre/);
    box.run(['escrow-check', 'pre'], { input: 'wrong\n' });
    expect(box.run(['stage-b']).status).not.toBe(0);
    box.run(['escrow-check', 'pre'], { input: `${OLD.pass}\n` });
    // A backup that appears afterwards is not the file that was proven.
    box.addBackup('makrai-20261016-132100.sql.gz.gpg', OLD.pass, 0);
    const moved = box.run(['stage-b']);
    expect(moved.last).toMatch(/^STAGE-B STOP: a backup appeared since save-prev-b/);
    expect(box.readEnv()).toBe(before);
    expect(box.generated().length).toBe(generated);
    // Re-running B0 notices the new LASTOLD and drops the old proof.
    expect(box.run(['save-prev-b']).stdout).toContain('LASTOLD=makrai-20261016-132100.sql.gz.gpg');
    expect(box.stateGet('ESCROW_PRE')).toBeUndefined();
    expect(box.run(['stage-b']).last).toMatch(/^STAGE-B STOP: the pre-rotation escrow is not proven against makrai-20261016-132100/);
  });
});

describe('makrai-rotate-secrets.sh: the escrow check on the new file', () => {
  it('proves the new value against NEWBACKUP and records it, and stops for a value that does not open it', () => {
    const box = newBox();
    toChainDone(box);
    const pass = box.envValue('BACKUP_PASSPHRASE') as string;
    box.typed.push(pass);
    // The chain recorded the proof when it ran; take it away, so that this run is what records it.
    writeFileSync(box.state, box.stateText().replace(/^ESCROW_NEW=.*\n/m, ''));
    expect(box.stateGet('ESCROW_NEW')).toBeUndefined();
    const ok = box.run(['escrow-check', 'new'], { input: `${pass}\n` });
    expect(ok.last, ok.all).toBe('ESCROW-CHECK OK');
    expect(ok.stdout).toContain('escrow_decrypt=1');
    expect(ok.all).not.toContain(pass);
    expect(box.stateGet('ESCROW_NEW')).toBe(box.stateGet('NEWBACKUP'));
    const wrong = box.run(['escrow-check', 'new'], { input: `${OLD.pass}\n` });
    expect(wrong.status).not.toBe(0);
    expect(wrong.stdout).toContain('escrow_decrypt=0');
    expect(box.run(['escrow-check', 'nope'], { input: 'x\n' }).last).toBe('ESCROW-CHECK STOP: usage: escrow-check pre|new|<backup file name>');
    expect(leaks(box, [ok, wrong])).toEqual([]);
  });
});

describe('makrai-rotate-secrets.sh: Stage B', () => {
  it('refuses to start before Stage A is complete, or when .env moved since B0', () => {
    const box = newBox();
    expect(box.run(['save-prev-b']).last).toBe('SAVE-PREV-B STOP: Stage A is not complete (stage-a, then check-a)');
    expect(box.run(['stage-b']).last).toBe('STAGE-B STOP: Stage A is not complete');
    expect(existsSync(box.prevB)).toBe(false);
    const ready = newBox();
    stageA(ready);
    ready.setNow('2026-10-16T13:20:05Z');
    ready.run(['save-prev-b']);
    ready.run(['escrow-check', 'pre'], { input: `${OLD.pass}\n` });
    ready.writeEnv(`${ready.readEnv()}EXTRA=1\n`);
    const before = ready.readEnv();
    const r = ready.run(['stage-b']);
    expect(r.last).toBe('STAGE-B STOP: .env differs from env.prev-b: someone wrote .env since B0. Stop and ask.');
    expect(ready.readEnv()).toBe(before);
    const again = ready.run(['save-prev-b']);
    expect(again.last).toMatch(/^SAVE-PREV-B STOP/);
    expect(again.stdout).toContain('PREV-STALE');
  });

  it('does not name a cut-over from a hand-named newest backup', () => {
    const box = newBox();
    stageA(box);
    box.setNow('2026-10-16T13:20:05Z');
    box.addBackup('makrai-manual.sql.gz.gpg', OLD.pass, 0);
    const r = box.run(['save-prev-b']);
    expect(r.status).not.toBe(0);
    expect(r.last).toBe('SAVE-PREV-B STOP: the newest backup does not have the nightly name form; the cut-over cannot be named');
  });

  it('writes 64 hex from openssl, to BACKUP_PASSPHRASE only, and a second run does not rotate again (T24-C4)', () => {
    const box = newBox();
    const runs = toStageBWritten(box);
    const stageB = runs.at(-1) as Run;
    const pass = box.envValue('BACKUP_PASSPHRASE') as string;
    expect(pass).toMatch(/^[0-9a-f]{64}$/);
    expect(pass).toBe(box.generated().at(-1));
    expect(box.argv().filter((l) => l.startsWith('openssl '))).toEqual(Array(4).fill('openssl rand -hex 32'));
    expect(stageB.stdout).toContain('TB=2026-10-16T13:20:05Z');
    expect(stageB.stdout).toContain('B2 shape=1');
    expect(stageB.stdout).toContain('OPERATOR-LOAD-ENV OK');
    expect(stageB.all).not.toContain(pass);
    const afterA = box.read(box.prevB);
    expect(envMinus(box.readEnv(), ['BACKUP_PASSPHRASE'])).toEqual(envMinus(afterA, ['BACKUP_PASSPHRASE']));
    expect(box.stateGet('B_STEP')).toBe('B2');
    expect(box.run(['stage-b']).last).toBe('STAGE-B STOP: Stage B is already written; run backup-chain');
    expect(box.envValue('BACKUP_PASSPHRASE')).toBe(pass);
    expect(leaks(box, runs)).toEqual([]);
  });

  it('stops, writing nothing, when openssl gives anything but 64 hex', () => {
    const box = newBox();
    stageA(box);
    box.setNow('2026-10-16T13:20:05Z');
    box.run(['save-prev-b']);
    box.run(['escrow-check', 'pre'], { input: `${OLD.pass}\n` });
    const before = box.readEnv();
    box.flag('openssl-bad');
    const r = box.run(['stage-b']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('BACKUP_PASSPHRASE: no value generated; nothing written');
    expect(box.readEnv()).toBe(before);
    expect(box.stateGet('B_STEP')).toBeUndefined();
  });

  it('stops and points at the rollback when the operator jobs cannot source the file afterwards', () => {
    const box = newBox();
    stageA(box);
    box.writeEnv(`${box.readEnv()}NOT A VALID LINE\n`);
    box.setNow('2026-10-16T13:20:05Z');
    box.run(['save-prev-b']);
    box.run(['escrow-check', 'pre'], { input: `${OLD.pass}\n` });
    const r = box.run(['stage-b']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('OPERATOR-LOAD-ENV FAILED');
    expect(r.last).toBe('STAGE-B STOP: the operator jobs cannot source .env: rollback-b line');
    expect(r.all, 'sourcing errors can quote a value, so none is shown').not.toContain('NOT A VALID');
  });
});

describe('makrai-rotate-secrets.sh: the backup chain', () => {
  const chainBox = (): { box: Box; pass: string } => {
    const box = newBox();
    toStageBWritten(box);
    return { box, pass: box.envValue('BACKUP_PASSPHRASE') as string };
  };

  it('waits 130 seconds and checks nothing is under 2 minutes old before the copy (T24-C2)', () => {
    const { box, pass } = chainBox();
    const r = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(r.last, r.all).toBe('BACKUP-CHAIN OK');
    expect(box.recFile('sleep')).toContain('130');
    // Without the aging a 130 s sleep gives, the fresh file would be skipped by the copy: the chain stops first.
    const fresh = chainBox();
    fresh.box.flag('no-aging');
    const s = fresh.box.run(['backup-chain'], { input: `${fresh.pass}\n` });
    expect(s.status).not.toBe(0);
    expect(s.last).toMatch(/^BACKUP-CHAIN STOP: B6: 1 backup file\(s\) are still under 2 minutes old$/);
    expect(fresh.box.argv().some((l) => l.endsWith('makrai-offsite-copy.sh')), 'the copy never ran').toBe(false);
  });

  it('stops if the hand backup fails, with .env holding the new value, and runs nothing after it', () => {
    const { box, pass } = chainBox();
    box.flag('backup-fail');
    const r = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(r.status).not.toBe(0);
    expect(r.last).toBe('BACKUP-CHAIN STOP: B4 failed');
    expect(r.stdout).toContain('rollback-b line');
    expect(box.stateGet('NEWBACKUP')).toBeUndefined();
    expect(box.argv().filter((l) => l.endsWith('makrai-offsite-copy.sh') || l.endsWith('makrai-restore-test.sh'))).toEqual([]);
    box.flag('backup-fail', false);
    expect(box.run(['backup-chain'], { input: `${pass}\n` }).last).toBe('BACKUP-CHAIN OK');
  });

  it('stops when the new file is not named after the cut-over, or its log does not end as a finished run', () => {
    const old = chainBox();
    old.box.flag('backup-old-name');
    old.box.addBackup('makrai-20261010-000001.sql.gz.gpg', OLD.pass, 5000);
    const o = old.box.run(['backup-chain'], { input: `${old.pass}\n` });
    expect(o.status).not.toBe(0);
    expect(o.last).toMatch(/^BACKUP-CHAIN STOP: B4: the newest file \(makrai-\d{8}-\d{6}\.sql\.gz\.gpg\) is not named after makrai-20261016-000001\.sql\.gz\.gpg$/);
    expect(old.box.stateGet('NEWBACKUP')).toBeUndefined();
    const cut = chainBox();
    cut.box.flag('backup-truncated-log');
    const c = cut.box.run(['backup-chain'], { input: `${cut.pass}\n` });
    expect(c.status).not.toBe(0);
    expect(c.last).toBe('BACKUP-CHAIN STOP: B4: the backup log does not end with Backup complete.');
    expect(cut.box.argv().some((l) => l.endsWith('makrai-offsite-copy.sh'))).toBe(false);
  });

  it('accepts a backup whose only fault is the watchdog ping, and says so', () => {
    const { box, pass } = chainBox();
    box.flag('backup-pingfail');
    const r = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(r.last, r.all).toBe('BACKUP-CHAIN OK');
    expect(r.stdout).toContain('B4 OK (the backup is fine, only its watchdog ping failed: tell the agent)');
  });

  it('stops at an escrow that does not open the new backup, before anything leaves the server, and resumes there', () => {
    const { box, pass } = chainBox();
    const r = box.run(['backup-chain'], { input: 'not-the-new-value\n' });
    box.typed.push('not-the-new-value');
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('B5 escrow_decrypt=0');
    expect(r.stdout).toContain('nothing has left the server');
    expect(r.last).toBe('BACKUP-CHAIN STOP: B5 escrow not proven');
    expect(box.argv().filter((l) => l.endsWith('makrai-offsite-copy.sh') || l.endsWith('makrai-restore-test.sh'))).toEqual([]);
    expect(box.recFile('sleep'), 'it did not even wait').toEqual([]);
    expect(box.stateGet('ESCROW_NEW')).toBeUndefined();
    const again = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(again.last, again.all).toBe('BACKUP-CHAIN OK');
    expect(again.stdout).toContain('resuming; the hand backup is not repeated');
    expect(box.argv().filter((l) => l.startsWith('sudo -u ') && l.endsWith('makrai-backup.sh')), 'one hand backup in all').toHaveLength(1);
    expect(leaks(box, [r, again])).toEqual([]);
  });

  it('stops at a failed off-site copy without running the restore test, and carries on when it is run again', () => {
    const { box, pass } = chainBox();
    box.flag('offsite-fail');
    const r = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('B7 rc=1');
    expect(r.stdout).toContain('B8 is not run');
    expect(r.last).toBe('BACKUP-CHAIN STOP: B7 failed');
    expect(box.argv().some((l) => l.endsWith('makrai-restore-test.sh'))).toBe(false);
    box.flag('offsite-fail', false);
    const again = box.run(['backup-chain']);
    expect(again.last, again.all).toBe('BACKUP-CHAIN OK');
    expect(again.stdout, 'the escrow is not asked for twice').not.toContain('escrow_decrypt');
    // A retry leaves a FAILED line after TB. The final state decides (T24-V12).
    syntheticPassed(box, '2026-10-16T13:07:04Z');
    const check = box.run(['check-b']);
    expect(check.last, check.all).toBe('CHECK-B OK');
    expect(check.stdout).toMatch(/info {2}offsite_failed_since_TB=1 /);
  });

  it.each<[string, string]>([
    ['offsite-pingfail', 'a watchdog ping that failed'],
    ['offsite-skip-line', 'the new file named as skipped'],
  ])('does not take %s (%s) for a copy of the new file', (flag) => {
    const { box, pass } = chainBox();
    box.flag(flag);
    const r = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(r.status).not.toBe(0);
    expect(r.last).toBe('BACKUP-CHAIN STOP: B7 failed');
    expect(box.argv().some((l) => l.endsWith('makrai-restore-test.sh'))).toBe(false);
  });

  it('checks that the new file reached the box, whatever the copy\'s log says (T24-C2)', () => {
    const { box, pass } = chainBox();
    box.flag('offsite-lie');
    const r = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('B7 box_has_new=no');
    expect(r.last).toBe('BACKUP-CHAIN STOP: B7 failed');
    expect(box.argv().some((l) => l.endsWith('makrai-restore-test.sh')), 'the restore test never ran').toBe(false);
    const unlisted = chainBox();
    unlisted.box.flag('box-unreachable');
    const u = unlisted.box.run(['backup-chain'], { input: `${unlisted.pass}\n` });
    expect(u.stdout).toContain('B7 box_has_new=unknown');
    expect(u.status).not.toBe(0);
  });

  it('checks that the restore test fetched the new file itself, whatever else it printed (T24-C2)', () => {
    const { box, pass } = chainBox();
    // A restore test that fetches the old file and reports a match for it.
    box.flag('restore-fetch-other');
    box.flag('restore-ignore-pass');
    const r = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(r.stdout).toContain('B7 box_has_new=yes');
    expect(r.stdout).toContain('B8 result=RESTORE MATCH rc=0');
    expect(r.stdout).toContain('B8 FETCHED-OTHER');
    expect(r.status).not.toBe(0);
    expect(r.last).toBe('BACKUP-CHAIN STOP: B8 failed (no field)');
    expect(r.stdout).toContain('wait 2 minutes, then run backup-chain again (B7, then B8)');
    expect(box.stateGet('B_DONE')).toBeUndefined();
    expect(box.stateGet('CHAIN_HOLD'), 'not held: the box simply does not have the new file as its newest').toBeUndefined();
  });

  it('tells a failed fetch (retry), a restore that failed on the new file (hold), and a changed database (fresh) apart (T24-V14)', () => {
    const fetchBox = chainBox();
    fetchBox.box.setWorld('restore-field', 'fetch');
    const f = fetchBox.box.run(['backup-chain'], { input: `${fetchBox.pass}\n` });
    expect(f.stdout).toContain('wait 2 minutes, then run backup-chain again (B7, then B8)');
    expect(fetchBox.box.stateGet('CHAIN_HOLD')).toBeUndefined();
    fetchBox.box.flag('restore-field', false);
    expect(fetchBox.box.run(['backup-chain']).last).toBe('BACKUP-CHAIN OK');

    for (const field of ['restore', 'cluster', 'roles']) {
      const { box, pass } = chainBox();
      box.setWorld('restore-field', field);
      const r = box.run(['backup-chain'], { input: `${pass}\n` });
      expect(r.status, field).not.toBe(0);
      expect(r.stdout).toContain('No retry: the agent reads the tail of restore-test.log');
      expect(r.last).toBe(`BACKUP-CHAIN STOP: B8 failed (${field})`);
      expect(box.stateGet('CHAIN_HOLD')).toBe(field);
      const held = box.run(['backup-chain']);
      expect(held.last, 'a held chain does not retry').toMatch(/^BACKUP-CHAIN STOP: held after a restore failure/);
      expect(box.argv().filter((l) => l.startsWith('sudo -u ') && l.endsWith('makrai-restore-test.sh'))).toHaveLength(1);
      box.flag('restore-field', false);
      expect(box.run(['backup-chain', '--release-hold']).last).toBe('BACKUP-CHAIN OK');
      expect(box.run(['backup-chain']).last).toBe('BACKUP-CHAIN OK');
    }

    const live = chainBox();
    live.box.setWorld('restore-field', 'policies');
    const p = live.box.run(['backup-chain'], { input: `${live.pass}\n` });
    expect(p.stdout).toContain('run backup-chain --fresh (B4 to B8 again) and report');
    expect(live.box.stateGet('CHAIN_HOLD')).toBeUndefined();
    live.box.flag('restore-field', false);
    live.box.setNow('2026-10-16T13:40:00Z');
    const fresh = live.box.run(['backup-chain', '--fresh'], { input: `${live.pass}\n` });
    expect(fresh.last, fresh.all).toBe('BACKUP-CHAIN OK');
    expect(live.box.argv().filter((l) => l.startsWith('sudo -u ') && l.endsWith('makrai-backup.sh')), 'a second hand backup').toHaveLength(2);
  });

  it('stops on a restore container left behind', () => {
    const { box, pass } = chainBox();
    box.setWorld('restore-containers', 'abc123\n');
    const r = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('B8 FETCHED-NEW');
    expect(r.last).toMatch(/^BACKUP-CHAIN STOP: B8 failed/);
  });

  it('is not started without Stage B, and a Stage B left half-done is not chained', () => {
    const box = newBox();
    expect(box.run(['backup-chain']).last).toBe('BACKUP-CHAIN STOP: Stage B is not written (stage-b)');
    const usage = chainBox();
    expect(usage.box.run(['backup-chain', '--nope']).last).toBe('BACKUP-CHAIN STOP: usage: backup-chain [--fresh|--release-hold]');
  });
});

describe('makrai-rotate-secrets.sh: rolling back Stage B', () => {
  it('puts the passphrase line back exactly (RB-line), and Stage B can then be started again', () => {
    const box = newBox();
    toStageBWritten(box);
    const prev = oldLine(box, 'BACKUP_PASSPHRASE').replace(/env\.prev-a/, '');
    const original = box.read(box.prevB);
    const r = box.run(['rollback-b', 'line']);
    expect(r.status, r.all).toBe(0);
    expect(r.last).toBe('ROLLBACK-B OK');
    expect(r.stdout).toContain('RB-line OK');
    expect(box.readEnv()).toBe(original);
    expect(box.readEnv()).toContain(`BACKUP_PASSPHRASE=${OLD.pass}`);
    expect(prev.length).toBeGreaterThan(0);
    expect(box.stateGet('B_STEP')).toBeUndefined();
    expect(box.run(['stage-b']).last).toBe('STAGE-B OK');
  });

  it('removes only the new local file (RB-local) when the escrow could not be proven, and names what to do with the manager entries', () => {
    const box = newBox();
    toStageBWritten(box);
    const first = box.run(['backup-chain'], { input: 'wrong\n' });
    expect(first.last).toBe('BACKUP-CHAIN STOP: B5 escrow not proven');
    const newFile = path.join(box.backups, box.stateGet('NEWBACKUP') as string);
    expect(existsSync(newFile)).toBe(true);
    const r = box.run(['rollback-b', 'local']);
    expect(r.status, r.all).toBe(0);
    expect(existsSync(newFile)).toBe(false);
    expect(r.stdout).toContain('newest_backup=makrai-20261016-000001.sql.gz.gpg');
    expect(r.stdout).toContain('delete the new entry and give the old one back its label');
    expect(r.last).toBe('ROLLBACK-B OK');
    expect(box.readEnv()).toContain(`BACKUP_PASSPHRASE=${OLD.pass}`);
    expect(box.stateGet('NEWBACKUP')).toBeUndefined();
    expect(existsSync(path.join(box.backups, 'makrai-20261015-000001.sql.gz.gpg'))).toBe(true);
  });

  it('has nothing to remove for RB-local before the hand backup exists', () => {
    const box = newBox();
    toStageBWritten(box);
    const r = box.run(['rollback-b', 'local']);
    expect(r.status).not.toBe(0);
    expect(r.last).toBe('ROLLBACK-B STOP: there is no NEWBACKUP to remove');
    expect(box.envValue('BACKUP_PASSPHRASE')).toMatch(/^[0-9a-f]{64}$/);
    expect(box.run(['rollback-b', 'nope']).last).toBe('ROLLBACK-B STOP: usage: rollback-b line|local');
  });

  it('refuses RB-local once the new file is on the box, or when the box cannot be listed, and keeps the file', () => {
    const done = newBox();
    toChainDone(done);
    const newName = done.stateGet('NEWBACKUP') as string;
    done.setNow('2026-10-16T14:20:00Z');
    const before = done.readEnv();
    const onBox = done.run(['rollback-b', 'local']);
    expect(onBox.status).not.toBe(0);
    expect(onBox.last).toMatch(/^ROLLBACK-B STOP: makrai-20261016-132005\.sql\.gz\.gpg is on the box: roll forward only/);
    expect(existsSync(path.join(done.backups, newName))).toBe(true);
    expect(done.readEnv()).toBe(before);

    const stuck = newBox();
    toStageBWritten(stuck);
    stuck.run(['backup-chain'], { input: 'wrong\n' });
    stuck.flag('box-unreachable');
    const r = stuck.run(['rollback-b', 'local']);
    expect(r.status).not.toBe(0);
    expect(r.last).toMatch(/^ROLLBACK-B STOP: cannot list the box/);
    expect(existsSync(path.join(stuck.backups, stuck.stateGet('NEWBACKUP') as string))).toBe(true);
    expect(stuck.readEnv()).toContain(`BACKUP_PASSPHRASE=${stuck.envValue('BACKUP_PASSPHRASE')}`);
  });

  it('refuses once a backup named after NEWBACKUP exists: 00:00 has run under the new value (T24-V4)', () => {
    const box = newBox();
    toChainDone(box);
    box.addBackup('makrai-20261017-000001.sql.gz.gpg', box.envValue('BACKUP_PASSPHRASE') as string, 0);
    box.setNow('2026-10-17T07:30:00Z');
    const before = box.readEnv();
    for (const mode of ['line', 'local']) {
      const r = box.run(['rollback-b', mode]);
      expect(r.status, mode).not.toBe(0);
      expect(r.stdout).toContain('00:00 has run with the new value in .env');
      expect(r.last).toBe('ROLLBACK-B STOP: rolled forward only');
      expect(box.readEnv()).toBe(before);
    }
  });

  it('is gated: it does not run in the hours the nightly chain owns (T24-V4)', () => {
    const box = newBox();
    toStageBWritten(box);
    box.setNow('2026-10-16T23:30:00Z');
    const r = box.run(['rollback-b', 'line']);
    expect(r.stdout).toContain('GATE: not in the hours');
    expect(r.status).not.toBe(0);
    expect(box.readEnv()).toContain(`BACKUP_PASSPHRASE=${box.envValue('BACKUP_PASSPHRASE')}`);
  });

  it('never deletes the passphrase when env.prev-b is missing or unusable (T24-V1), and does not remove the file if .env cannot be sourced (T24-V7)', () => {
    const box = newBox();
    toStageBWritten(box);
    const before = box.readEnv();
    const copy = box.read(box.prevB);
    rmSync(box.prevB);
    for (const mode of ['line', 'local']) {
      const r = box.run(['rollback-b', mode]);
      expect(r.status, mode).not.toBe(0);
      expect(r.last).toMatch(/^ROLLBACK-B STOP: no usable .*env\.prev-b\. After the env\.prev copies are shredded no rollback exists: roll forward only\.$/);
      expect(box.readEnv(), 'the live passphrase line is still there').toBe(before);
      expect(box.envValue('BACKUP_PASSPHRASE')).toMatch(/^[0-9a-f]{64}$/);
    }
    writeFileSync(box.prevB, copy);
    chmodSync(box.prevB, 0o600);
    // RB-local, with an .env the operator's jobs cannot source: the chain stops before it removes the file.
    box.run(['backup-chain'], { input: 'wrong\n' });
    const file = path.join(box.backups, box.stateGet('NEWBACKUP') as string);
    // An old passphrase the operator's jobs could not source: restoring its line breaks .env.
    writeFileSync(box.prevB, box.read(box.prevB).replace(/^BACKUP_PASSPHRASE=.*$/m, 'BACKUP_PASSPHRASE=has space here'));
    const r = box.run(['rollback-b', 'local']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('OPERATOR-LOAD-ENV FAILED');
    expect(r.last).toBe('ROLLBACK-B STOP: the operator jobs cannot source .env after the restore');
    expect(existsSync(file), 'the new file is still there').toBe(true);
  });
});

describe('makrai-rotate-secrets.sh: the optional admin password', () => {
  it('rotates ADMIN_PASSWORD with its own root copy, and its own rollback gives back every byte', () => {
    const box = newBox({ admin: true });
    const original = box.readEnv();
    const r = box.run(['admin-password']);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain('A7 OK');
    expect(r.last).toBe('ADMIN-PASSWORD OK');
    expect(box.envValue('ADMIN_PASSWORD')).toMatch(/^[0-9a-f]{64}$/);
    expect(envMinus(box.readEnv(), ['ADMIN_PASSWORD'])).toEqual(envMinus(original, ['ADMIN_PASSWORD']));
    expect(box.mode(box.prevAdmin)).toBe('600');
    expect(box.stateGet('ADMIN_ROTATED')).toBe('1');
    const again = box.run(['admin-password']);
    expect(again.status, 'a second rotation would overwrite the only copy of the old value').not.toBe(0);
    expect(again.stdout).toContain('PREV-STALE');
    const back = box.run(['admin-password', 'rollback']);
    expect(back.last, back.all).toBe('ADMIN-PASSWORD OK');
    expect(back.stdout).toContain('RA-admin OK');
    expect(box.readEnv()).toBe(original);
    expect(box.stateGet('ADMIN_ROTATED')).toBeUndefined();
    expect(leaks(box, [r, again, back])).toEqual([]);
  });

  it('appends the line when there was none, and the rollback removes it again', () => {
    const box = newBox();
    const original = box.readEnv();
    expect(box.run(['admin-password']).last).toBe('ADMIN-PASSWORD OK');
    expect(box.readEnv().split('\n').filter((l) => l.startsWith('ADMIN_PASSWORD='))).toHaveLength(1);
    expect(box.run(['admin-password', 'rollback']).last).toBe('ADMIN-PASSWORD OK');
    expect(box.readEnv()).toBe(original);
  });

  it('is allowed in check-a and check-b as the one extra changed key, and nowhere else', () => {
    const box = newBox({ admin: true });
    stageA(box);
    box.setNow('2026-10-16T13:20:05Z');
    expect(box.run(['admin-password']).last).toBe('ADMIN-PASSWORD OK');
    const check = box.run(['check-a']);
    expect(check.last, check.all).toBe('CHECK-A OK');
    expect(check.stdout).toContain('keydiff CHANGED ADMIN_PASSWORD');
    box.writeEnv(box.readEnv().replace(/^RESEND_API_KEY=.*$/m, 'RESEND_API_KEY=re_changed'));
    const bad = box.run(['check-a']);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toContain('FAIL  keydiff_names=');
  });

  it('is gated, and refuses a usage error', () => {
    const box = newBox();
    expect(box.run(['admin-password', 'nope']).last).toBe('ADMIN-PASSWORD STOP: usage: admin-password [rotate|rollback]');
    box.run(['admin-password']);
    rmSync(box.prevAdmin);
    const r = box.run(['admin-password', 'rollback']);
    expect(r.status).not.toBe(0);
    expect(r.last).toMatch(/^ADMIN-PASSWORD STOP: the line was not restored/);
    expect(box.envValue('ADMIN_PASSWORD')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('makrai-rotate-secrets.sh: the post-checks fail loudly (T24-V5, V7, V9, V11, V12)', () => {
  const afterA = (o: Parameters<typeof makeBox>[0] = {}): Box => {
    const box = newBox(o);
    expect(stageA(box).stage.last).toBe('STAGE-A OK');
    return box;
  };

  it('stops, with a FAIL line and a non-zero status, for each way Stage A can be wrong', () => {
    const cases: Array<[string, (b: Box) => void, string]> = [
      ['the container was not recreated', (b) => b.setWorld('containers/docker-nextjs-1.env', `NEXTAUTH_SECRET=${OLD.nextauth}\nAPP_DATABASE_URL=${appUrl(OLD.apppw)}\nIDENTITY_DATABASE_URL=postgresql://makrai_identity:${OLD.identity}@postgres:5432/makrai\n`), 'FAIL  nextjs_NEXTAUTH_SECRET_vs_env=DIFFERENT'],
      ['the old owner password is still accepted', (b) => b.setWorld('db/makrai.pw', OLD.pgpw), 'FAIL  tcp_owner_prev_a=ACCEPTED'],
      ['the old makrai_app password is still accepted', (b) => b.setWorld('db/makrai_app.pw', OLD.apppw), 'FAIL  tcp_makrai_app_prev_a=ACCEPTED'],
      ['the owner role does not have the new password', (b) => b.setWorld('db/makrai.pw', 'drifted'), 'FAIL  tcp_owner_env=REFUSED'],
      ['postgres was recreated', (b) => b.setWorld('containers/docker-postgres-1.started', '2026-10-16T12:21:00.000000000Z\n'), 'FAIL  postgres_start_unchanged=DIFFERENT'],
      ['the web container started before T0', (b) => b.setWorld('containers/docker-nextjs-1.started', '2026-10-16T12:00:00.000000000Z\n'), 'FAIL  nextjs_started_after_T0=no'],
      ['an unexpected key changed', (b) => b.writeEnv(b.readEnv().replace(/^RESEND_API_KEY=.*$/m, 'RESEND_API_KEY=changed')), 'FAIL  keydiff_names='],
      ['a leftover temp file is in root\'s directory', (b) => writeFileSync(path.join(b.rhome, '.t24-env.LEFT'), 'x'), 'FAIL  leftovers=1'],
      ['the new owner password reached a job log', (b) => b.append(path.join(b.root, 'srv/makrai/backup.log'), `oops ${b.envValue('POSTGRES_PASSWORD')}\n`), 'FAIL  leak_logs=1'],
      ['the new NEXTAUTH_SECRET reached the journal', (b) => b.setWorld('journal-all', `line ${b.envValue('NEXTAUTH_SECRET')} line\n`), 'FAIL  leak_journal=1'],
      ['the new makrai_app password reached a shell history', (b) => writeFileSync(path.join(b.rhome, '.bash_history'), `x ${/makrai_app:([0-9a-f]+)@/.exec(b.envValue('APP_DATABASE_URL') ?? '')?.[1]}\n`), 'FAIL  leak_history=1'],
      ['a new value is in the postgres container\'s psql history', (b) => b.setWorld('psql_history', `ALTER ROLE makrai PASSWORD '${b.envValue('POSTGRES_PASSWORD')}';\n`), 'FAIL  psql_history_hits=1'],
      ['the app cannot connect as makrai_app', (b) => b.setWorld('db/makrai_app.pw', 'drifted'), 'FAIL  url_app=APP_DATABASE_URL ERROR 28P01'],
      ['the web container holds a DATABASE_URL', (b) => b.append(path.join(b.world, 'containers/docker-nextjs-1.env'), 'DATABASE_URL=x\n'), 'FAIL  nextjs_DATABASE_URL=1'],
      ['an error other than a refused old cookie is in the web log', (b) => b.setWorld('journal-nextjs', 'Error: connect ECONNREFUSED\n'), 'FAIL  journal_nextjs_other_err=1'],
      ['an ALTER ROLE statement is in the postgres log', (b) => b.setWorld('journal-postgres', 'STATEMENT: ALTER ROLE makrai\n'), 'FAIL  journal_postgres_alter_text_since_T0=1'],
      ['the operator jobs cannot source .env', (b) => b.writeEnv(`${b.readEnv()}NOT A VALID LINE\n`), 'FAIL  operator_load_env=failed'],
    ];
    for (const [name, arrange, want] of cases) {
      const box = afterA();
      arrange(box);
      const r = box.run(['check-a']);
      expect(r.status, `${name}: ${r.all}`).not.toBe(0);
      expect(r.stdout, name).toContain(want);
      expect(r.last, name).toMatch(/^CHECK-A STOP: \d+ check\(s\) failed$/);
    }
  });

  it('passes the refused-old-cookie errors Auth.js logs at priority err, and counts them (T24-V5)', () => {
    const box = afterA();
    box.setWorld('journal-nextjs', [
      '[auth][error] JWTSessionError: no matching decryption secret',
      '[auth][cause]: Error: no matching decryption secret',
      '    at Object.decode (/app/node_modules/@auth/core/jwt.js:1:1)',
      '[auth][details]: {}',
      '',
    ].join('\n'));
    const r = box.run(['check-a']);
    expect(r.last, r.all).toBe('CHECK-A OK');
    expect(r.stdout).toContain('info  journal_nextjs_jwt_session_errors=1 (above 0 is expected');
    expect(r.stdout).toContain('ok    journal_nextjs_other_err=0');
  });

  it('asks the journal for absolute UTC times, whatever the host timezone is (T24-V9)', () => {
    const box = afterA();
    box.run(['check-a']);
    const asks = box.argv().filter((l) => l.startsWith('journalctl '));
    expect(asks.length).toBeGreaterThanOrEqual(4);
    for (const l of asks) {
      const since = /--since (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC/.exec(l);
      expect(since, l).not.toBeNull();
    }
    expect(box.run(['check-a'], { env: { TZ: 'Africa/Kampala' } }).stdout).toContain('FAIL  tz=');
  });

  it('does not take a psql history file for a leak, and does not fail on an old retry line in check-b (T24-V11, V12)', () => {
    const box = afterA();
    box.setWorld('psql_history', 'select 1;\n');
    expect(box.run(['check-a']).stdout).toContain('ok    psql_history_hits=0');
    const b = newBox();
    toChainDone(b);
    b.append(path.join(b.root, 'srv/makrai/offsite-copy.log'), '');
    const r = b.run(['check-b']);
    expect(r.last, r.all).toBe('CHECK-B OK');
  });

  it('check-b stops for a leaked passphrase, a different newest file, and a restore test that fetched another file', () => {
    const cases: Array<[string, (b: Box) => void, string]> = [
      ['the passphrase is in the journal', (b) => b.setWorld('journal-all', `x ${b.envValue('BACKUP_PASSPHRASE')}\n`), 'FAIL  leak_journal=1'],
      ['the passphrase is in a log', (b) => b.append(path.join(b.root, 'srv/makrai/restore-test.log'), `x ${b.envValue('BACKUP_PASSPHRASE')}\n`), 'FAIL  leak_logs=1'],
      ['a file older than NEWBACKUP is newest', (b) => b.addBackup('makrai-20261016-132004.sql.gz.gpg', OLD.pass, -60_000), 'FAIL  newest_local_is_N=DIFFERENT'],
      ['the restore test fetched another file', (b) => b.append(path.join(b.root, 'srv/makrai/restore-test.log'), '[2026-10-16T13:30:00+00:00] fetched=makrai-20261016-000001.sql.gz.gpg age_min=1\n[2026-10-16T13:30:01+00:00] Restore test PASSED\n'), 'FAIL  restore_last_fetched_is_N=DIFFERENT'],
      ['the last restore test failed', (b) => b.append(path.join(b.root, 'srv/makrai/restore-test.log'), '[2026-10-16T13:31:00+00:00] Restore test FAILED: restore\n'), 'FAIL  restore_last_passed=0'],
      ['the off-site log has no completion line', (b) => b.append(path.join(b.root, 'srv/makrai/offsite-copy.log'), '[2026-10-16T13:35:00+00:00] Starting off-site copy...\n'), 'FAIL  offsite_last_complete=0'],
      ['the new file was skipped', (b) => b.append(path.join(b.root, 'srv/makrai/offsite-copy.log'), '[2026-10-16T13:35:00+00:00] Skipped makrai-20261016-132005.sql.gz.gpg: modified less than 2 minutes ago\n'), 'FAIL  offsite_skipped_N=1'],
      ['a restore container is left', (b) => b.setWorld('restore-containers', 'abc\n'), 'FAIL  restore_leftover_containers=1'],
      ['an unexpected key changed', (b) => b.writeEnv(b.readEnv().replace(/^RESEND_API_KEY=.*$/m, 'RESEND_API_KEY=changed')), 'FAIL  keydiff_names='],
      ['the synthetic journey fails', (b) => b.append(path.join(b.root, 'var/log/makrai/synthetic.log'), 'result=fail at=2026-10-16T13:07:00Z\n'), 'FAIL  synthetic_last=result=fail'],
      ['the last synthetic run began before Stage A', (b) => b.append(path.join(b.root, 'var/log/makrai/synthetic.log'), 'result=pass at=2026-10-16T12:07:04Z\n'), 'FAIL  synthetic_last_is_after_T0=no'],
    ];
    for (const [name, arrange, want] of cases) {
      const box = newBox();
      toChainDone(box);
      arrange(box);
      const r = box.run(['check-b']);
      expect(r.status, `${name}: ${r.all}`).not.toBe(0);
      expect(r.stdout, name).toContain(want);
      expect(r.last, name).toMatch(/^CHECK-B STOP: \d+ check\(s\) failed$/);
    }
  });

  it('check-next and shred-prev stop while the next night has not passed, and shred nothing', () => {
    const box = newBox();
    toChainDone(box);
    const r = box.run(['shred-prev']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('FAIL  restore_fetched_after_N=no');
    for (const f of [box.prevA, box.prevB, box.stagedProvision]) expect(existsSync(f)).toBe(true);
    const noChain = newBox();
    stageA(noChain);
    expect(noChain.run(['check-next']).last).toBe('CHECK-NEXT STOP: no NEWBACKUP recorded: backup-chain has not run');
  });
});

describe('makrai-rotate-secrets.sh: the precheck\'s TCP check', () => {
  it('uses the container\'s own address when the service name does not resolve, and still reports REFUSED only when both refuse', () => {
    const box = newBox();
    box.flag('tcp-name-fails');
    const r = box.run(['precheck']);
    expect(r.last, r.all).toBe('PRECHECK OK');
    const tcp = box.recFile('tcp');
    expect(tcp.some((l) => l.includes(' postgres '))).toBe(true);
    expect(tcp.some((l) => l.includes(' ip '))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The README
// ---------------------------------------------------------------------------------------------------------

describe('ops/host/README.md: Rotating the production secrets (Task 24)', () => {
  const README = readFileSync('ops/host/README.md', 'utf8');
  const heading = '## Rotating the production secrets (Task 24)';
  const start = README.indexOf(`\n${heading}\n`);
  const end = README.indexOf('\n## Rules\n', start);
  const SECTION = README.slice(start, end);
  const flat = (t: string): string => t.replace(/\s+/g, ' ');
  const fencedLines = (md: string): string[] => {
    const out: string[] = [];
    let inFence = false;
    for (const line of md.split('\n')) {
      if (line.trimStart().startsWith('```')) { inFence = !inFence; continue; }
      if (inFence) out.push(line);
    }
    return out;
  };

  it('has the section, between the synthetic journey and the Rules', () => {
    expect(start, 'no section').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(README.indexOf('\n## Hourly synthetic journey (Task 20b)\n')).toBeLessThan(start);
  });

  it('has the install-map row: /usr/local/sbin, root:root, 0755, staged and compared with sha256sum -c --strict', () => {
    const row = README.split('\n').find((l) => l.startsWith('| `ops/host/makrai-rotate-secrets.sh` |')) as string;
    expect(row, 'no row in the install map').toBeDefined();
    expect(row).toContain('| `/usr/local/sbin/makrai-rotate-secrets.sh` | root:root | 0755 | `install -m 0755`, from the stage, only after `sha256sum -c --strict`');
    const install = fencedLines(SECTION).join('\n');
    expect(install).toContain("install -m 0600 /srv/makrai/app/ops/host/makrai-rotate-secrets.sh /root/makrai-stage/makrai-rotate-secrets.sh");
    expect(install).toContain("sha256sum -c --strict");
    expect(install).toMatch(/&& install -m 0755 \/root\/makrai-stage\/makrai-rotate-secrets\.sh \/usr\/local\/sbin\/makrai-rotate-secrets\.sh/);
    expect(install, 'the hash is computed on the workstation').toContain('git show <merged commit>:ops/host/makrai-rotate-secrets.sh | sha256sum');
  });

  it('lists exactly the subcommands the script has, each with its step', () => {
    const table = SECTION.split('\n').filter((l) => /^\| `[a-z]/.test(l) && l.includes('|', 5));
    const names = table.map((l) => /^\| `([a-z-]+)/.exec(l)?.[1] as string);
    expect(names).toEqual(SUBCOMMANDS);
  });

  it('only runs the script through subcommands it has, with arguments it accepts', () => {
    const commands = fencedLines(SECTION).filter((l) => l.includes('makrai-rotate-secrets.sh') && !/install -m|sha256/.test(l) && !l.includes('git show'));
    expect(commands.length).toBeGreaterThanOrEqual(10);
    const used = new Set<string>();
    for (const l of commands) {
      const m = /makrai-rotate-secrets\.sh (\S+)/.exec(l);
      expect(m, l).not.toBeNull();
      expect(SUBCOMMANDS, l).toContain((m as RegExpExecArray)[1]);
      used.add((m as RegExpExecArray)[1]);
    }
    for (const must of ['save-prev-a', 'stage-a', 'save-prev-b', 'escrow-check', 'stage-b', 'backup-chain', 'shred-prev', 'precheck', 'check-a', 'check-b', 'check-next']) expect(used.has(must), must).toBe(true);
    // The prose names rollback-a and rollback-b with their keys, and each key is one the script accepts.
    for (const key of ['NEXTAUTH_SECRET', 'POSTGRES_PASSWORD', 'APP_DATABASE_URL', 'DATABASE_URL', 'all']) {
      expect(SECTION).toContain(`rollback-a ${key}`);
      expect(SRC).toContain(key === 'all' ? '    all)' : `    ${key})`);
    }
    expect(SECTION).toContain('rollback-b line');
    expect(SECTION).toContain('rollback-b local');
  });

  it('shows the escrow pipe as Task 5 ran it: the server value to the clipboard, never displayed', () => {
    const pipe = fencedLines(SECTION).join('\n');
    expect(pipe).toContain("ssh -i ~/.ssh/makrai_operator -o IdentitiesOnly=yes -o IdentityAgent=none root@<server> \\");
    expect(pipe).toContain(`"sed -n 's/^BACKUP_PASSPHRASE=//p' /srv/makrai/app/.env | tail -n 1 | tr -d '\\n'" | wl-copy`);
    expect(SECTION).toContain('`wl-copy` (Wayland) or `xclip -selection clipboard`');
    expect(SECTION).toContain('`wl-copy --clear`');
    // No command in the section prints, copies into argv or echoes the passphrase except that pipe.
    const risky = fencedLines(SECTION).filter((l) => /PASSPHRASE|ADMIN_PASSWORD|POSTGRES_PASSWORD|NEXTAUTH_SECRET/.test(l) && !/sed -n 's\/\^BACKUP_PASSPHRASE=\/\/p'/.test(l));
    expect(risky, risky.join('\n')).toEqual([]);
  });

  it('keeps the agent to read-only commands, through a redaction filter that keeps the exit status', () => {
    const agent = fencedLines(SECTION).filter((l) => l.startsWith('$SSH '));
    expect(agent.map((l) => /makrai-rotate-secrets\.sh (\S+)/.exec(l)?.[1])).toEqual(['precheck', 'check-a', 'check-b', 'check-next']);
    for (const l of agent) {
      expect(l).toContain('set -o pipefail;');
      expect(l).toContain('2>&1 $RED');
    }
    const defs = fencedLines(SECTION).join('\n');
    expect(defs).toContain(`RED='| sed -E "s|[A-Za-z0-9+/=]{32,}|<redacted>|g"'`);
    expect(defs).toContain('-S $HOME/.ssh/makrai-window.sock -o ControlMaster=no -o BatchMode=yes');
    expect(SECTION).toContain('`records/ops/ssh-access-baseline.txt`');
    expect(SECTION).toContain('`BASELINE-SAME`');
  });

  it('quotes the markers the script prints, in the order it prints them', () => {
    const doc = flat(SECTION);
    // A marker with a value after `=` is printed with a variable there: its stem is what the script holds.
    // The last line of a subcommand, `<NAME> OK`, is printed by the exit handler from NAME.
    const printsMarker = (m: string): boolean =>
      /^[A-Z]+(-[A-Z]+)* OK$/.test(m) && SRC.includes(`NAME=${m.slice(0, -3)};`) || SRC.includes(m.includes('=') ? m.slice(0, m.indexOf('=') + 1) : m);
    const inOrder = (items: string[]): void => {
      let at = -1;
      for (const m of items) {
        const i = doc.indexOf(m, at + 1);
        expect(i, `"${m}" is not in the README after the one before it`).toBeGreaterThan(at);
        at = i;
        expect(printsMarker(m), `the script never prints "${m}"`).toBe(true);
      }
    };
    inOrder(['A1 OK', 'OWNER-ALTER OK', 'A2 OK', 'A3 OK', 'APP-PROVISION OK', 'A4 OK', 'A5 OK', 'A6 health=ok', 'OPERATOR-LOAD-ENV OK', 'A6 migrate-status rc=0', 'STAGE-A OK']);
    inOrder(['B4 OK', 'NEWBACKUP=', 'B5 escrow_decrypt=1', 'B6 OK', 'B7 rc=0', 'B7 box_has_new=yes', 'B7 OK', 'B8 result=RESTORE MATCH rc=0', 'B8 FETCHED-NEW', 'B8 OK', 'BACKUP-CHAIN OK']);
    for (const m of ['A0 OK', 'SAVE-PREV-A OK', 'B0 OK', 'SAVE-PREV-B OK', 'ESCROW-CHECK OK', 'escrow_decrypt=1', 'B2 shape=1', 'B2 OK', 'STAGE-B OK', 'PRECHECK OK', 'CHECK-NEXT OK', 'SHRED-PREV OK', 'env_prev_files=0', 'A7 OK', 'ADMIN-PASSWORD OK', 'RA-admin OK', 'RA env restored', 'RA-full OK', 'RA-nextauth OK', 'RA-owner OK', 'RA-app OK', 'RA-dburl OK', 'RB-line OK', 'RB-local OK', 'PREV-CURRENT', 'PREV-STALE', 'WRITE FAILED', 'another makrai-rotate-secrets.sh command is running', 'B5 escrow not proven', 'B7 failed', 'B8 failed']) {
      expect(doc.includes(m), `README: ${m}`).toBe(true);
      expect(printsMarker(m), `script: ${m}`).toBe(true);
    }
  });

  it('states the rules of the gate and the timing the same way the script keeps them', () => {
    const doc = flat(SECTION);
    expect(doc).toContain('between hh:15 and hh:50 UTC');
    expect(doc).toContain('hours 06, 22, 23, 00, 01, 02 or 03 UTC');
    expect(SRC).toContain("case $h in 6|22|23|0|1|2|3)");
    expect(SRC).toContain('[ "$m" -ge 15 ] && [ "$m" -le 50 ]');
    expect(doc).toContain('Start Stage B no later than 21:50 UTC');
    expect(doc).toContain('waits 130 seconds');
    expect(doc).toContain('**before anything leaves the server**');
    expect(doc).toContain('Not before the Task 20b soak gate completes');
    expect(doc).toContain('every session is signed out once');
  });

  it('tells the owner the order of the manager steps: prove, rotate, then relabel, with a username unlike both entries (T24-V17)', () => {
    const doc = flat(SECTION);
    expect(doc.indexOf('**B1. Prove the current escrow')).toBeLessThan(doc.indexOf('**B2. The new passphrase.**'));
    const b2 = doc.slice(doc.indexOf('**B2. The new passphrase.**'), doc.indexOf('**B3. Escrow the new value.**'));
    expect(b2).toContain('Only then, in Google Password Manager, relabel the old entry');
    expect(b2).toContain('If `stage-b` stopped, leave the label as it was');
    expect(doc).toContain('username must differ from both existing entries');
    expect(doc).toContain('"STALE: does not match server"');
    expect(doc).toContain('Paste at the script\'s own hidden prompt and press Enter; the script reads one line');
  });

  it('gives per-rollback expectations for the precheck, a stop rule for B7 and names every row it points at (T24-V18)', () => {
    const doc = flat(SECTION);
    expect(doc).toContain('After `rollback-a all` or `rollback-a POSTGRES_PASSWORD` it must read as before Stage A');
    expect(doc).toContain('`postgres_vs_env` reads DIFFERENT, so run `precheck --post-rollback`');
    expect(doc).toContain('| `B7 failed` |');
    expect(doc).toContain('wait 2 minutes and run `backup-chain` once more');
    for (const row of ['`B4 failed`', '`B5 escrow not proven`', '`B7 failed`', '`NEWBACKUP` is on the box']) expect(doc, row).toContain(`| ${row}`);
    expect(doc).toContain('after the copies are shredded there is no rollback');
    expect(doc).toContain('before 23:00 UTC on the day of Stage B');
    expect(doc).toContain('`rollback-b` is gated like a stage, and refuses once a backup named after `NEWBACKUP` exists');
  });

  it('closes the escrow event with the two counts, without naming the operator', () => {
    const counts = fencedLines(SECTION).join('\n');
    expect(counts).toContain('local_pre_rotation=');
    expect(counts).toContain('box_pre_rotation=');
    expect(counts).toContain('sudo -u <operator> bash -c');
    expect(flat(SECTION)).toContain('(about `<LASTOLD date> + 43 days`)');
  });

  it('says what this repository\'s tests cannot show', () => {
    const doc = flat(SECTION);
    expect(doc).toContain('sandbox whose Postgres is a set of files');
    expect(doc).toContain('`precheck`, `check-a` and `check-b` are what show, on the server');
  });

  it('adds the script to the rules and to the list of tests that keep them', () => {
    expect(README).toContain('`__tests__/lint/rotate-secrets-script.test.ts`');
    expect(README).toContain('- `makrai-rotate-secrets.sh` never prints a value');
  });
});
