import { afterAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import {
  type Box,
  OLD,
  type Run,
  SCRIPT,
  appUrl,
  envLines,
  fsSnapshot,
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
    expect(CODE.slice(0, 5)).toEqual([
      'set -Eeuo pipefail',
      "case $- in *x*) echo 'ROTATE STOP: xtrace is on, which would print values'; exit 1 ;; esac",
      // S2: before `cd /`, so that a relative $0 still resolves. The installed copy never honours the test hook.
      `if [ -n "\${MAKRAI_ROTATE_ROOT:-}" ] && [ "$0" -ef /usr/local/sbin/makrai-rotate-secrets.sh ]; then echo 'ROTATE STOP: MAKRAI_ROTATE_ROOT is a test hook; the installed script refuses it'; exit 2; fi`,
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
    // No other command writes to .env. A line that only prints one string (the deploy's own recovery command, RR3-2) is no command.
    const printsOnly = (l: string): boolean => /^(say|stop) "[^"$]*(\$[A-Z_]+[^"$]*)*"$/.test(l);
    const writes = CODE.filter((l) => !printsOnly(l) && (/(>|>>)\s*"?\$(ENVF|APP\/\.env)/.test(l) || /\b(tee|dd|cp|mv|install)\b[^\n]*\$ENVF"?\s*$/.test(l)));
    expect(writes, writes.join('\n')).toEqual([]);
    expect(CODE.filter((l) => printsOnly(l) && /> \$ENVF/.test(l)).length, 'the printed deploy recovery command').toBe(2);
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
    // A zero-byte .env is a "regular empty file" to GNU stat: still the operator's regular file (RR3-1). Nothing else is.
    expect(pin).toContain('"regular file:$OP" | "regular empty file:$OP") return 0 ;;');
    expect(pin.trimEnd().split('\n').slice(-2).join('\n')).toBe('  return 1\n}');
    expect(fn('env_target')).toContain('if ! pin_env; then');
    // A new secret is never written into a file that others can read (S3): the mode is read from the pinned inode, by every writer.
    expect(fn('env_target')).toContain('[ "${1:-}" = write ] && [ "$(stat -L -c %a "$ENVR")" != 600 ]');
    for (const f of ['put_key', 'drop_key', 'cmd_stage_a', 'cmd_stage_b', 'cmd_backup_chain', 'cmd_rollback_a', 'cmd_rollback_b', 'cmd_admin_password']) {
      expect(fn(f), `${f} must refuse a .env that is not mode 600`).toContain('env_target write');
    }
    for (const f of ['put_key', 'drop_key', 'save_prev']) {
      const body = fn(f);
      expect(body, f).toContain('"$ENVR"');
      expect(body.replace(/\$ENVF"?\s*<\s*"\$t"/g, ''), `${f} must not read through the path`).not.toMatch(/(grep|awk|cmp|install|cat)\b[^\n]*"\$ENVF"/);
    }
  });

  it('shows nothing Compose prints but its own progress lines, and the per-URL check only through the redaction filter (S6)', () => {
    // Compose quotes the .env text it chokes on (an unterminated quote, a `$` fragment). A deny-list cannot know what a
    // value looks like, so Compose's output is allow-listed: its progress lines are shown, the rest only counted.
    const show = fn('compose_show');
    // SEC-AWK: the pattern is anchored at the end (only a timing suffix and spaces may follow the status word), and what is printed
    // is the matched line without its decoration, so nothing after the status word can ride along.
    // NF-5: the pin starts at the program's first character: the pattern begins at the line's start, and only non-alphanumeric
    // decoration may stand before the word Container (a loosened ^.* would print a quoted value in front of it).
    expect(show).toContain("awk '/^[^A-Za-z0-9]*(Container|Network|Volume) [A-Za-z0-9_.-]+ +(Recreate|Recreated|Creating|Created|Starting|Started|Waiting|Healthy|Running|Stopping|Stopped|Removing|Removed|Error)( +[0-9.]+s)? *$/ { sub(/^[^A-Za-z0-9]*/, \"\"); print; next }");
    // N7: the failure shapes Compose prints with no free text, and a pointer to docker's own read-only commands.
    expect(show).toContain('/^[^A-Za-z0-9]*(dependency failed to start: )?container [A-Za-z0-9_.-]+ (is unhealthy|exited \\([0-9]+\\))$/ { sub(/^[^A-Za-z0-9]*/, ""); print; next }');
    expect(SRC).toContain('readonly WEB=docker-nextjs-1');
    expect(show).toContain('see: docker ps -a --filter name=docker-nextjs-1; docker logs --tail 50 docker-nextjs-1');
    expect(show).not.toContain('( |$)');
    expect(show).toContain('"compose: " n " other line(s) not shown"');
    expect(show).toContain("sed -e 's/\\x1b\\[[0-9;?]*[A-Za-z]//g' -e 's/\\r$//'");
    expect(fn('restart_nextjs')).toContain('2>&1 | compose_show');
    // Every other use of compose sends both streams to /dev/null.
    const others = CODE.filter((l) => /(^|[^A-Za-z_-])compose (-|up\b|run\b|exec\b|ps\b|logs\b|config\b|down\b|pull\b)/.test(l) && !l.startsWith('compose()') && !l.startsWith('restart_nextjs()'));
    expect(others.length).toBeGreaterThan(0);
    for (const l of others) expect(l, l).toMatch(/>\/dev\/null 2>&1/);
    expect(fn('redact')).toContain("sed -E 's/[A-Za-z0-9+\\/=]{32,}/<redacted>/g'");
    expect(fn('url_checks')).toContain('| redact');
  });

  it('runs Compose from one place, with an empty environment, and restarts nextjs once with --wait', () => {
    expect(CODE.filter((l) => /\bdocker compose\b/.test(l))).toEqual([
      'compose() { ( cd "$COMPOSE_DIR" && env -i PATH="$PATH" HOME="$RHOME" docker compose --env-file ../.env -f docker-compose.prod.yml "$@" ); }',
    ]);
    expect(CODE).toContain('readonly APP=$R/srv/makrai/app');
    expect(CODE).toContain('readonly COMPOSE_DIR=$APP/docker');
    // One place restarts it; Stage A reaches that place once, and a rollback only when it has to (F1, FM-2).
    const ups = CODE.filter((l) => /\bcompose up\b/.test(l));
    expect(ups).toEqual(['restart_nextjs() { compose up -d --no-deps --wait --wait-timeout 120 nextjs 2>&1 | compose_show; }']);
    expect(fn('stage_a_steps').match(/restart_nextjs/g)).toHaveLength(1);
    expect(fn('stage_a_steps')).not.toContain('compose up');
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
    // Every SET comes before the password and the ALTER: a statement that fails with log_min_error_statement still at
    // its default logs its text, and this is the statement that carries the value (T2).
    const at = (needle: string): number => { const i = owner.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    const lastSet = Math.max(...sets.map((x) => at(x)));
    expect(lastSet).toBeLessThan(at(`"\\\\set pw '$esc'"`));
    expect(at(`"\\\\set pw '$esc'"`)).toBeLessThan(at('ALTER ROLE'));
    expect(at('SET log_min_error_statement = panic;')).toBeLessThan(at('ALTER ROLE'));
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
    // Nothing that prints is given a variable that holds a value, wherever in a line the print is (T4). (The behaviour tests
    // below search everything the script printed, and every argument list, for the values and their first and last characters.)
    const valueVar = /\$\{?(NEWV|pp|pw|esc|lp|dec|url|lv|f|c|o|v|a|p)\b/;
    const printed = (l: string): string[] => [...l.matchAll(/(?:^|[;&{(]\s*|\b(?:then|else|do)\s+)(?:say|info|echo)\b([^;|&]*)/g)].map((m) => m[1]);
    const shown = CODE.filter((l) => printed(l).some((args) => valueVar.test(args)));
    expect(shown, shown.join('\n')).toEqual([]);
    const printfs = CODE.filter((l) => /^printf '[^']*\\n' /.test(l) && !/[|>]|printf -v/.test(l) && valueVar.test(l));
    expect(printfs, printfs.join('\n')).toEqual([]);
    // The scan sees a print inside a one-line if.
    expect(printed('if [ -n "$f" ]; then echo SAME; else echo "DIFFERENT ${f:0:16}"; fi').some((a) => valueVar.test(a))).toBe(true);
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
    const changing = ['cmd_save_prev_a', 'cmd_stage_a', 'cmd_verify_a', 'cmd_fix_owner', 'cmd_rollback_a', 'cmd_save_prev_b', 'cmd_escrow_check', 'cmd_stage_b', 'cmd_backup_chain', 'cmd_rollback_b', 'cmd_admin_password', 'cmd_shred_prev'];
    for (const f of changing) expect(fn(f), f).toContain('lock_or_stop');
    for (const f of ['cmd_precheck', 'cmd_check_a', 'cmd_check_b', 'cmd_check_next', 'cmd_gate']) expect(fn(f), `${f} writes nothing`).not.toContain('lock_or_stop');
  });

  it('runs git without optional locks, so that a read-only check does not rewrite the checkout\'s index (S1, F9)', () => {
    const gits = CODE.filter((l) => /\bgit\b/.test(l));
    expect(gits.length).toBeGreaterThanOrEqual(2);
    for (const l of gits) expect(l, l).toContain('git --no-optional-locks -C "$APP"');
  });

  it('gives the operator no path under root\'s directory, and has one operator-side shell write: write_env\'s (T1)', () => {
    // On the server /root is 0700. An operator-side `sh -c '... > "$1"'` opens (and truncates) its target before it reads a
    // root-only source; write_env gives the source to the shell as its stdin, which root opens first.
    const operator = CODE.filter((l) => l.includes('sudo -u "$OP"'));
    const shells = operator.filter((l) => /sudo -u "\$OP" sh -c/.test(l));
    expect(shells).toHaveLength(1);
    expect(fn('write_env')).toContain(shells[0]);
    for (const l of operator) expect(l.replace(/< "\$t"/g, ''), l).not.toMatch(/\$\{?(PREV_A|PREV_B|PREV_ADMIN|RHOME|STAGE_DIR|PROV|STATE|t)\b/);
  });

  it('scans every field of the journal, and requires the postgres log to be the journal (S4)', () => {
    // -o cat prints MESSAGE only: a value in a process\'s argv (journald\'s _CMDLINE) would never be counted.
    expect(fn('leak_scan')).toContain('journalctl --since "$since UTC" -o export');
    expect(fn('leak_scan')).not.toContain('-o cat');
    expect(/readonly PG_SETTINGS_WANT='([^']+)'/.exec(SRC)?.[1]).toContain('logging_collector=off');
    expect(SRC).toMatch(/readonly SETTINGS_SQL=.*'logging_collector'/);
  });

  it('checks .env is whole before every Stage A write and before the whole-file restore (FM-3, FM-4)', () => {
    const steps = fn('stage_a_steps');
    for (const w of ['gen_put NEXTAUTH_SECRET', 'gen_put POSTGRES_PASSWORD', 'legacy_drop', 'new_app_url']) expect(steps, w).toContain(`guard_whole && ${w}`);
    expect(fn('verify_progress')).toContain('env_whole_outside || return 1');
    expect(fn('env_whole_outside')).toContain('grep -vE "$ROTATED_RE"');
    const r = fn('cmd_rollback_a');
    const gate = r.indexOf('keydiff "$PREV_A" "$ENVR"');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(r.indexOf('write_env "$PREV_A"'));
  });

  it('lists the files, checks whose they are, the box and the newest file, and only then writes, in rollback-b local (FM-1)', () => {
    const b = fn('cmd_rollback_b');
    const i = (needle: string): number => { const x = b.indexOf(needle); expect(x, needle).toBeGreaterThan(-1); return x; };
    const write = i('restore_key BACKUP_PASSPHRASE');
    for (const before of ['files=$(nightly_after "$lo")', 'grep -qxF "$f"', 'box_load || bh=$?', 'box_has "$f"', 'remain=$(']) expect(i(before), before).toBeLessThan(write);
    expect(i('rm -f "$BACKUPS/$f"')).toBeGreaterThan(write);
  });

  it('checks the nightly hours again after the prompt and after the wait, where it writes no .env (FM-12)', () => {
    const c = fn('cmd_backup_chain');
    const prompt = c.indexOf('B5 escrow_decrypt');
    const first = c.indexOf('night_check', prompt);
    const sleep = c.indexOf('sleep 130');
    const b6 = c.indexOf("say 'B6 OK'");
    const second = c.indexOf('night_check', b6);
    expect(prompt).toBeGreaterThan(-1);
    expect(first > prompt && first < sleep, 'after the prompt, before the wait').toBe(true);
    expect(second > b6 && second < c.indexOf('makrai-offsite-copy.sh'), 'after the wait, before the copy').toBe(true);
    // N4: nothing runs before 00:00, so the window opens at 23:40; the start of the chain still keeps out of 22 and 23 (the gate).
    expect(fn('night_check')).toContain('case $h in 0|1|2|3|6)');
    expect(fn('night_check')).toContain('[ "$h" -eq 23 ] && [ "$m" -ge 40 ]');
    expect(fn('night_check')).not.toContain('22');
    expect(fn('night_check')).toContain('pgrep -fc \'[m]akrai-(backup|offsite-copy|restore-test)\'');
  });

  it('turns echo off while a hidden prompt may be waiting, drops what was typed ahead and puts echo back (S5)', () => {
    const q = fn('quiet_tty');
    for (const part of ['[ -t 0 ]', 'stty -g', 'stty -echo']) expect(q, part).toContain(part);
    for (const f of ['cmd_backup_chain', 'cmd_escrow_check']) expect(fn(f), f).toContain('quiet_tty');
    const chain = fn('cmd_backup_chain');
    expect(chain.indexOf('quiet_tty'), 'before the hand backup').toBeLessThan(chain.indexOf('makrai-backup.sh'));
    const fin = fn('finish');
    expect(fin).toContain('read -r -s -t 0.1 -n 4096');
    expect(fin).toContain('stty "$SAVED_STTY"');
    expect(fin.indexOf('read -r -s -t 0.1 -n 4096')).toBeLessThan(fin.indexOf('stty "$SAVED_STTY"'));
  });

  it('warns on its first line when it runs against a test tree, and a check against one cannot pass (F13)', () => {
    expect(CODE).toContain('if [ -n "$R" ]; then say "WARNING rotate_root=$R (test tree)"; fi');
    const v = fn('verdict');
    expect(v).toContain('[ -n "$R" ] && [ -z "${MAKRAI_ROTATE_TEST_TREE:-}" ]');
    expect(v).toContain('FAIL  rotate_root=%s (a check against a test tree proves nothing about production)');
  });

  it('restarts nextjs after a rollback only when its running value differs, except rollback-a app, which restarts once (F1, FM-2)', () => {
    const r = fn('cmd_rollback_a');
    expect(fn('restart_if_differs')).toContain('vs_container "$WEB" "$k"');
    expect(r).toContain('restart_if_differs NEXTAUTH_SECRET APP_DATABASE_URL');
    expect(r).toContain('restart_if_differs NEXTAUTH_SECRET ||');
    expect(r).toContain('restart_if_differs APP_DATABASE_URL ||');
    expect(r.match(/restart_nextjs/g)).toHaveLength(1);
    // RA-app: both lines back, then makrai_app, then the one restart; the partial state is recorded as soon as .env changes.
    const app = r.slice(r.indexOf('    app)'), r.indexOf('    NEXTAUTH_SECRET)'));
    expect(app.indexOf('rb_restore NEXTAUTH_SECRET')).toBeGreaterThan(-1);
    expect(app.indexOf('rb_restore NEXTAUTH_SECRET')).toBeLessThan(app.indexOf('rb_restore APP_DATABASE_URL'));
    expect(app.indexOf('rb_restore APP_DATABASE_URL')).toBeLessThan(app.indexOf('app_provision'));
    expect(app.indexOf('app_provision')).toBeLessThan(app.indexOf('restart_nextjs'));
    expect(fn('rb_restore')).toContain('note_partial');
  });

  it('lets a new passphrase invalidate the previous chain, and ignores a NEWBACKUP that is not newer than LASTOLD (N2, NF-1)', () => {
    const b = fn('cmd_stage_b');
    expect(b.indexOf('gen_put BACKUP_PASSPHRASE')).toBeGreaterThan(-1);
    expect(b.indexOf('gen_put BACKUP_PASSPHRASE')).toBeLessThan(b.indexOf('state_del NEWBACKUP ESCROW_NEW CHAIN_HOLD B_DONE'));
    expect(b, 'HAND_FILES stays, for save-prev-b\'s guard').not.toMatch(/state_del[^\n]*HAND_FILES/);
    expect(fn('cmd_rollback_b')).toContain('state_del B_STEP B_DONE CHAIN_HOLD NEWBACKUP ESCROW_NEW');
    expect(fn('cmd_backup_chain')).toContain('! [[ $nb > $lo ]]');
  });

  it('refuses a per-key rollback on a gutted .env, and looks at the file that was being written before it excuses a cut (N1, NF-2, NF-4, NR-1, NR-2)', () => {
    const r = fn('cmd_rollback_a');
    const gutted = 'env_gutted "$PREV_A" "$ROTATED_KEYS_RE" && gutted_stop a';
    expect(r.split(gutted).length - 1).toBe(5);
    for (const branch of ['app)', 'NEXTAUTH_SECRET)', 'POSTGRES_PASSWORD)', 'APP_DATABASE_URL)', 'DATABASE_URL)']) {
      const at = r.indexOf(`    ${branch}\n`);
      expect(at, branch).toBeGreaterThan(-1);
      expect(r.slice(at, at + 160), branch).toContain(gutted);
    }
    // The rotated keys are one constant, anchored at both ends: a key that merely contains one of them is foreign (NF-4).
    expect(SRC).toContain("readonly ROTATED_KEYS_RE='^(NEXTAUTH_SECRET|POSTGRES_PASSWORD|APP_DATABASE_URL|DATABASE_URL|ADMIN_PASSWORD)$'");
    expect(fn('foreign_keys')).toContain('$2 !~ re');
    expect(r).toContain('$2 !~ re');
    // NR-1: a deploy's change that lay after the cut point is in the file that write was making. A cut is excused only when .env
    // is the start of env.prev-a, or of a kept file whose own foreign check is clean; a kept file with a foreign key refuses.
    expect(r).toContain('env_prefix_of "$kept" || continue');
    expect(r).toContain('names=$(foreign_keys "$kept")');
    expect(r).toContain('stop \'a whole-file restore would undo them: run the recovery command the WRITE FAILED line printed, then roll back key by key\'');
    expect(r.indexOf('names=$(foreign_keys "$kept")')).toBeLessThan(r.indexOf('env_prefix_of "$PREV_A"'));
    expect(r.indexOf('env_prefix_of "$PREV_A"')).toBeLessThan(r.indexOf('write_env "$PREV_A"'));
    expect(r, 'the last-line rule of round 2 is gone: an unterminated line is no excuse by itself').not.toContain('lastkey');
    expect(fn('env_gutted')).toContain('env_cut_short "$1"');
    const cut = fn('env_cut_short');
    expect(cut).toContain('[ -n "$(tail -c 1 "$ENVR")" ] || return 1');
    expect(cut).toContain('cmp -s -n "$sz" "$ENVR" "$f"');
    expect(fn('env_prefix_of')).toContain('cmp -s -n "$sz" "$ENVR" "$f"');
    expect(fn('write_env')).toContain('or run rollback-a all again, which accepts a .env that was cut short.');
    // NR-2: rollback-b (both modes) and the admin rollback have the same refusal, against their own copies.
    expect(fn('cmd_rollback_b')).toContain('env_gutted "$PREV_B" \'^BACKUP_PASSPHRASE$\' && gutted_stop b');
    expect(fn('cmd_admin_password')).toContain('env_gutted "$PREV_ADMIN" \'^ADMIN_PASSWORD$\' && gutted_stop admin');
    expect(fn('cmd_stage_b')).toContain('${WRITE_FAILED:+.env may be partial: run the command printed above, then rollback-b line, then stage-b again. }');
    expect(fn('cmd_admin_password')).toContain('${WRITE_FAILED:+.env may be partial: run the command printed above, then admin-password rollback. }');
    // NR-4: the advice names the recovery command first, and once Stage B has started says rollback-a all is refused.
    const adv = fn('gutted_stop');
    expect(adv.indexOf('recovery command')).toBeGreaterThan(-1);
    expect(adv).toContain('if [ -e "$PREV_B" ]');
    expect(adv).toContain('rollback-a all is refused once Stage B has started');
  });

  it('lifts only the hour and minute window on the outage path: a job or an upgrade still stops stage-a (N5)', () => {
    const a = fn('cmd_stage_a');
    const c = a.slice(a.indexOf('case $CUR_STEP in'));
    expect(c).toContain('A4a|A4b|A5)');
    expect(c.indexOf('busy_check')).toBeGreaterThan(c.indexOf('A4a|A4b|A5)'));
    expect(c.indexOf('busy_check')).toBeLessThan(c.indexOf('gate_check'));
    expect(fn('gate_check')).toContain('busy_check || return 1');
  });

  it('gives the outage advice on an interrupt only when makrai_app may have been touched (NF-7)', () => {
    const f = fn('finish');
    expect(f).toContain('case ${CUR_STEP:-} in');
    expect(f.indexOf('A4a|A4b|A5)')).toBeLessThan(f.indexOf('An outage may be in progress'));
    expect(f.indexOf('An outage may be in progress')).toBeLessThan(f.indexOf('makrai_app was not touched'));
  });

  it('refuses a Stage B start after 20:50 UTC, before it looks at the gate or writes anything (F6, FM-8)', () => {
    const b = fn('cmd_stage_b');
    expect(b).toContain('[ "$hm" -le $((20 * 60 + 50)) ]');
    expect(b.indexOf('$((20 * 60 + 50))')).toBeLessThan(b.indexOf('gate_check'));
    expect(b.indexOf('$((20 * 60 + 50))')).toBeLessThan(b.indexOf('gen_put BACKUP_PASSPHRASE'));
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

/** A7: the optional admin password, right after STAGE-A OK and before Stage B. */
const rotateAdmin = (b: Box): Run[] => {
  const r = b.run(['admin-password']);
  expect(r.last, r.all).toBe('ADMIN-PASSWORD OK');
  return [r];
};

/** Stage A (and A7 if asked), then everything before the chain of Stage B (B0, B1, B2), at 13:20Z. Returns every run. */
function toStageBWritten(box: Box, afterA?: (b: Box) => Run[]): Run[] {
  const runs: Run[] = [];
  const a = stageA(box);
  runs.push(a.save, a.stage);
  expect(a.stage.last, a.stage.all).toBe('STAGE-A OK');
  if (afterA) runs.push(...afterA(box));
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
function toChainDone(box: Box, afterA?: (b: Box) => Run[]): Run[] {
  const runs = toStageBWritten(box, afterA);
  const pass = box.envValue('BACKUP_PASSPHRASE') as string;
  runs.push(box.run(['backup-chain'], { input: `${pass}\n` }));
  expect(runs.at(-1)?.last, runs.at(-1)?.all).toBe('BACKUP-CHAIN OK');
  syntheticPassed(box, '2026-10-16T13:07:04Z');
  return runs;
}

/** The hourly synthetic journey passed at this time (the :07 run after Stage A). */
const syntheticPassed = (box: Box, at: string): void => box.append(path.join(box.root, 'var/log/makrai/synthetic.log'), `result=pass at=${at}\n`);

/**
 * The next day, after the 00:00 nightly under the old passphrase: the retry the README describes after a rollback-b line.
 * save-prev-b takes the nightly as the cut-over, escrow-check proves the old value against it, stage-b writes a second new
 * passphrase and backup-chain must take a NEW hand backup, prove the NEW escrow against it, and see it fetched.
 */
function retryStageB(box: Box, firstAttempt: string): Run {
  const nightly = 'makrai-20261017-000001.sql.gz.gpg';
  box.addBackup(nightly, OLD.pass, 0);
  writeFileSync(path.join(box.world, 'box', nightly), readFileSync(path.join(box.backups, nightly)));
  box.setNow('2026-10-17T07:20:00Z');
  const save = box.run(['save-prev-b']);
  expect(save.last, save.all).toBe('SAVE-PREV-B OK');
  expect(save.stdout).toContain(`LASTOLD=${nightly}`);
  const pre = box.run(['escrow-check', 'pre'], { input: `${OLD.pass}\n` });
  expect(pre.last, pre.all).toBe('ESCROW-CHECK OK');
  const stage = box.run(['stage-b']);
  expect(stage.last, stage.all).toBe('STAGE-B OK');
  const second = box.envValue('BACKUP_PASSPHRASE') as string;
  const chain = box.run(['backup-chain'], { input: `${second}\n` });
  expect(chain.last, chain.all).toBe('BACKUP-CHAIN OK');
  const out = chain.stdout.split('\n');
  expect(out, 'a new hand backup was taken').toContain('B4 OK');
  expect(chain.stdout).not.toContain('resuming');
  expect(out.some((l) => /^NEWBACKUP=makrai-20261017-\d{6}\.sql\.gz\.gpg$/.test(l))).toBe(true);
  expect(out, 'the second escrow was proven').toContain('B5 escrow_decrypt=1');
  expect(out).toContain('B8 FETCHED-NEW');
  expect(box.stateGet('NEWBACKUP')).not.toBe(firstAttempt);
  expect(box.argv().filter((l) => l.startsWith('sudo -u ') && l.endsWith('makrai-backup.sh')), 'one hand backup per attempt').toHaveLength(2);
  expect(leaks(box, [chain], [second])).toEqual([]);
  return chain;
}

const envMinus = (text: string, keys: string[]): string[] =>
  text.split('\n').filter((l) => l !== '' && !keys.some((k) => l.startsWith(`${k}=`)));

describe('makrai-rotate-secrets.sh: the precheck', () => {
  it('passes on a healthy production, writes nothing, and ends in PRECHECK OK', () => {
    const box = newBox();
    const before = box.readEnv();
    const snap = fsSnapshot(box);
    const r = box.run(['precheck']);
    expect(r.status, r.all).toBe(0);
    expect(r.last).toBe('PRECHECK OK');
    expect(r.stdout.split('\n').filter((l) => l.startsWith('FAIL'))).toEqual([]);
    for (const want of [
      'ok    env_owner_is_the_checkouts_owner=yes', 'ok    synthetic_last_age_min=13', 'ok    pg_settings=log_min_duration_sample=-1',
      'ok    login=200', 'ok    health={"status":"ok"}', 'ok    jobs_running=0', 'ok    tcp_owner_env=ACCEPTED',
      'ok    tcp_makrai_app_env=ACCEPTED', 'ok    nextjs_DATABASE_URL=0', 'ok    app_url_tail_is_postgres_5432_db=SAME',
      'ok    login_roles=makrai,makrai_app,makrai_identity', 'ok    operator_load_env=ok',
      'ok    nextjs_vs_env_NEXTAUTH_SECRET=SAME', 'ok    postgres_vs_env_POSTGRES_PASSWORD=SAME',
    ]) expect(r.stdout, want).toContain(want);
    // The release facts the README gives expected values for (F10) are reported.
    expect(r.stdout).toMatch(/^info {2}checkout_tag=\S+$/m);
    expect(r.stdout).toMatch(/^info {2}lib_sha256_prefix=[0-9a-f]{12}$/m);
    // Read-only (T3): every file under the sandbox's / and its world, with mode, size, mtime and hash, is as it was;
    // and no restart and no database session was made.
    expect(box.readEnv()).toBe(before);
    expect(fsSnapshot(box)).toBe(snap);
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
    ['the log collector is on', (b) => b.setWorld('pg_settings', 'log_min_duration_sample=-1\nlog_min_duration_statement=-1\nlog_min_error_statement=error\nlog_statement=none\nlog_transaction_sample_rate=0\nlogging_collector=on\npassword_encryption=scram-sha-256\nshared_preload_libraries=\n'), 'FAIL  pg_settings='],
    ['the last synthetic run is more than 70 minutes old (the cron stopped)', (b) => b.append(path.join(b.root, 'var/log/makrai/synthetic.log'), 'result=pass at=2026-10-16T10:07:04Z\n'), 'FAIL  synthetic_last_age_min=133'],
    ['.env belongs to another account than the checkout', (b) => b.setWorld('app-owner', 'someoneelse\n'), 'FAIL  env_owner_is_the_checkouts_owner=no'],
  ])('stops, with a FAIL line and a non-zero status, when %s', (name, arrange, want) => {
    const box = newBox();
    arrange(box);
    const r = box.run(['precheck']);
    expect(r.status, r.all).not.toBe(0);
    expect(r.stdout, name).toContain(want);
    expect(r.last).toMatch(/^PRECHECK STOP: \d+ check\(s\) failed$/);
  });

  it('takes the synthetic journey as current for 70 minutes, and no longer (F10)', () => {
    // The sandbox clock is 12:20:05Z: 11:10:05 is 70 minutes ago, 11:09:05 is 71.
    for (const [at, ok] of [['11:10:05', true], ['11:09:05', false]] as const) {
      const box = newBox();
      box.append(path.join(box.root, 'var/log/makrai/synthetic.log'), `result=pass at=2026-10-16T${at}Z\n`);
      const r = box.run(['precheck']);
      expect(r.status === 0, `${at}: ${r.all}`).toBe(ok);
      expect(r.stdout).toContain(`${ok ? 'ok   ' : 'FAIL '} synthetic_last_age_min=${ok ? 70 : 71}`);
    }
  });

  it('asks git about the checkout without optional locks, so that no index is rewritten (S1, F9)', () => {
    const box = newBox();
    box.run(['precheck']);
    const gits = box.argv().filter((l) => l.startsWith('git '));
    expect(gits.length).toBeGreaterThanOrEqual(2);
    for (const l of gits) expect(l, l).toMatch(/^git --no-optional-locks -C \S+ (status --porcelain|describe --tags --exact-match)$/);
  });

  it('warns on its first line that it runs against a test tree, and a check against one cannot pass (F13)', () => {
    const box = newBox();
    expect(box.run(['gate']).stdout.split('\n')[0]).toBe(`WARNING rotate_root=${box.root} (test tree)`);
    const bare = box.run(['precheck'], { env: { MAKRAI_ROTATE_TEST_TREE: '' } });
    expect(bare.stdout.split('\n')[0]).toBe(`WARNING rotate_root=${box.root} (test tree)`);
    expect(bare.status).not.toBe(0);
    expect(bare.stdout).toContain(`FAIL  rotate_root=${box.root} (a check against a test tree proves nothing about production)`);
    expect(bare.last).toMatch(/^PRECHECK STOP: \d+ check\(s\) failed$/);
    // The same for the post-check of Stage A, which is what the agent records as proof.
    const done = newBox();
    stageA(done);
    const check = done.run(['check-a'], { env: { MAKRAI_ROTATE_TEST_TREE: '' } });
    expect(check.status).not.toBe(0);
    expect(check.stdout).toContain('FAIL  rotate_root=');
    expect(done.run(['check-a']).last, 'with the test variable the same box passes').toBe('CHECK-A OK');
  });

  it('is refused by the installed copy: MAKRAI_ROTATE_ROOT is a test hook (S2)', () => {
    const box = newBox();
    const script = path.join(box.root, 'usr/local/sbin/makrai-rotate-secrets.sh');
    const src = readFileSync(script, 'utf8');
    const guard = '[ "$0" -ef /usr/local/sbin/makrai-rotate-secrets.sh ]';
    expect(src).toContain(guard);
    // The sandbox cannot write /usr/local/sbin, so this copy's guard is pointed at the copy itself: what is tested is the
    // guard's logic (the hook is set, and this IS the installed file), not the path.
    const installed = path.join(box.dir, 'as-installed.sh');
    writeFileSync(installed, src.replace(guard, `[ "$0" -ef ${installed} ]`));
    chmodSync(installed, 0o755);
    const r = spawnSync('bash', [installed, 'precheck'], { encoding: 'utf8', cwd: box.dir, env: box.procEnv() });
    expect(r.status).toBe(2);
    expect(r.stdout.trim()).toBe('ROTATE STOP: MAKRAI_ROTATE_ROOT is a test hook; the installed script refuses it');
    expect(box.argv().filter((l) => !l.startsWith('bash ')), 'nothing was read or run').toEqual([]);
    // A relative $0 resolves too: the guard runs before the script changes directory.
    const rel = spawnSync('bash', [path.basename(installed), 'precheck'], { encoding: 'utf8', cwd: box.dir, env: box.procEnv() });
    expect(rel.status).toBe(2);
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
    // OW-6: the agent sends this form too, in a window: it writes nothing.
    const snap = fsSnapshot(box);
    const post = box.run(['precheck', '--post-rollback']);
    expect(fsSnapshot(box), 'precheck --post-rollback changes nothing').toBe(snap);
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
    if (sub === 'admin-password') setup.push(box.run(['save-prev-a']), box.run(['stage-a']));
    if (sub === 'stage-b') {
      setup.push(box.run(['save-prev-a']), box.run(['stage-a']));
      box.setNow('2026-10-16T13:20:05Z');
      setup.push(box.run(['save-prev-b']), box.run(['escrow-check', 'pre'], { input: `${OLD.pass}\n` }));
    }
    if (sub === 'backup-chain' || sub === 'rollback-b') setup.push(...toStageBWritten(box));
    const before = box.readEnv();
    const generated = box.generated().length;
    // stage-b has its own, earlier refusal in the late hours (below), so its gate is met at 13:55.
    box.setNow(sub === 'stage-b' ? '2026-10-16T13:55:00Z' : '2026-10-16T23:30:00Z');
    const args = sub === 'rollback-b' ? [sub, 'line'] : [sub];
    const r = box.run(args);
    expect(r.status, `${setup.length} setup runs; ${r.all}`).not.toBe(0);
    expect(r.stdout).toContain(sub === 'stage-b' ? 'GATE: start only between hh:15 and hh:50' : 'GATE: not in the hours');
    expect(r.last).toMatch(new RegExp(`^${sub.toUpperCase()} STOP`));
    expect(box.readEnv()).toBe(before);
    expect(box.generated().length, 'no value was generated').toBe(generated);
  });

  it('keeps the gate for admin-password rollback, as rollback-b does: closed, or while a job runs, it changes nothing (OW-1)', () => {
    const box = newBox({ admin: true });
    const { stage } = stageA(box);
    expect(stage.last, stage.all).toBe('STAGE-A OK');
    const afterA = box.readEnv();
    rotateAdmin(box);
    const rotated = box.readEnv();
    for (const at of ['2026-10-16T23:30:00Z', '2026-10-16T00:00:30Z', '2026-10-16T13:05:00Z']) {
      box.setNow(at);
      const r = box.run(['admin-password', 'rollback']);
      expect(r.status, `${at}: ${r.all}`).not.toBe(0);
      expect(r.stdout, at).toMatch(/GATE: (not in the hours|start only between hh:15 and hh:50)/);
      expect(r.last, at).toBe('ADMIN-PASSWORD STOP: the gate is closed; nothing was changed');
      expect(box.readEnv(), at).toBe(rotated);
      expect(r.stdout, at).not.toContain('RA-admin OK');
    }
    box.setNow('2026-10-16T13:20:00Z');
    box.setWorld('jobs', '1\n');
    const busy = box.run(['admin-password', 'rollback']);
    expect(busy.stdout).toContain('GATE: a scheduled job is running');
    expect(busy.last).toBe('ADMIN-PASSWORD STOP: the gate is closed; nothing was changed');
    expect(box.readEnv()).toBe(rotated);
    box.setWorld('jobs', '0\n');
    const open = box.run(['admin-password', 'rollback']);
    expect(open.last, open.all).toBe('ADMIN-PASSWORD OK');
    expect(open.stdout).toContain('gate: open');
    expect(box.readEnv()).toBe(afterA);
    // The refusal of a gutted .env still comes first: it needs no gate to say so (as in rollback-b).
    const rb = fn('cmd_admin_password');
    const branch = rb.slice(rb.indexOf('    rollback)'));
    expect(branch.indexOf('gutted_stop admin')).toBeGreaterThan(-1);
    expect(branch.indexOf('gutted_stop admin')).toBeLessThan(branch.indexOf('gate_check'));
    expect(branch.indexOf('gate_check')).toBeLessThan(branch.indexOf('restore_key ADMIN_PASSWORD'));
  });

  it('writes nothing, whether it opens or refuses (T3)', () => {
    for (const [now, opens] of [['2026-10-16T12:20:30Z', true], ['2026-10-16T23:30:30Z', false]] as const) {
      const box = newBox();
      box.setNow(now);
      const snap = fsSnapshot(box);
      const r = box.run(['gate']);
      expect(r.status === 0, r.all).toBe(opens);
      expect(fsSnapshot(box), `gate at ${now}`).toBe(snap);
    }
  });

  it('refuses a Stage B start after 20:50 UTC though the gate is open, and starts at 20:50 (F6, FM-8)', () => {
    const box = newBox();
    stageA(box);
    box.setNow('2026-10-16T13:20:05Z');
    expect(box.run(['save-prev-b']).last).toBe('SAVE-PREV-B OK');
    expect(box.run(['escrow-check', 'pre'], { input: `${OLD.pass}\n` }).last).toBe('ESCROW-CHECK OK');
    const before = box.readEnv();
    const generated = box.generated().length;
    // 21:20 is inside the gate; a failed B5 could not be rolled back after 21:50, and a chain needs the time before it.
    box.setNow('2026-10-16T21:20:00Z');
    const late = box.run(['stage-b']);
    expect(late.status).not.toBe(0);
    expect(late.stdout).not.toContain('gate: open');
    expect(late.last).toBe('STAGE-B STOP: Stage B starts no later than 20:50 UTC, so that a failed escrow proof can still be rolled back before the gate closes at 22:00 UTC; nothing was changed');
    expect(box.readEnv()).toBe(before);
    expect(box.generated().length).toBe(generated);
    box.setNow('2026-10-16T20:50:30Z');
    const ok = box.run(['stage-b']);
    expect(ok.last, ok.all).toBe('STAGE-B OK');
  });

  it('starts rollback-b at 21:45 but not from 22:00 (F6)', () => {
    const early = newBox();
    toStageBWritten(early);
    early.run(['backup-chain'], { input: 'wrong\n' });
    early.setNow('2026-10-16T21:45:00Z');
    const r = early.run(['rollback-b', 'local']);
    expect(r.last, r.all).toBe('ROLLBACK-B OK');
    const late = newBox();
    toStageBWritten(late);
    late.run(['backup-chain'], { input: 'wrong\n' });
    late.setNow('2026-10-16T22:15:00Z');
    const refused = late.run(['rollback-b', 'local']);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toContain('GATE: not in the hours');
    expect(refused.last).toMatch(/^ROLLBACK-B STOP: the gate is closed; nothing was changed \(rollback-b must start by 21:50 UTC/);
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
    // What the README quotes before T0, in order (F12), and Compose's own progress lines.
    let at = -1;
    for (const l of ['provision script staged, sha256 aa8aea6818dc', 'now 12:20Z, scheduled jobs running: 0, package upgrades running: 0', 'gate: open', 'T0=2026-10-16T12:20:05Z']) {
      const i = out.indexOf(l);
      expect(i, l).toBeGreaterThan(at);
      at = i;
    }
    expect(out.some((l) => /^Container docker-nextjs-1 +Recreate$/.test(l)), 'Compose\'s progress lines are shown, without their decoration').toBe(true);
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
    // The owner's statements reached psql in the order that keeps the value out of the log: the SETs, then the ALTER (T2).
    const alter = box.read(path.join(box.rec, 'psql-stdin-1')).split('\n');
    const panic = alter.indexOf('SET log_min_error_statement = panic;');
    expect(panic).toBeGreaterThan(-1);
    expect(panic).toBeLessThan(alter.findIndex((l) => l.startsWith('ALTER ROLE')));
    expect(box.stateGet('A_DONE')).toBe('1');
    expect(leaks(box, [stage])).toEqual([]);
    const snapA = fsSnapshot(box);
    const check = box.run(['check-a']);
    expect(check.status, check.all).toBe(0);
    expect(check.last).toBe('CHECK-A OK');
    expect(fsSnapshot(box), 'check-a changes nothing: no file, no state, no restart, no database session (T3)').toBe(snapA);
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
    const snapB = fsSnapshot(box);
    const check = box.run(['check-b']);
    expect(check.status, check.all).toBe(0);
    expect(check.last).toBe('CHECK-B OK');
    expect(fsSnapshot(box), 'check-b changes nothing (T3)').toBe(snapB);
    expect(check.stdout).toContain('ok    keydiff_names=BACKUP_PASSPHRASE');
    expect(check.stdout).toContain('ok    restore_last_fetched_is_N=SAME');
    // Not yet: the next night's chain has not run.
    const snapEarly = fsSnapshot(box);
    const early = box.run(['check-next']);
    expect(fsSnapshot(box), 'a failing check-next changes nothing either').toBe(snapEarly);
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
    const snapNext = fsSnapshot(box);
    const next = box.run(['check-next']);
    expect(next.status, next.all).toBe(0);
    expect(next.last).toBe('CHECK-NEXT OK');
    expect(fsSnapshot(box), 'check-next changes nothing (T3)').toBe(snapNext);
    expect(next.stdout, 'check-next counts the copies before the shred').toContain('info  env_prev_files=2');
    const shred = box.run(['shred-prev']);
    expect(shred.status, shred.all).toBe(0);
    // OW-5: shred-prev prints the count after the shred only, the one the README quotes.
    expect(shred.stdout.split('\n').filter((l) => l.includes('env_prev_files='))).toEqual(['env_prev_files=0']);
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
    // The rotation is closed: the state file is archived (names and times only), so that a later rotation starts clean (F7).
    expect(shred.stdout).toMatch(/^state archived: \.makrai-rotate-state\.done-\d{8}T\d{6}Z$/m);
    expect(existsSync(box.state)).toBe(false);
    expect(box.rhomeFiles().filter((f) => f.startsWith('.makrai-rotate-state.done-'))).toHaveLength(1);
    // OW-7: every command that needs the rotation's state says that it is closed, naming the archive, and changes nothing; none
    // blames a step that ran (a second shred-prev does not say the chain never ran).
    const arch = /^state archived: (\S+)$/m.exec(shred.stdout)?.[1] as string;
    const closedEnv = box.readEnv();
    for (const [args, rest] of [
      [['shred-prev'], 'nothing to shred'],
      [['admin-password'], 'A7 belongs to a rotation in progress, right after its Stage A; nothing was changed'],
      [['admin-password', 'rollback'], 'its root copy is shredded, so no rollback exists: roll forward only'],
      [['check-a'], 'a new rotation starts at save-prev-a'],
      [['check-b'], 'a new rotation starts at save-prev-a'],
      [['save-prev-b'], 'a new rotation starts at save-prev-a'],
      [['escrow-check', 'pre'], 'a new rotation starts at save-prev-a'],
      [['escrow-check', 'new'], 'a new rotation starts at save-prev-a'],
      [['stage-b'], 'a new rotation starts at save-prev-a'],
      [['backup-chain'], 'a new rotation starts at save-prev-a'],
    ] as Array<[string[], string]>) {
      const r = box.run(args, { input: 'x\n' });
      expect(r.status, args.join(' ')).not.toBe(0);
      expect(r.last, args.join(' ')).toBe(`${args[0].toUpperCase()} STOP: the rotation is closed (${arch}); ${rest}`);
    }
    expect(box.readEnv()).toBe(closedEnv);
    expect(existsSync(box.state), 'no state file was started by a refusal').toBe(false);
    for (const f of [box.prevA, box.prevB, box.prevAdmin]) expect(existsSync(f), f).toBe(false);
    // The agent's closing read (runbook W4): check-next after the shred reports the rotation closed and no copy left (N3).
    const snapClosed = fsSnapshot(box);
    const closed = box.run(['check-next']);
    expect(closed.status, closed.all).toBe(0);
    expect(closed.last).toBe('CHECK-NEXT OK');
    expect(closed.stdout).toMatch(/^info {2}rotation_closed=\.makrai-rotate-state\.done-\d{8}T\d{6}Z$/m);
    expect(closed.stdout).toContain('ok    env_prev_files=0');
    expect(fsSnapshot(box), 'and it still writes nothing').toBe(snapClosed);
    writeFileSync(box.prevA, 'a copy that should have been shredded\n');
    const left = box.run(['check-next']);
    expect(left.status).not.toBe(0);
    expect(left.stdout).toContain('FAIL  env_prev_files=1');
    rmSync(box.prevA);
    // Each of the other three things that count as left over makes the closing read fail too (NR-5).
    for (const f of [box.prevB, box.prevAdmin, box.stagedProvision]) {
      writeFileSync(f, 'left over\n');
      const one = box.run(['check-next']);
      expect(one.status, f).not.toBe(0);
      expect(one.stdout, f).toContain('FAIL  env_prev_files=1');
      rmSync(f);
    }
    const second = stageA(box);
    expect(second.save.last, second.save.all).toBe('SAVE-PREV-A OK');
    expect(second.stage.last, second.stage.all).toBe('STAGE-A OK');
    expect(box.generated(), 'the second rotation made three new values').toHaveLength(7);
    // OW-7: a new rotation after a closed one has its own state file, and is not refused as closed.
    const checkSecond = box.run(['check-a']);
    expect(checkSecond.last, checkSecond.all).toBe('CHECK-A OK');
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
    runs.push(...toChainDone(box, rotateAdmin));
    runs.push(box.run(['check-a']), box.run(['check-b']));
    box.setNow('2026-10-16T14:20:00Z');
    runs.push(box.run(['admin-password'])); // refused now: Stage B has started
    expect(runs.at(-1)?.status).not.toBe(0);
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

  it('prints a Compose line only whole: text after the status word is counted, not shown (SEC-AWK)', () => {
    const invented = 'zz-invented-trailing-value-4f2a9c';
    const box = newBox();
    box.run(['save-prev-a']);
    box.flag('compose-trailing');
    const r = box.run(['stage-a']);
    expect(r.last, r.all).toBe('STAGE-A OK');
    // Two lines have a real prefix and a value after the status word: neither is shown, both are counted.
    expect(r.all).not.toContain(invented);
    expect(r.all).not.toContain('Started zz-');
    // The decoration before the word Container is dropped; a value in front of it is not decoration (NF-5).
    expect(r.all).not.toContain('zz-invented-leading-value');
    expect(r.stdout).toContain('compose: 3 other line(s) not shown');
    expect(leaks(box, [r], [invented, 'zz-invented-leading-value'])).toEqual([]);
    // The real lines still show: with or without a timing suffix, and without the decoration in front.
    const out = r.stdout.split('\n');
    for (const line of ['Container docker-nextjs-1  Recreate', 'Container docker-nextjs-1  Healthy', 'Container docker-nextjs-1  Started  0.5s', 'Network docker_default  Running']) {
      expect(out, line).toContain(line);
    }
  });

  it('shows nothing of what Compose prints when it quotes a value in an error, long or short (S6)', () => {
    const box = newBox();
    box.run(['save-prev-a']);
    box.flag('fail-compose');
    box.flag('compose-echo');
    const r = box.run(['stage-a']);
    expect(r.status).not.toBe(0);
    // Three lines that are not progress lines: counted, not shown.
    expect(r.all).toContain('compose: 3 other line(s) not shown');
    expect(r.all).not.toContain('invalid interpolation');
    expect(r.all).not.toContain('variable is not set');
    // A value a 32-character mask could not have caught.
    expect(r.all).not.toContain('re_invented_0123456789abcdef');
    expect(leaks(box, [r], ['re_invented_0123456789abcdef'])).toEqual([]);
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

  it('stands in for the operator: it cannot open root\'s directory, and a `> "$1"` has truncated its target by then (T1)', () => {
    const box = newBox();
    box.run(['save-prev-a']);
    const me = userInfo().username;
    const before = box.readEnv();
    const read = box.sh(`sudo -u ${me} cat ${box.prevA}`);
    expect(read.status, 'the operator cannot read root\'s copy').not.toBe(0);
    expect(read.stderr).toContain('Permission denied');
    // The wrong way to copy a root-only file over .env: the operator\'s shell opens .env for writing first.
    const wrong = box.sh(`sudo -u ${me} sh -c 'cat "$2" > "$1"' sh ${box.envPath} ${box.prevA}`);
    expect(wrong.status).not.toBe(0);
    expect(box.readEnv(), '.env was truncated before the read failed, as on the server').toBe('');
    box.writeEnv(before);
    // The way write_env does it: root opens the source and hands it over on stdin.
    const right = box.sh(`sudo -u ${me} sh -c 'cat > "$1"' sh ${box.envPath} < ${box.prevA}`);
    expect(right.status, right.stderr).toBe(0);
    expect(box.readEnv()).toBe(before);
  });

  it('refuses to write a new secret into a .env that is not mode 600, and changes nothing (S3)', () => {
    const refuse = (box: Box, args: string[], mode: number): void => {
      const before = box.readEnv();
      const gen = box.generated().length;
      const ups = composeUps(box);
      const sessions = box.argv().filter((l) => l.includes(' psql ')).length;
      chmodSync(box.envPath, mode);
      const r = box.run(args);
      chmodSync(box.envPath, 0o600);
      expect(r.status, `${args.join(' ')} at ${mode.toString(8)}: ${r.all}`).not.toBe(0);
      expect(r.stdout, args.join(' ')).toContain('env: .env is not mode 600; nothing written');
      expect(r.last, args.join(' ')).toMatch(/^[A-Z-]+ STOP: \.env is not a regular file owned by the operator, mode 600$/);
      expect(box.readEnv(), `${args.join(' ')}: .env is as it was`).toBe(before);
      expect(box.generated().length, 'no value was generated').toBe(gen);
      expect(composeUps(box), 'nothing was restarted').toBe(ups);
      expect(box.argv().filter((l) => l.includes(' psql ')).length, 'no database change was attempted').toBe(sessions);
    };
    // Stage A and its rollbacks, at three modes: group-readable, group-and-other-readable, and read-only for the owner.
    const a = newBox({ admin: true });
    a.run(['save-prev-a']);
    for (const mode of [0o644, 0o640, 0o400]) {
      refuse(a, ['stage-a'], mode);
      refuse(a, ['rollback-a', 'all'], mode);
    }
    expect(a.run(['stage-a']).last, 'at mode 600 the same box goes through').toBe('STAGE-A OK');
    for (const args of [['admin-password'], ['rollback-a', 'APP_DATABASE_URL'], ['rollback-a', 'app']]) refuse(a, args, 0o644);
    // Stage B and its rollbacks.
    const chain = newBox();
    toStageBWritten(chain);
    for (const args of [['backup-chain'], ['rollback-b', 'line'], ['rollback-b', 'local']]) refuse(chain, args, 0o644);
    const b0 = newBox();
    stageA(b0);
    b0.setNow('2026-10-16T13:20:05Z');
    expect(b0.run(['save-prev-b']).last).toBe('SAVE-PREV-B OK');
    expect(b0.run(['escrow-check', 'pre'], { input: `${OLD.pass}\n` }).last).toBe('ESCROW-CHECK OK');
    refuse(b0, ['stage-b'], 0o640);
    expect(b0.run(['stage-b']).last, 'at mode 600 the same box goes through').toBe('STAGE-B OK');
  });

  it('stops, writing nothing, when the file it built does not verify: an awk that loses a line (V2, T5)', () => {
    const box = newBox();
    box.run(['save-prev-a']);
    const before = box.readEnv();
    box.flag('awk-drop-line');
    const r = box.run(['stage-a']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('put: the intended file did not verify; nothing written');
    expect(r.last).toMatch(/^STAGE-A STOP/);
    expect(box.readEnv(), '.env is byte for byte as it was').toBe(before);
    expect(box.rhomeFiles().filter((f) => f.startsWith('.t24-env.')), 'the temp file did not stay').toEqual([]);
    expect(box.world_('db/makrai.pw'), 'nothing after it ran').toBe(OLD.pgpw);
    // The same run without the fault goes through: the proof is not what stopped it.
    box.flag('awk-drop-line', false);
    expect(box.run(['stage-a']).last).toBe('STAGE-A OK');
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
    // verify-a records A_DONE when A6 passes after a stop in A6, so it takes it too (N6, NF-6).
    const verify = spawnSync('flock', [lock, 'bash', script, 'verify-a'], { encoding: 'utf8', env: box.procEnv() });
    expect(verify.status).not.toBe(0);
    expect(verify.stdout).toContain('VERIFY-A STOP: another makrai-rotate-secrets.sh command is running');
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
    // F8: that alone does not read as before Stage A: the new NEXTAUTH_SECRET is still in .env, and the container has the old one.
    const half = box.run(['precheck']).stdout.split('\n').filter((l) => l.startsWith('FAIL'));
    expect(half).toHaveLength(1);
    expect(half[0]).toContain('nextjs_vs_env_NEXTAUTH_SECRET=DIFFERENT');
    const b = box.run(['rollback-a', 'NEXTAUTH_SECRET']);
    expect(b.last, b.all).toBe('ROLLBACK-A OK');
    expect(box.readEnv(), 'every line is as it was').toBe(original);
    expect(box.run(['precheck']).last, 'both rolled back: it reads as before Stage A').toBe('PRECHECK OK');
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
    expect(r.stdout).toContain('RA-app-line OK');
    expect(back.envValue('APP_DATABASE_URL')).toBe(appUrl(OLD.apppw));
    expect(back.db('makrai_app')).toBe(OLD.apppw);
    // F1: no restart. The container still has every old value; a restart would have recreated it with the NEW NEXTAUTH_SECRET
    // that A1 wrote, signing everyone out for a back-out that costs nothing.
    expect(r.stdout).toContain('nextjs: the running container already has the restored value; no restart');
    expect(composeUps(back)).toBe(0);
    expect(back.container('docker-nextjs-1', 'NEXTAUTH_SECRET')).toBe(OLD.nextauth);
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

  it('goes back from an outage with the two per-key rollbacks, which leave a container that still has the old values alone', () => {
    const box = newBox();
    box.flag('fail-compose');
    stageA(box);
    box.flag('fail-compose', false);
    expect(composeUps(box), 'the failed restart').toBe(1);
    const a = box.run(['rollback-a', 'NEXTAUTH_SECRET']);
    expect(a.last, a.all).toBe('ROLLBACK-A OK');
    const b = box.run(['rollback-a', 'APP_DATABASE_URL']);
    expect(b.last, b.all).toBe('ROLLBACK-A OK');
    expect(composeUps(box), 'the container never changed, so there was nothing to restart').toBe(1);
    expect(box.db('makrai_app')).toBe(OLD.apppw);
    expect(box.container('docker-nextjs-1', 'APP_DATABASE_URL')).toBe(appUrl(OLD.apppw));
    expect(box.container('docker-nextjs-1', 'NEXTAUTH_SECRET')).toBe(OLD.nextauth);
    // POSTGRES_PASSWORD stays rotated: the precheck after it says DIFFERENT only with --post-rollback.
    expect(box.run(['precheck']).stdout).toContain('FAIL  postgres_vs_env_POSTGRES_PASSWORD=DIFFERENT');
    expect(box.run(['precheck', '--post-rollback']).last).toBe('PRECHECK OK');
  });

  it('treats a .env cut in the middle of a line as a partial write: rollback-a all restores it, and a per-key rollback refuses it (N1, NF-2)', () => {
    // The disk fills while stage-a writes .env at A1, and the file ends part-way through the IDENTITY_DATABASE_URL line.
    const box = newBox();
    box.run(['save-prev-a']);
    const original = box.readEnv();
    const cutAt = original.indexOf('IDENTITY_DATABASE_URL=') + 'IDENTITY_DATABASE_URL=postgresql://mak'.length;
    box.setWorld('sudo-cut-bytes', `${cutAt}`);
    const r = box.run(['stage-a']);
    expect(r.stdout).toContain('env: WRITE FAILED');
    expect(r.stdout).toContain('then run rollback-a all (stage-a cannot resume at A1), and stage-a again.');
    expect(box.readEnv().length).toBe(cutAt);
    expect(box.readEnv().endsWith('\n'), 'ends part-way through a line').toBe(false);
    box.flag('sudo-cut-bytes', false);
    // A per-key rollback must not print OK over this file.
    const cut = box.readEnv();
    const key = box.run(['rollback-a', 'NEXTAUTH_SECRET']);
    expect(key.status).not.toBe(0);
    expect(key.stdout).toContain('.env has lost lines outside the rotated keys');
    expect(key.last).toMatch(/^ROLLBACK-A STOP: nothing was written\. Run the recovery command the WRITE FAILED line printed/);
    expect(key.last.indexOf('recovery command'), 'the recovery command comes first').toBeLessThan(key.last.indexOf('rollback-a all'));
    expect(box.readEnv()).toBe(cut);
    expect(box.stateGet('A_ROLLBACK'), 'no partial state recorded for a rollback that wrote nothing').toBeUndefined();
    // The whole-file restore is the way out: the cut line is the partial write, not someone else's change.
    const all = box.run(['rollback-a', 'all']);
    expect(all.last, all.all).toBe('ROLLBACK-A OK');
    expect(box.readEnv()).toBe(original);
    expect(box.run(['stage-a']).last, 'a clean second attempt').toBe('STAGE-A OK');

    // The cut falls inside the LAST line, with every other line intact: the only difference is one CHANGED key.
    const last = newBox();
    last.run(['save-prev-a']);
    const text = last.readEnv();
    const inLast = text.indexOf('RESEND_API_KEY=') + 'RESEND_API_KEY=re_inv'.length;
    last.setWorld('sudo-cut-bytes', `${inLast}`);
    expect(last.run(['stage-a']).stdout).toContain('env: WRITE FAILED');
    last.flag('sudo-cut-bytes', false);
    expect(last.readEnv().length, 'cut inside the last line').toBe(inLast);
    expect(last.readEnv().endsWith('re_inv')).toBe(true);
    const lastKey = last.run(['rollback-a', 'APP_DATABASE_URL']);
    expect(lastKey.status, 'a per-key rollback refuses a file that ends part-way through a line').not.toBe(0);
    expect(lastKey.stdout).toContain('.env ends part-way through a line: a write was cut short');
    const lastAll = last.run(['rollback-a', 'all']);
    expect(lastAll.last, lastAll.all).toBe('ROLLBACK-A OK');
    expect(last.readEnv()).toBe(text);
  });

  it('does not take a deploy\'s change for part of a partial write: only the cut line is excused (N1)', () => {
    // (a) the last line is changed by a deploy, but the file ends in a newline: foreign, not cut.
    const term = newBox();
    stageA(term);
    term.writeEnv(term.readEnv().replace(/^RESEND_API_KEY=.*$/m, 'RESEND_API_KEY=re_changed'));
    const termBefore = term.readEnv();
    const t = term.run(['rollback-a', 'all']);
    expect(t.status).not.toBe(0);
    expect(t.stdout).toContain('outside the rotated keys: RESEND_API_KEY');
    expect(term.readEnv()).toBe(termBefore);
    // (b) a deploy changed IDENTITY_DATABASE_URL, and the file was then cut in the middle of the last line: the cut line is
    //     excused, the deploy is not.
    const mixed = newBox();
    stageA(mixed);
    const deployed = mixed.readEnv().replace(/^IDENTITY_DATABASE_URL=.*$/m, 'IDENTITY_DATABASE_URL=postgresql://makrai_identity:changed@postgres:5432/makrai');
    const cutAt = deployed.indexOf('RESEND_API_KEY=') + 'RESEND_API_KEY=re_inv'.length;
    mixed.writeEnv(deployed.slice(0, cutAt));
    const cutText = mixed.readEnv();
    const m = mixed.run(['rollback-a', 'all']);
    expect(m.status).not.toBe(0);
    expect(m.stdout).toMatch(/outside the rotated keys: (IDENTITY_DATABASE_URL,RESEND_API_KEY|RESEND_API_KEY,IDENTITY_DATABASE_URL)$/m);
    expect(mixed.readEnv(), 'the deploy was not undone').toBe(cutText);
  });

  it('does not take a .env that is only missing its last rotated line for a cut write: the legacy DATABASE_URL line comes back last (N1)', () => {
    // After the other three rollbacks, .env is env.prev-a without its last line (the removed legacy line): a byte prefix of
    // env.prev-a that ends at a line boundary. That is a legitimate state, not a write that ran out of room.
    const box = newBox({ legacy: true });
    const original = box.readEnv();
    stageA(box);
    for (const key of ['NEXTAUTH_SECRET', 'POSTGRES_PASSWORD', 'APP_DATABASE_URL']) expect(box.run(['rollback-a', key]).last, key).toBe('ROLLBACK-A OK');
    expect(original.startsWith(box.readEnv())).toBe(true);
    expect(box.readEnv().endsWith('\n')).toBe(true);
    const last = box.run(['rollback-a', 'DATABASE_URL']);
    expect(last.last, last.all).toBe('ROLLBACK-A OK');
    expect(box.readEnv()).toBe(original);
  });

  it('refuses rollback-a all when a deploy\'s change lay after the cut point of a per-key rollback: the file that write was making says so (NR-1)', () => {
    for (const cutKind of ['mid-line', 'line-boundary', 'last-line'] as const) {
      // WEB_IMAGE is the deploy's line, after the line where the write will be cut.
      const box = newBox({ extra: ['WEB_IMAGE=registry.invalid/web@sha256:aaaa'] });
      stageA(box);
      box.writeEnv(box.readEnv().replace('sha256:aaaa', 'sha256:bbbb'));
      const deployed = box.readEnv();
      const at = deployed.indexOf(cutKind === 'last-line' ? 'WEB_IMAGE=' : 'OFFSITE_TARGET=');
      const cutAt = cutKind === 'line-boundary' ? at : at + (cutKind === 'mid-line' ? 'OFFSITE_TARGET=sub1@box' : 'WEB_IMAGE=registry.inv').length;
      box.setWorld('sudo-cut-bytes', `${cutAt}`);
      const w = box.run(['rollback-a', 'NEXTAUTH_SECRET']);
      expect(w.stdout, cutKind).toContain('env: WRITE FAILED');
      box.flag('sudo-cut-bytes', false);
      const cut = box.readEnv();
      expect(cut.length).toBe(cutAt);
      expect(cut.endsWith('\n'), cutKind).toBe(cutKind === 'line-boundary');
      const ups = composeUps(box);
      // The whole-file restore would put the old image back and restart nextjs from it: it refuses, and says what to do.
      const r = box.run(['rollback-a', 'all']);
      expect(r.status, `${cutKind}: ${r.all}`).not.toBe(0);
      expect(r.stdout).toMatch(/holds changes by someone else: WEB_IMAGE$/m);
      expect(r.last).toBe('ROLLBACK-A STOP: a whole-file restore would undo them: run the recovery command the WRITE FAILED line printed, then roll back key by key');
      expect(box.readEnv(), 'the deploy was not undone').toBe(cut);
      expect(composeUps(box)).toBe(ups);
      expect(box.readEnv()).not.toContain('sha256:aaaa');
      // The per-key refusal names the recovery command first, and the kept file.
      const key = box.run(['rollback-a', 'APP_DATABASE_URL']);
      expect(key.status).not.toBe(0);
      expect(key.stdout).toMatch(/^intended file\(s\) that a failed write kept, in \S+: \.t24-env\.\S+$/m);
      expect(key.last).toMatch(/^ROLLBACK-A STOP: nothing was written\. Run the recovery command the WRITE FAILED line printed \(it makes \.env the intended file\), then roll back key by key; or, if nothing else changed \.env, rollback-a all$/);
      // The way that works: the recovery command, then key by key. The deploy's image stays.
      const cmd = /^env: free space, then: (.*)$/m.exec(w.stdout)?.[1] as string;
      expect(box.sh(cmd).status).toBe(0);
      expect(box.readEnv()).toContain('WEB_IMAGE=registry.invalid/web@sha256:bbbb');
      const done = box.run(['rollback-a', 'NEXTAUTH_SECRET']);
      expect(done.last, done.all).toBe('ROLLBACK-A OK');
      expect(box.readEnv()).toContain('WEB_IMAGE=registry.invalid/web@sha256:bbbb');
    }
  });

  it('refuses a mid-line cut that nothing explains: no kept file and not the start of env.prev-a; an unterminated added or hand-changed last line is no excuse (NR-1, NR-3)', () => {
    // The kept file is gone: the cut line is foreign.
    const gone = newBox({ extra: ['WEB_IMAGE=registry.invalid/web@sha256:aaaa'] });
    stageA(gone);
    gone.writeEnv(gone.readEnv().replace('sha256:aaaa', 'sha256:bbbb'));
    const at = gone.readEnv().indexOf('OFFSITE_TARGET=');
    gone.setWorld('sudo-cut-bytes', `${at + 'OFFSITE_TARGET=sub1@box'.length}`);
    gone.run(['rollback-a', 'NEXTAUTH_SECRET']);
    gone.flag('sudo-cut-bytes', false);
    for (const f of gone.rhomeFiles().filter((n) => n.startsWith('.t24-env.'))) rmSync(path.join(gone.rhome, f));
    const goneCut = gone.readEnv();
    const g = gone.run(['rollback-a', 'all']);
    expect(g.status).not.toBe(0);
    expect(g.stdout).toContain('.env was changed since env.prev-a outside the rotated keys: OFFSITE_TARGET');
    expect(gone.readEnv()).toBe(goneCut);
    // (NR-3) a line ADDED with no newline is not a cut of anything.
    const added = newBox();
    stageA(added);
    added.writeEnv(`${added.readEnv()}WEB_IMAGE=registry.invalid/web@sha256:cccc`);
    const addedText = added.readEnv();
    const a = added.run(['rollback-a', 'all']);
    expect(a.status).not.toBe(0);
    expect(a.stdout).toContain('outside the rotated keys: WEB_IMAGE');
    expect(added.readEnv()).toBe(addedText);
    // (NR-3) the last line changed by hand, in an editor that drops the final newline: not a prefix of env.prev-a's line.
    const hand = newBox();
    stageA(hand);
    hand.writeEnv(hand.readEnv().replace(/^RESEND_API_KEY=.*\n/m, 'RESEND_API_KEY=re_by_hand'));
    expect(hand.readEnv().endsWith('\n')).toBe(false);
    const handText = hand.readEnv();
    const h = hand.run(['rollback-a', 'all']);
    expect(h.status).not.toBe(0);
    expect(h.stdout).toContain('outside the rotated keys: RESEND_API_KEY');
    expect(hand.readEnv()).toBe(handText);
  });

  it('ignores a kept file that .env is not the start of: a stale one blocks nothing (NR-5)', () => {
    const box = newBox();
    stageA(box);
    // A stale intended file from an earlier failed write, with a change by someone else in it. .env is not its start.
    writeFileSync(path.join(box.rhome, '.t24-env.STALE1'), `${box.read(box.prevA)}WEB_IMAGE=registry.invalid/web@sha256:zzzz\n`, { mode: 0o600 });
    // .env lost a line (by hand), which sends the check to look at the kept files.
    box.writeEnv(box.readEnv().replace(/^HEALTHCHECK_PING_URL=.*\n/m, ''));
    const r = box.run(['rollback-a', 'all']);
    expect(r.last, r.all).toBe('ROLLBACK-A OK');
  });

  it('does not take an unterminated .env for a cut write when it is not the start of anything: a per-key rollback goes on (NR-5)', () => {
    const box = newBox();
    stageA(box);
    box.writeEnv(`${box.readEnv()}EXTRA_KEY=1`);
    expect(box.readEnv().endsWith('\n')).toBe(false);
    const r = box.run(['rollback-a', 'NEXTAUTH_SECRET']);
    expect(r.last, r.all).toBe('ROLLBACK-A OK');
    expect(box.readEnv()).toContain('EXTRA_KEY=1');
  });

  it('lets rollback-a all run again after its own write was cut to nothing: an empty .env is a cut write, not a changed file (RR3-1)', () => {
    const box = newBox();
    const original = box.readEnv();
    stageA(box);
    box.flag('sudo-truncate');
    const r = box.run(['rollback-a', 'all']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('env: WRITE FAILED');
    expect(r.stdout).toContain('env: or run rollback-a all again, which accepts a .env that was cut short.');
    box.flag('sudo-truncate', false);
    expect(box.readEnv(), 'the disk was full before the first byte').toBe('');
    const again = box.run(['rollback-a', 'all']);
    expect(again.stdout).not.toContain('changed while it was opened');
    expect(again.last, again.all).toBe('ROLLBACK-A OK');
    expect(again.stdout).toContain('RA-full OK');
    expect(box.readEnv()).toBe(original);
    expect(box.db('makrai')).toBe(OLD.pgpw);
    expect(box.db('makrai_app')).toBe(OLD.apppw);
    expect(box.container('docker-nextjs-1', 'NEXTAUTH_SECRET')).toBe(OLD.nextauth);
    // The same after a write in Stage A that was cut to nothing: the guidance's "rollback-a all" works.
    const early = newBox();
    early.run(['save-prev-a']);
    early.flag('sudo-truncate');
    const a1 = early.run(['stage-a']);
    expect(a1.stdout).toContain('env: WRITE FAILED');
    early.flag('sudo-truncate', false);
    expect(early.readEnv()).toBe('');
    const back = early.run(['rollback-a', 'all']);
    expect(back.last, back.all).toBe('ROLLBACK-A OK');
    expect(early.readEnv()).toBe(original);
  });

  it('refuses a per-key rollback on a .env that a write cut to nothing, naming the recovery command; the command, then the rollback, works (RR3-1)', () => {
    const box = newBox();
    const original = box.readEnv();
    stageA(box);
    box.flag('sudo-truncate');
    const w = box.run(['rollback-a', 'NEXTAUTH_SECRET']);
    expect(w.stdout).toContain('env: WRITE FAILED');
    box.flag('sudo-truncate', false);
    expect(box.readEnv()).toBe('');
    const ups = composeUps(box);
    for (const key of ['NEXTAUTH_SECRET', 'APP_DATABASE_URL', 'app']) {
      const r = box.run(['rollback-a', key]);
      expect(r.status, key).not.toBe(0);
      expect(r.stdout, key).not.toContain('changed while it was opened');
      expect(r.stdout, key).toContain('.env has lost lines outside the rotated keys');
      expect(r.stdout, key).toMatch(/^intended file\(s\) that a failed write kept, in \S+: \.t24-env\.\S+$/m);
      expect(r.last, key).toBe('ROLLBACK-A STOP: nothing was written. Run the recovery command the WRITE FAILED line printed (it makes .env the intended file), then roll back key by key; or, if nothing else changed .env, rollback-a all');
      expect(box.readEnv(), key).toBe('');
    }
    expect(composeUps(box), 'nothing restarted from an empty .env').toBe(ups);
    // The printed command, then the rollback.
    const cmd = /^env: free space, then: (.*)$/m.exec(w.stdout)?.[1] as string;
    expect(box.sh(cmd).status).toBe(0);
    const done = box.run(['rollback-a', 'NEXTAUTH_SECRET']);
    expect(done.last, done.all).toBe('ROLLBACK-A OK');
    expect(box.envValue('NEXTAUTH_SECRET')).toBe(OLD.nextauth);
    // Or the whole-file restore, which the kept file (no change by someone else in it) explains.
    const all = newBox();
    stageA(all);
    all.flag('sudo-truncate');
    all.run(['rollback-a', 'NEXTAUTH_SECRET']);
    all.flag('sudo-truncate', false);
    const r = all.run(['rollback-a', 'all']);
    expect(r.last, r.all).toBe('ROLLBACK-A OK');
    expect(all.readEnv()).toBe(original);
    // rollback-b and the admin rollback refuse an empty .env the same way, against their own copies.
    const b = newBox();
    toStageBWritten(b);
    b.writeEnv('');
    const rb = b.run(['rollback-b', 'line']);
    expect(rb.stdout).not.toContain('changed while it was opened');
    expect(rb.last).toMatch(/^ROLLBACK-B STOP: nothing was written\. Run the recovery command the WRITE FAILED line printed/);
    expect(b.readEnv()).toBe('');
    const adm = newBox({ admin: true });
    stageA(adm);
    rotateAdmin(adm);
    adm.writeEnv('');
    const ra = adm.run(['admin-password', 'rollback']);
    expect(ra.last).toMatch(/^ADMIN-PASSWORD STOP: nothing was written\. Run the recovery command the WRITE FAILED line printed/);
    expect(adm.readEnv()).toBe('');
  });

  it('takes no root copy of an empty .env, so that an empty env.prev-b cannot block the whole-file restore (RR3-1)', () => {
    const fresh = newBox();
    fresh.writeEnv('');
    const a = fresh.run(['save-prev-a']);
    expect(a.status).not.toBe(0);
    expect(a.stdout).toContain('.env is empty or has no POSTGRES_USER line (a write that failed?): no copy taken');
    expect(existsSync(fresh.prevA)).toBe(false);
    const box = newBox();
    const original = box.readEnv();
    stageA(box);
    box.writeEnv('');
    box.setNow('2026-10-16T13:20:05Z');
    const b = box.run(['save-prev-b']);
    expect(b.status).not.toBe(0);
    expect(b.stdout).toContain('no copy taken');
    expect(existsSync(box.prevB), 'no env.prev-b, so rollback-a all is not refused as "Stage B has started"').toBe(false);
    const all = box.run(['rollback-a', 'all']);
    expect(all.last, all.all).toBe('ROLLBACK-A OK');
    expect(box.readEnv()).toBe(original);
  });

  it('refuses rollback-a all when .env is the start of the file a deploy\'s set_env was writing and a deploy\'s change is in it, at a line boundary and at nothing (RR3-2)', () => {
    for (const cutKind of ['line-boundary', 'empty'] as const) {
      // deployment.md 8.3 after STAGE-A OK: `set_env WEB_IMAGE` completes (nextjs is recreated from it), then `set_env
      // MIGRATOR_IMAGE` writes .env.new and its `cat .env.new > .env` is cut: at the start of the WEB_IMAGE line, or before the
      // first byte. Both of the deploy's changes lie after the cut point; .env.new stays.
      const box = newBox({ extra: ['WEB_IMAGE=registry.invalid/web@sha256:aaaa', 'MIGRATOR_IMAGE=registry.invalid/migrator@sha256:mmmm'] });
      stageA(box);
      box.writeEnv(box.readEnv().replace('sha256:aaaa', 'sha256:bbbb'));
      const intended = box.readEnv().replace('sha256:mmmm', 'sha256:nnnn');
      const deployNew = path.join(box.app, '.env.new');
      writeFileSync(deployNew, intended, { mode: 0o600 });
      box.writeEnv(cutKind === 'empty' ? '' : intended.slice(0, intended.indexOf('WEB_IMAGE=')));
      const cut = box.readEnv();
      const ups = composeUps(box);
      const r = box.run(['rollback-a', 'all']);
      expect(r.status, `${cutKind}: ${r.all}`).not.toBe(0);
      expect(r.stdout, cutKind).toMatch(/^\.env is the start of the file a deploy's set_env was writing \(\S+\/\.env\.new\), and that file holds changes by someone else: MIGRATOR_IMAGE,WEB_IMAGE$/m);
      expect(r.stdout, cutKind).toMatch(/^a deploy's set_env left the file it was writing, \S+\/\.env\.new: if \.env is its start, that write failed\. Its recovery command is set_env's last step \(deployment\.md 8\): cat \S+\/\.env\.new > \S+\/\.env && rm -f \S+\/\.env\.new$/m);
      expect(r.last, cutKind).toMatch(/^ROLLBACK-A STOP: a whole-file restore would undo them: finish the deploy's write first \(cat \S+\/\.env\.new > \S+\/\.env && rm -f \S+\/\.env\.new\), then roll back key by key$/);
      expect(r.stdout, cutKind).not.toContain('RA env restored');
      expect(box.readEnv(), 'the deploy was not undone').toBe(cut);
      expect(composeUps(box), 'and nextjs was not recreated from the old image').toBe(ups);
      expect(box.read(deployNew)).toBe(intended);
      // The way that works: the deploy's own last step, then key by key. The deploy's images stay.
      const finish = /\(cat (\S+) > (\S+) && rm -f (\S+)\)/.exec(r.last) as RegExpExecArray;
      expect(box.sh(`cat ${finish[1]} > ${finish[2]} && rm -f ${finish[3]}`).status).toBe(0);
      expect(box.readEnv()).toBe(intended);
      const key = box.run(['rollback-a', 'NEXTAUTH_SECRET']);
      expect(key.last, key.all).toBe('ROLLBACK-A OK');
      expect(box.readEnv()).toContain('WEB_IMAGE=registry.invalid/web@sha256:bbbb');
      expect(box.readEnv()).toContain('MIGRATOR_IMAGE=registry.invalid/migrator@sha256:nnnn');
    }
    // A deploy's file with no change by someone else in it explains the cut like root's own kept file does.
    const clean = newBox();
    const original = clean.readEnv();
    stageA(clean);
    writeFileSync(path.join(clean.app, '.env.new'), clean.readEnv(), { mode: 0o600 });
    clean.writeEnv(clean.readEnv().slice(0, clean.readEnv().indexOf('OFFSITE_TARGET=')));
    const ok = clean.run(['rollback-a', 'all']);
    expect(ok.last, ok.all).toBe('ROLLBACK-A OK');
    expect(clean.readEnv()).toBe(original);
  });

  it('refuses a per-key rollback on a .env that ends part-way through a line of the deploy\'s file, and names it (RR3-2)', () => {
    const box = newBox({ extra: ['WEB_IMAGE=registry.invalid/web@sha256:aaaa'] });
    stageA(box);
    const intended = box.readEnv().replace('sha256:aaaa', 'sha256:bbbb');
    writeFileSync(path.join(box.app, '.env.new'), intended, { mode: 0o600 });
    // Cut inside the last line, every other line intact: only the deploy's file shows it is cut.
    box.writeEnv(intended.slice(0, intended.indexOf('WEB_IMAGE=') + 'WEB_IMAGE=registry.inv'.length));
    const cut = box.readEnv();
    const r = box.run(['rollback-a', 'APP_DATABASE_URL']);
    expect(r.status, r.all).not.toBe(0);
    expect(r.stdout).toContain('.env ends part-way through a line: a write was cut short');
    expect(r.stdout).toMatch(/^a deploy's set_env left the file it was writing, \S+\/\.env\.new: if \.env is its start, that write failed\./m);
    expect(r.last).toMatch(/^ROLLBACK-A STOP: nothing was written\. Run the recovery command/);
    expect(box.readEnv(), 'not written over').toBe(cut);
    // A symlink there is not what set_env leaves: root is never told to cat through it.
    const linked = newBox();
    stageA(linked);
    const target = path.join(linked.dir, 'elsewhere');
    writeFileSync(target, linked.readEnv(), { mode: 0o600 });
    symlinkSync(target, path.join(linked.app, '.env.new'));
    linked.writeEnv(linked.readEnv().replace(/^HEALTHCHECK_PING_URL=.*\n/m, ''));
    const l = linked.run(['rollback-a', 'NEXTAUTH_SECRET']);
    expect(l.stdout).toContain('.env has lost lines outside the rotated keys: HEALTHCHECK_PING_URL');
    expect(l.stdout).not.toContain("a deploy's set_env left");
    expect(l.status).not.toBe(0);
  });

  it('points at the recovery command first, and not at rollback-a all once Stage B has started, when .env lost lines (NR-4)', () => {
    const early = newBox();
    stageA(early);
    early.writeEnv(early.readEnv().replace(/^HEALTHCHECK_PING_URL=.*\n/m, ''));
    const e = early.run(['rollback-a', 'NEXTAUTH_SECRET']);
    expect(e.stdout).toContain('.env has lost lines outside the rotated keys: HEALTHCHECK_PING_URL');
    expect(e.last).toBe('ROLLBACK-A STOP: nothing was written. Run the recovery command the WRITE FAILED line printed (it makes .env the intended file), then roll back key by key; or, if nothing else changed .env, rollback-a all');
    const late = newBox();
    toStageBWritten(late);
    late.writeEnv(late.readEnv().replace(/^HEALTHCHECK_PING_URL=.*\n/m, ''));
    const l = late.run(['rollback-a', 'NEXTAUTH_SECRET']);
    expect(l.last).toBe('ROLLBACK-A STOP: nothing was written. Run the recovery command the WRITE FAILED line printed (it makes .env the intended file); if there is none, put the lost lines back from env.prev-a by hand (their names are above); then roll back key by key. rollback-a all is refused once Stage B has started');
    expect(l.last).not.toContain('or, if nothing else changed');
    expect(late.run(['rollback-a', 'all']).last).toMatch(/^ROLLBACK-A STOP: Stage B has started/);
  });

  it('lets rollback-a all run again after its own write was cut in the middle of a line, and prints the command that finishes it (N1)', () => {
    const box = newBox();
    const original = box.readEnv();
    stageA(box);
    const cutAt = original.indexOf('HEALTHCHECK_PING_URL=') + 'HEALTHCHECK_PING_URL=https://hc.inv'.length;
    box.setWorld('sudo-cut-bytes', `${cutAt}`);
    const r = box.run(['rollback-a', 'all']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('env: WRITE FAILED');
    expect(r.stdout).toMatch(/^env: free space, then: test -s \S+\/env\.prev-a && sudo -u \S+ sh -c 'cat > "\$1"' sh \S+\/\.env < \S+\/env\.prev-a$/m);
    expect(r.stdout).toContain('env: or run rollback-a all again, which accepts a .env that was cut short.');
    expect(box.readEnv().length).toBe(cutAt);
    box.flag('sudo-cut-bytes', false);
    // A per-key rollback of the cut file is refused too: it would restart nextjs from a .env without WEB_IMAGE.
    const ups = composeUps(box);
    expect(box.run(['rollback-a', 'APP_DATABASE_URL']).status).not.toBe(0);
    expect(composeUps(box)).toBe(ups);
    // The printed command, then the rollback; and, on a second cut, the rollback run again by itself.
    const cmd = /^env: free space, then: (.*)$/m.exec(r.stdout)?.[1] as string;
    expect(box.sh(cmd).status).toBe(0);
    expect(box.readEnv()).toBe(original);
    const done = box.run(['rollback-a', 'all']);
    expect(done.last, done.all).toBe('ROLLBACK-A OK');
    expect(box.readEnv()).toBe(original);
    const again = newBox();
    stageA(again);
    again.setWorld('sudo-cut-bytes', `${cutAt}`);
    expect(again.run(['rollback-a', 'all']).status).not.toBe(0);
    again.flag('sudo-cut-bytes', false);
    const rerun = again.run(['rollback-a', 'all']);
    expect(rerun.last, rerun.all).toBe('ROLLBACK-A OK');
    expect(again.readEnv()).toBe(original);
    expect(again.db('makrai_app')).toBe(OLD.apppw);
  });

  it('still stops an outage-path resume while a job or a package upgrade runs, whatever the hour, and says what ends the outage (N5)', () => {
    const box = newBox();
    box.flag('fail-alter-makrai_app');
    const { stage } = stageA(box);
    expect(stage.stdout).toContain('APP-PROVISION FAILED');
    expect(box.stateGet('A_STEP')).toBe('A4a');
    box.flag('fail-alter-makrai_app', false);
    const ups = composeUps(box);
    // 23:58 is outside every window; a job and an upgrade are running.
    box.setNow('2026-10-16T23:58:00Z');
    box.setWorld('jobs', '1\n');
    box.setWorld('upgrades', '1\n');
    const r = box.run(['stage-a']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('GATE: a scheduled job is running; wait for it');
    expect(r.stdout).toContain('rollback-a app ends it now');
    expect(r.last).toBe('STAGE-A STOP: a job or an upgrade is running; nothing after the last OK marker ran');
    expect(box.db('makrai_app'), 'makrai_app was not touched').toBe(OLD.apppw);
    expect(composeUps(box)).toBe(ups);
    box.setWorld('jobs', '0\n');
    const up = box.run(['stage-a']);
    expect(up.stdout).toContain('GATE: a package upgrade is running; wait for it');
    expect(up.status).not.toBe(0);
    // Nothing running: the hour and minute window is lifted, as before.
    box.setWorld('upgrades', '0\n');
    const ok = box.run(['stage-a']);
    expect(ok.stdout).not.toContain('GATE: ');
    expect(ok.last, ok.all).toBe('STAGE-A OK');
  });

  it('shows the failure lines Compose prints with no free text, counts the rest, and points at docker\'s own commands (N7)', () => {
    const box = newBox();
    box.run(['save-prev-a']);
    box.flag('fail-compose');
    box.flag('compose-fail-shapes');
    const r = box.run(['stage-a']);
    expect(r.status).not.toBe(0);
    const out = r.stdout.split('\n');
    for (const line of ['Container docker-nextjs-1  Error', 'container docker-nextjs-1 is unhealthy', 'dependency failed to start: container docker-nextjs-1 is unhealthy']) {
      expect(out, line).toContain(line);
    }
    // Compose's own free-text line and a failure line with a value after it are counted, not shown.
    expect(r.all).not.toContain('zz-invented-trailing-value-4f2a9c');
    expect(r.stdout).toContain('compose: 2 other line(s) not shown');
    expect(out).toContain('see: docker ps -a --filter name=docker-nextjs-1; docker logs --tail 50 docker-nextjs-1');
    expect(r.stdout).toContain('OUTAGE');
    expect(leaks(box, [r], ['zz-invented-trailing-value-4f2a9c'])).toEqual([]);
  });

  it('gives the outage advice on an interrupt only when makrai_app may have been touched, and otherwise says to run stage-a again (NF-7)', () => {
    const box = newBox();
    box.setWorld('hup-after-makrai', '1\n'); // the session drops just after the OWNER role\'s ALTER
    const { stage } = stageA(box);
    expect(stage.status).toBe(130);
    expect(box.stateGet('A_STEP')).toBe('A2a');
    expect(stage.stdout).toContain('STAGE A was interrupted after the recorded step A2a. makrai_app was not touched: run stage-a again; it carries on from there.');
    expect(stage.stdout).not.toContain('An outage may be in progress');
    expect(stage.stdout).not.toContain('rollback-a app');
    expect(box.db('makrai_app')).toBe(OLD.apppw);
    box.flag('hup-after-makrai', false);
    expect(box.run(['stage-a']).last).toBe('STAGE-A OK');
  });

  it('ends an outage with rollback-a app: both lines, then makrai_app, then one restart; the partial state is recorded even if the restart fails (FM-2)', () => {
    const box = newBox();
    const original = box.readEnv();
    box.flag('fail-compose');
    const { stage } = stageA(box);
    expect(stage.stdout).toContain('OUTAGE');
    expect(stage.stdout, 'the guidance points at RA-app').toContain('rollback-a app (RA-app: both lines back, makrai_app back, one restart)');
    expect(composeUps(box)).toBe(1);
    // makrai_app has the new password and the running container the old URL: the app lane is down until makrai_app is put back.
    expect(box.db('makrai_app')).not.toBe(OLD.apppw);
    const down = box.run(['rollback-a', 'app']); // Compose still fails
    expect(down.status).not.toBe(0);
    expect(down.stdout).toContain('APP-PROVISION OK');
    expect(down.last).toBe('ROLLBACK-A STOP: nextjs did not come back healthy');
    expect(box.db('makrai_app'), 'the outage is over though the restart failed: the old container works again').toBe(OLD.apppw);
    expect(box.stateGet('A_ROLLBACK'), 'recorded before the restart').toBe('NEXTAUTH_SECRET,APP_DATABASE_URL');
    expect(composeUps(box)).toBe(2);
    box.flag('fail-compose', false);
    const ok = box.run(['rollback-a', 'app']);
    expect(ok.last, ok.all).toBe('ROLLBACK-A OK');
    expect(ok.stdout).toContain('RA-app OK');
    expect(ok.stdout).not.toContain('RA-app-line OK');
    expect(composeUps(box), 'one restart per run').toBe(3);
    expect(box.container('docker-nextjs-1', 'NEXTAUTH_SECRET')).toBe(OLD.nextauth);
    expect(box.container('docker-nextjs-1', 'APP_DATABASE_URL')).toBe(appUrl(OLD.apppw));
    // The owner role stays rotated and the two app lines are as they were.
    expect(envMinus(box.readEnv(), ['POSTGRES_PASSWORD'])).toEqual(envMinus(original, ['POSTGRES_PASSWORD']));
    expect(box.db('makrai')).toBe(box.envValue('POSTGRES_PASSWORD'));
    expect(box.run(['stage-a']).last).toMatch(/^STAGE-A STOP: a partial rollback was done \(NEXTAUTH_SECRET,APP_DATABASE_URL\)/);
    expect(box.run(['precheck']).stdout).toContain('FAIL  postgres_vs_env_POSTGRES_PASSWORD=DIFFERENT');
    expect(box.run(['precheck', '--post-rollback']).last).toBe('PRECHECK OK');
    expect(leaks(box, [stage, down, ok])).toEqual([]);
  });

  it('keeps Stage A incomplete while A6 has not passed: verify-a or stage-a is the forward fix, and Stage B waits (F4, FM-6)', () => {
    const box = newBox();
    box.run(['save-prev-a']);
    box.setWorld('health', '{"status":"error"}');
    const r = box.run(['stage-a']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('A5 OK');
    expect(r.stdout).toContain('A6 health=bad');
    expect(r.stdout).toContain('A6: the site is not healthy. Now: rollback-a app (RA-app), or rollback-a all. Once the cause is fixed: verify-a.');
    expect(r.last).toBe('STAGE-A STOP: health is not ok');
    expect(box.stateGet('A_DONE'), 'A_DONE is recorded only when A6 has passed').toBeUndefined();
    expect(box.run(['save-prev-b']).last).toBe('SAVE-PREV-B STOP: Stage A is not complete (stage-a, then check-a)');
    expect(box.run(['admin-password']).last).toMatch(/^ADMIN-PASSWORD STOP: Stage A is not complete/);
    // The forward fix: once the site answers, verify-a completes Stage A.
    box.setWorld('health', '{"status":"ok"}');
    const v = box.run(['verify-a']);
    expect(v.last, v.all).toBe('VERIFY-A OK');
    expect(box.stateGet('A_DONE')).toBe('1');
    expect(box.run(['stage-a']).last).toBe('STAGE-A STOP: Stage A is already complete; run check-a');
    expect(box.run(['check-a']).last).toBe('CHECK-A OK');
    // ... and a stage-a run is not refused either: it checks A6 again.
    const again = newBox();
    again.run(['save-prev-a']);
    again.setWorld('health', '{"status":"error"}');
    expect(again.run(['stage-a']).last).toBe('STAGE-A STOP: health is not ok');
    again.setWorld('health', '{"status":"ok"}');
    const done = again.run(['stage-a']);
    expect(done.last, done.all).toBe('STAGE-A OK');
    expect(again.stateGet('A_DONE')).toBe('1');
    expect(composeUps(again), 'no second restart').toBe(1);
  });

  it('says what follows a Stage A completed by verify-a, A7 included, and points A7 at an open gate after an outage-path resume (OW-9)', () => {
    const box = newBox({ admin: true });
    box.run(['save-prev-a']);
    box.setWorld('health', '{"status":"error"}');
    expect(box.run(['stage-a']).last).toBe('STAGE-A STOP: health is not ok');
    box.setWorld('health', '{"status":"ok"}');
    const v = box.run(['verify-a']);
    expect(v.last, v.all).toBe('VERIFY-A OK');
    const lines = v.stdout.split('\n');
    expect(lines).toContain('Stage A is complete (A6 passed after the stop in A6).');
    expect(lines).toContain('If the owner approved ADMIN_PASSWORD and W1 reported key_ADMIN_PASSWORD_lines=1: run admin-password next (A7), at an open gate (hh:15 to hh:50 UTC), before the report to the agent.');
    expect(lines).toContain('Report to the agent: T0 and the markers above. Then sign in at https://makrai.org: the old session is gone.');
    // Once only: a verify-a run on a Stage A that is already complete does not say it again.
    expect(box.run(['verify-a']).stdout).not.toContain('run admin-password next');
    // The step it names works from here.
    const a7 = box.run(['admin-password']);
    expect(a7.last, a7.all).toBe('ADMIN-PASSWORD OK');
    // A stage-a that resumed on the outage path ends outside the gate's minutes: its reminder says to wait for the gate, and
    // admin-password does wait for it.
    const late = newBox({ admin: true });
    late.flag('fail-compose');
    expect(stageA(late).stage.last).toBe('STAGE-A STOP: Stage A stopped; see the guidance above (last finished step: A4b)');
    late.flag('fail-compose', false);
    late.setNow('2026-10-16T12:57:00Z');
    const resumed = late.run(['stage-a']);
    expect(resumed.last, resumed.all).toBe('STAGE-A OK');
    expect(resumed.stdout).toContain('run admin-password next (A7), at an open gate (hh:15 to hh:50 UTC)');
    const closed = late.run(['admin-password']);
    expect(closed.last).toBe('ADMIN-PASSWORD STOP: the gate is closed; nothing was changed');
    late.setNow('2026-10-16T13:15:30Z');
    expect(late.run(['admin-password']).last).toBe('ADMIN-PASSWORD OK');
  });

  it('does not say .env is unchanged after a write that failed, and gives the way out of each case (F5, FM-7)', () => {
    // The first write fails and truncates .env: no step is recorded, so stage-a would refuse; the way back is rollback-a all.
    const box = newBox();
    box.run(['save-prev-a']);
    box.flag('sudo-truncate');
    const r = box.run(['stage-a']);
    expect(r.stdout).toContain('env: WRITE FAILED');
    expect(r.stdout).not.toContain('.env is unchanged');
    expect(r.stdout).toContain('State: .env may be partial, or changed outside the rotated keys');
    expect(r.stdout).toContain('Free space and run the recovery command printed above, which makes .env the intended file; then run rollback-a all (stage-a cannot resume at A1), and stage-a again.');
    expect(box.readEnv()).toBe('');
    box.flag('sudo-truncate', false);
    const cmd = /env: free space, then: (.*)$/m.exec(r.stdout)?.[1] as string;
    expect(box.sh(cmd).status).toBe(0);
    const stuck = box.run(['stage-a']);
    expect(stuck.last).toMatch(/^STAGE-A STOP: \.env differs from env\.prev-a and no Stage A step is recorded/);
    const back = box.run(['rollback-a', 'all']);
    expect(back.last, back.all).toBe('ROLLBACK-A OK');
    expect(box.readEnv()).toBe(box.read(box.prevA));
    expect(box.run(['stage-a']).last, 'a clean second attempt').toBe('STAGE-A OK');

    // A write that fails after Stage A has begun: the printed recovery makes .env whole, and stage-a carries on at that step.
    const late = newBox({ legacy: true });
    late.flag('fail-alter-makrai');
    stageA(late);
    late.flag('fail-alter-makrai', false);
    late.flag('sudo-truncate');
    const stopped = late.run(['stage-a']);
    expect(stopped.stdout).toContain('env: WRITE FAILED');
    expect(stopped.stdout).toContain('STAGE A STOPPED at A3');
    expect(stopped.stdout).toContain('Free space and run the recovery command printed above, which makes .env whole again; then run stage-a again (it carries on at this step). Or: rollback-a all.');
    late.flag('sudo-truncate', false);
    const fix = /env: free space, then: (.*)$/m.exec(stopped.stdout)?.[1] as string;
    expect(late.sh(fix).status).toBe(0);
    const done = late.run(['stage-a']);
    expect(done.last, done.all).toBe('STAGE-A OK');
    expect(late.run(['check-a']).last).toBe('CHECK-A OK');
  });

  it('never resumes over a .env that a write cut short, and never writes over it (FM-3)', () => {
    const box = newBox();
    box.flag('fail-alter-makrai');
    stageA(box); // stops at A2b with A1 and A2a written
    box.flag('fail-alter-makrai', false);
    // The A2a write was cut short: only its first lines are left. The rotated lines among them look right.
    const cut = `${box.readEnv().split('\n').slice(0, 7).join('\n')}\n`;
    box.writeEnv(cut);
    const sessions = box.argv().filter((l) => l.includes(' psql ')).length;
    const r = box.run(['stage-a']);
    expect(r.status).not.toBe(0);
    expect(r.last).toBe('STAGE-A STOP: the state file and .env disagree about what is done, or .env is not whole; nothing was changed. Use rollback-a all.');
    expect(box.readEnv(), 'not written over').toBe(cut);
    expect(composeUps(box)).toBe(0);
    expect(box.argv().filter((l) => l.includes(' psql ')).length, 'no database change').toBe(sessions);
    // rollback-a all is the way out, and a missing key is not a change by someone else (FM-4).
    const back = box.run(['rollback-a', 'all']);
    expect(back.last, back.all).toBe('ROLLBACK-A OK');
    expect(box.readEnv()).toBe(box.read(box.prevA));
  });

  it('stops between steps when someone else writes .env in the middle of a run, before it writes over it (FM-3)', () => {
    const box = newBox({ legacy: true });
    box.setWorld('edit-env-in-alter', '1\n');
    const { stage } = stageA(box);
    expect(stage.stdout).toContain('OWNER-ALTER OK');
    expect(stage.stdout).toContain('.env is not whole: lines outside the rotated keys differ from env.prev-a. Nothing was written.');
    expect(stage.stdout).toContain('STAGE A STOPPED at A3');
    expect(stage.stdout).toContain('Run rollback-a all: it puts the whole .env back from env.prev-a.');
    expect(stage.stdout).not.toContain('A3 OK');
    expect(box.readEnv()).toContain('WRITTEN_BY_SOMEONE_ELSE=1');
    expect(box.readEnv(), 'the legacy line was not dropped over it').toMatch(/^DATABASE_URL=/m);
    expect(composeUps(box)).toBe(0);
    expect(box.run(['stage-a']).last, 'and a re-run does not resume over it').toMatch(/^STAGE-A STOP: the state file and \.env disagree/);
  });

  it('refuses rollback-a all when someone else changed .env since env.prev-a, naming the keys; the key-by-key rollbacks still work (FM-4)', () => {
    const box = newBox();
    stageA(box);
    // A deploy after Stage A: one key changed and one added.
    box.writeEnv(`${box.readEnv().replace(/^RESEND_API_KEY=.*$/m, 'RESEND_API_KEY=re_changed').replace(/^IDENTITY_DATABASE_URL=.*$/m, 'IDENTITY_DATABASE_URL=postgresql://makrai_identity:changed@postgres:5432/makrai')}WEB_IMAGE=registry.invalid/web@sha256:1\nSHADOW_DATABASE_URL=postgresql://x@postgres:5432/shadow\n`);
    const before = box.readEnv();
    const ups = composeUps(box);
    const r = box.run(['rollback-a', 'all']);
    expect(r.status).not.toBe(0);
    // Keys that merely contain a rotated name (NF-4) are named as foreign: the allow-list is anchored.
    expect(r.stdout).toMatch(/\.env was changed since env\.prev-a outside the rotated keys: SHADOW_DATABASE_URL,WEB_IMAGE,IDENTITY_DATABASE_URL,RESEND_API_KEY$/m);
    expect(r.last).toBe('ROLLBACK-A STOP: a whole-file restore would undo those changes. Roll back key by key.');
    expect(box.readEnv(), 'the deploy was not undone').toBe(before);
    expect(composeUps(box)).toBe(ups);
    const key = box.run(['rollback-a', 'NEXTAUTH_SECRET']);
    expect(key.last, key.all).toBe('ROLLBACK-A OK');
    expect(box.readEnv()).toContain('WEB_IMAGE=registry.invalid/web@sha256:1');
    expect(box.readEnv()).toContain('RESEND_API_KEY=re_changed');
  });

  it('ends an interrupted run at A4 without waiting for the gate, and says that an outage may be in progress (FM-5)', () => {
    const box = newBox();
    box.setWorld('hup-after-makrai_app', '1\n'); // the session drops just after makrai_app's ALTER committed
    const { stage } = stageA(box);
    expect(stage.status).toBe(130);
    expect(stage.stdout).toContain('STAGE A was interrupted after the recorded step A4a. An outage may be in progress');
    expect(stage.stdout).toContain('rollback-a app');
    expect(stage.last).toBe('STAGE-A STOP: interrupted');
    expect(box.stateGet('A_STEP')).toBe('A4a');
    expect(box.db('makrai_app'), 'the database has the new password').not.toBe(OLD.apppw);
    expect(box.container('docker-nextjs-1', 'APP_DATABASE_URL'), 'the container has the old URL').toContain(OLD.apppw);
    // The owner reconnects at 12:52, inside no gate window: the run goes on, because the outage is to be ended, not scheduled.
    box.flag('hup-after-makrai_app', false);
    box.setNow('2026-10-16T12:52:00Z');
    const again = box.run(['stage-a']);
    expect(again.stdout).not.toContain('GATE');
    expect(again.last, again.all).toBe('STAGE-A OK');
    expect(box.run(['check-a']).last).toBe('CHECK-A OK');
  });

  it('does not start Stage B over a Stage A that was partly rolled back (FM-6)', () => {
    const box = newBox();
    stageA(box);
    box.setNow('2026-10-16T13:20:05Z');
    expect(box.run(['save-prev-b']).last).toBe('SAVE-PREV-B OK');
    expect(box.run(['escrow-check', 'pre'], { input: `${OLD.pass}\n` }).last).toBe('ESCROW-CHECK OK');
    expect(box.run(['rollback-a', 'APP_DATABASE_URL']).last).toBe('ROLLBACK-A OK');
    const before = box.readEnv();
    const stopB = box.run(['stage-b']);
    expect(stopB.status).not.toBe(0);
    expect(stopB.last).toMatch(/^STAGE-B STOP: a partial rollback of Stage A was done \(APP_DATABASE_URL\): finish with rollback-a all, and rotate again, before Stage B$/);
    expect(box.readEnv()).toBe(before);
    const saveB = box.run(['save-prev-b']);
    expect(saveB.last).toMatch(/^SAVE-PREV-B STOP: a partial rollback of Stage A was done \(APP_DATABASE_URL\)/);
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
    expect(r.last).toBe('STAGE-A STOP: the state file and .env disagree about what is done, or .env is not whole; nothing was changed. Use rollback-a all.');
    expect(box.readEnv()).toBe(before);
    expect(box.run(['rollback-a', 'nope']).last).toBe('ROLLBACK-A STOP: usage: rollback-a NEXTAUTH_SECRET|POSTGRES_PASSWORD|APP_DATABASE_URL|DATABASE_URL|app|all');
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
    const ups = composeUps(box);
    const r = box.run(['rollback-a', key]);
    expect(r.status, r.all).toBe(0);
    expect(r.last).toBe('ROLLBACK-A OK');
    const now = box.readEnv();
    expect(now.split('\n').find((l) => l.startsWith(`${key}=`))).toBe(oldLine(box, key));
    expect(envMinus(now, [key])).toEqual(envMinus(mid, [key]));
    // After a complete Stage A the running container holds the new value of these two, so restoring them restarts it, once (F1).
    expect(composeUps(box) - ups, `${key}: restarts`).toBe(key === 'NEXTAUTH_SECRET' || key === 'APP_DATABASE_URL' ? 1 : 0);
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

describe('makrai-rotate-secrets.sh: escrow-check new, before and after the hand backup (OW-8)', () => {
  it('says before B4 that it proves B5 only once the hand backup exists, and after B4 lets backup-chain skip its prompt', () => {
    const box = newBox();
    toStageBWritten(box);
    const early = box.run(['escrow-check', 'new'], { input: 'x\n' });
    expect(early.status).not.toBe(0);
    expect(early.last).toBe('ESCROW-CHECK STOP: no NEWBACKUP recorded: the hand backup (B4) has not run. escrow-check new proves B5 for the hand backup once B4 has made it; before that, backup-chain asks for the new value at its own prompt');
    // A chain that stopped at its B5 prompt: escrow-check new proves the hand backup's escrow, and the chain then does not ask.
    const pass = box.envValue('BACKUP_PASSPHRASE') as string;
    box.typed.push(pass);
    const stopped = box.run(['backup-chain'], { input: 'wrong\n' });
    expect(stopped.last, stopped.all).toBe('BACKUP-CHAIN STOP: B5 escrow not proven');
    const proof = box.run(['escrow-check', 'new'], { input: `${pass}\n` });
    expect(proof.last, proof.all).toBe('ESCROW-CHECK OK');
    const chain = box.run(['backup-chain']);
    expect(chain.last, chain.all).toBe('BACKUP-CHAIN OK');
    expect(chain.stdout).not.toContain('B5 escrow_decrypt');
    expect(leaks(box, [early, stopped, proof, chain])).toEqual([]);
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
    // OW-4: the reminder gives the README's order: relabel the old entry (B2), then escrow the new value (B3), then the chain.
    expect(stageB.stdout.split('\n')).toContain('Now relabel the old entry (README B2), escrow the new value (B3), then run backup-chain.');
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
    // F11: the post-check accepts that case, reports it, and still requires the run to have finished.
    syntheticPassed(box, '2026-10-16T13:07:04Z');
    const check = box.run(['check-b']);
    expect(check.last, check.all).toBe('CHECK-B OK');
    expect(check.stdout).toContain('ok    backup_ping=failed');
    expect(check.stdout).toContain('info  backup_ping_note=the hand backup was fine; only its watchdog ping failed (the accepted B4 case): tell the agent');
    expect(check.stdout).toContain('ok    backup_complete_last=1');
  });

  it('stops before the copy when the escrow prompt was left open into the night, and again when the wait ran long (FM-12)', () => {
    const open = chainBox();
    // The chain starts at 21:48, inside the gate. The prompt is answered two hours later: 23:48, inside the 00:00 backup's reach.
    open.box.setNow('2026-10-16T21:48:00Z');
    open.box.setWorld('gpg-advance', '7200\n');
    const r = open.box.run(['backup-chain'], { input: `${open.pass}\n` });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('B5 escrow_decrypt=1');
    expect(r.stdout).toContain('GATE: the chain has reached the nightly hours (23:40 to 03:59 UTC, and 06)');
    expect(r.last).toBe('BACKUP-CHAIN STOP: nothing left the server; run backup-chain again when the night hours are over');
    expect(open.box.recFile('sleep'), 'it did not wait').toEqual([]);
    expect(open.box.argv().filter((l) => l.endsWith('makrai-offsite-copy.sh') || l.endsWith('makrai-restore-test.sh'))).toEqual([]);
    expect(leaks(open.box, [r])).toEqual([]);
    // A slow host: the 130-second wait takes two hours.
    const slow = chainBox();
    slow.box.setNow('2026-10-16T21:47:00Z');
    slow.box.setWorld('sleep-extra', '7200\n');
    const w = slow.box.run(['backup-chain'], { input: `${slow.pass}\n` });
    expect(w.status).not.toBe(0);
    expect(w.stdout).toContain('B6 OK');
    expect(w.stdout).toContain('GATE: the chain has reached the nightly hours');
    expect(w.last).toBe('BACKUP-CHAIN STOP: nothing left the server; run backup-chain again when the night hours are over');
    expect(slow.box.argv().filter((l) => l.endsWith('makrai-offsite-copy.sh') || l.endsWith('makrai-restore-test.sh'))).toEqual([]);
  });

  it('lets the chain run on after 22:00 and up to 23:40, where nothing else runs, and stops from 23:40 (N4)', () => {
    // 21:48 plus 6400 s is 23:34:40, plus the 130-second wait 23:36:50: before the 00:00 backup can be reached.
    const late = chainBox();
    late.box.setNow('2026-10-16T21:48:00Z');
    late.box.setWorld('gpg-advance', '6400\n');
    const r = late.box.run(['backup-chain'], { input: `${late.pass}\n` });
    expect(r.last, r.all).toBe('BACKUP-CHAIN OK');
    expect(r.stdout).toContain('B8 FETCHED-NEW');
    // The prompt answered at 23:40 sharp stops it.
    const edge = chainBox();
    edge.box.setNow('2026-10-16T21:48:00Z');
    edge.box.setWorld('gpg-advance', '6720\n');
    const e = edge.box.run(['backup-chain'], { input: `${edge.pass}\n` });
    expect(e.status).not.toBe(0);
    expect(e.stdout).toContain('GATE: the chain has reached the nightly hours (23:40 to 03:59 UTC, and 06)');
  });

  it('says to run backup-chain --fresh when a nightly was made after NEWBACKUP, because the restore test will never fetch NEWBACKUP (N4)', () => {
    const { box, pass } = chainBox();
    const first = box.run(['backup-chain'], { input: 'wrong\n' });
    expect(first.last).toBe('BACKUP-CHAIN STOP: B5 escrow not proven');
    // The night passes under the new passphrase: a nightly is the box's newest file.
    const nightly = 'makrai-20261017-000001.sql.gz.gpg';
    box.addBackup(nightly, pass, 0);
    writeFileSync(path.join(box.world, 'box', nightly), readFileSync(path.join(box.backups, nightly)));
    box.setNow('2026-10-17T07:20:00Z');
    const r = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('B8 FETCHED-OTHER');
    expect(r.stdout).toContain(`A nightly made after ${box.stateGet('NEWBACKUP')} exists, so the box's newest file will never be NEWBACKUP: run backup-chain --fresh (B4 to B8 again) and report.`);
    expect(r.stdout).not.toContain('wait 2 minutes');
    const fresh = box.run(['backup-chain', '--fresh'], { input: `${pass}\n` });
    expect(fresh.last, fresh.all).toBe('BACKUP-CHAIN OK');
  });

  it('records a file the backup script kept when it failed after verifying it, and carries on from it instead of taking another (FM-1)', () => {
    const { box, pass } = chainBox();
    box.flag('backup-fail-late');
    const r = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(r.status).not.toBe(0);
    expect(r.last).toBe('BACKUP-CHAIN STOP: B4 failed');
    expect(r.stdout).toMatch(/B4: the script failed after it had verified makrai-\d{8}-\d{6}\.sql\.gz\.gpg and kept that file\. It is recorded as NEWBACKUP/);
    const nb = box.stateGet('NEWBACKUP') as string;
    expect(existsSync(path.join(box.backups, nb))).toBe(true);
    box.flag('backup-fail-late', false);
    const again = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(again.last, again.all).toBe('BACKUP-CHAIN OK');
    expect(again.stdout).toContain(`NEWBACKUP=${nb} (resuming; the hand backup is not repeated)`);
    expect(box.argv().filter((l) => l.startsWith('sudo -u ') && l.endsWith('makrai-backup.sh')), 'one hand backup in all').toHaveLength(1);
  });

  it('rolls back locally a file that a late-failing backup kept and the chain adopted, when its escrow could not be proven (NF-3)', () => {
    const { box, pass } = chainBox();
    box.flag('backup-fail-late');
    expect(box.run(['backup-chain'], { input: `${pass}\n` }).last).toBe('BACKUP-CHAIN STOP: B4 failed');
    const kept = box.stateGet('NEWBACKUP') as string;
    box.flag('backup-fail-late', false);
    const wrong = box.run(['backup-chain'], { input: 'wrong\n' });
    expect(wrong.last).toBe('BACKUP-CHAIN STOP: B5 escrow not proven');
    // The adopted file is one this chain made: it is recorded whether or not the script that made it exited 0.
    expect(box.stateGet('HAND_FILES')).toBe(kept);
    const rb = box.run(['rollback-b', 'local']);
    expect(rb.last, rb.all).toBe('ROLLBACK-B OK');
    expect(existsSync(path.join(box.backups, kept)), 'the adopted file is gone').toBe(false);
    expect(box.envValue('BACKUP_PASSPHRASE')).toBe(OLD.pass);
  });

  it('ignores a NEWBACKUP that is not newer than LASTOLD, and takes a new hand backup and proves its escrow (N2)', () => {
    const { box, pass } = chainBox();
    // A stale record from an earlier attempt: an existing file older than the cut-over, with its escrow marked proven.
    const stale = 'makrai-20261015-000001.sql.gz.gpg';
    expect(existsSync(path.join(box.backups, stale))).toBe(true);
    writeFileSync(box.state, `${box.stateText()}NEWBACKUP=${stale}\nESCROW_NEW=${stale}\n`);
    const r = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(r.last, r.all).toBe('BACKUP-CHAIN OK');
    expect(r.stdout).not.toContain('resuming');
    const out = r.stdout.split('\n');
    expect(out).toContain('B4 OK');
    expect(out).toContain('B5 escrow_decrypt=1');
    expect(out).toContain('B8 FETCHED-NEW');
    expect(box.stateGet('NEWBACKUP')).not.toBe(stale);
  });

  it('takes no hand backup when .env holds the passphrase env.prev-b has: Stage B is not in force (FM-1)', () => {
    const { box } = chainBox();
    box.writeEnv(box.readEnv().replace(/^BACKUP_PASSPHRASE=.*$/m, `BACKUP_PASSPHRASE=${OLD.pass}`));
    const r = box.run(['backup-chain'], { input: 'x\n' });
    expect(r.status).not.toBe(0);
    expect(r.last).toBe('BACKUP-CHAIN STOP: BACKUP_PASSPHRASE in .env is the one env.prev-b has: Stage B is not in force (rolled back?)');
    expect(box.argv().some((l) => l.endsWith('makrai-backup.sh')), 'no backup under the old value').toBe(false);
  });

  it('does not echo a password pasted while the hand backup runs, and reads it at the prompt (S5)', () => {
    const { box, pass } = chainBox();
    box.flag('backup-slow');
    const r = box.run(['backup-chain'], { tty: { inputDelayMs: 1500 }, input: `${pass}\n`, timeout: 90_000 });
    expect(r.last, r.all).toBe('BACKUP-CHAIN OK');
    expect(r.stdout).toContain('B5 escrow_decrypt=1');
    expect(r.all, 'the pasted value was not shown on the terminal').not.toContain(pass);
    expect(leaks(box, [r])).toEqual([]);
    expect(box.argv()).toContain('stty -echo');
  });

  it('drops what was typed ahead when the chain stops before its prompt, and puts echo back (S5)', () => {
    const { box, pass } = chainBox();
    box.flag('backup-slow');
    box.flag('backup-fail');
    // After the script the terminal belongs to the shell the owner is left in: it must not receive the pasted line, and must echo again.
    const after = 'read -r -t 2 left; echo "shell-got=[${left:-}]"; stty -a | tr " " "\\n" | grep -x -- "-\\?echo" | head -n 1';
    const r = box.run(['backup-chain'], { tty: { inputDelayMs: 1500, then: after }, input: `${pass}\n`, timeout: 90_000 });
    expect(r.stdout).toContain('BACKUP-CHAIN STOP: B4 failed');
    expect(r.stdout).toContain('shell-got=[]');
    expect(r.stdout.split('\n').filter((l) => l === 'echo' || l === '-echo'), 'echo is back on').toEqual(['echo']);
    expect(r.all, 'the pasted value was never shown').not.toContain(pass);
    expect(leaks(box, [r])).toEqual([]);
  });


  it('stops at an escrow that does not open the new backup, before anything leaves the server, and resumes there', () => {
    const { box, pass } = chainBox();
    const r = box.run(['backup-chain'], { input: 'not-the-new-value\n' });
    box.typed.push('not-the-new-value');
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('B5 escrow_decrypt=0');
    expect(r.stdout).toContain('nothing has left the server');
    // F6, FM-8: the deadline for the rollback is the gate's last opening, not 23:00.
    expect(r.stdout).toContain('rollback-b local, which must start by 21:50 UTC today (the gate closes at 22:00)');
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
    ['offsite-skip-line', 'the new file named as skipped'],
  ])('does not take %s (%s) for a copy of the new file', (flag) => {
    const { box, pass } = chainBox();
    box.flag(flag);
    const r = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(r.status).not.toBe(0);
    expect(r.last).toBe('BACKUP-CHAIN STOP: B7 failed');
    expect(box.argv().some((l) => l.endsWith('makrai-restore-test.sh'))).toBe(false);
  });

  it('accepts an off-site copy whose only fault is the watchdog ping, says so, and check-b reports it, as for the hand backup (OW-2)', () => {
    const { box, pass } = chainBox();
    box.flag('offsite-pingfail');
    const r = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(r.last, r.all).toBe('BACKUP-CHAIN OK');
    expect(r.stdout.split('\n')).toContain('B7 OK (the copy is fine, only its watchdog ping failed: tell the agent)');
    expect(r.stdout).toContain('B8 FETCHED-NEW');
    expect(box.stateGet('B_DONE')).toBe('1');
    syntheticPassed(box, '2026-10-16T13:07:04Z');
    const check = box.run(['check-b']);
    expect(check.last, check.all).toBe('CHECK-B OK');
    expect(check.stdout).toContain('ok    offsite_last_complete=1');
    expect(check.stdout).toContain('ok    offsite_ping=failed');
    expect(check.stdout).toContain('info  offsite_ping_note=the off-site copy was fine; only its watchdog ping failed (the accepted B7 case): tell the agent');
    // The copy must still have finished: a ping line with no completion before it is no copy, in the chain and in check-b.
    const half = chainBox();
    half.box.flag('offsite-pingfail');
    half.box.flag('offsite-no-complete');
    const h = half.box.run(['backup-chain'], { input: `${half.pass}\n` });
    expect(h.status).not.toBe(0);
    expect(h.last).toBe('BACKUP-CHAIN STOP: B7 failed');
    expect(half.box.argv().some((l) => l.endsWith('makrai-restore-test.sh'))).toBe(false);
    const done = newBox();
    toChainDone(done);
    done.append(path.join(done.root, 'srv/makrai/offsite-copy.log'), '[2026-10-16T13:40:00+00:00] Starting off-site copy...\n[2026-10-16T13:40:09+00:00] WARNING: watchdog ping failed -- the copy is fine, but an absent ping will raise a false alarm.\n');
    const c = done.run(['check-b']);
    expect(c.status).not.toBe(0);
    expect(c.stdout).toContain('FAIL  offsite_last_complete=0');
  });

  it('checks that the new file reached the box, whatever the copy\'s log says (T24-C2)', () => {
    const { box, pass } = chainBox();
    box.flag('offsite-lie');
    const r = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('B7 box_has_new=no');
    expect(r.stdout).toContain('cannot be fixed by about 21:30 UTC (rollback-b is gated and must start by 21:50)');
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
      // FM-9: --fresh does not get round the hold either; the held file is not forgotten.
      const fresh = box.run(['backup-chain', '--fresh'], { input: `${pass}\n` });
      expect(fresh.last, '--fresh refuses while the hold is set').toMatch(/^BACKUP-CHAIN STOP: held after a restore failure/);
      expect(box.stateGet('NEWBACKUP')).toBeTruthy();
      expect(box.argv().filter((l) => l.startsWith('sudo -u ') && l.endsWith('makrai-backup.sh')), 'no second hand backup').toHaveLength(1);
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
    const original = box.read(box.prevB);
    const r = box.run(['rollback-b', 'line']);
    expect(r.status, r.all).toBe(0);
    expect(r.last).toBe('ROLLBACK-B OK');
    expect(r.stdout).toContain('RB-line OK');
    expect(box.readEnv()).toBe(original);
    expect(box.readEnv()).toContain(`BACKUP_PASSPHRASE=${OLD.pass}`);
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

  it('checks every file and the box before it writes, and leaves .env and the files alone when it cannot go through (FM-1)', () => {
    // Run 1 copied the first hand backup to the box and was then told to take a fresh one; the second is local only.
    const box = newBox();
    toStageBWritten(box);
    const pass = box.envValue('BACKUP_PASSPHRASE') as string;
    box.setWorld('restore-field', 'policies');
    const first = box.run(['backup-chain'], { input: `${pass}\n` });
    expect(first.stdout).toContain('run backup-chain --fresh (B4 to B8 again) and report');
    const one = box.stateGet('NEWBACKUP') as string;
    expect(existsSync(path.join(box.world, 'box', one)), 'the first hand backup is on the box').toBe(true);
    box.flag('restore-field', false);
    box.setNow('2026-10-16T13:40:00Z');
    const second = box.run(['backup-chain', '--fresh'], { input: 'wrong\n' });
    expect(second.last).toBe('BACKUP-CHAIN STOP: B5 escrow not proven');
    const two = box.stateGet('NEWBACKUP') as string;
    expect(two).not.toBe(one);
    expect(box.stateGet('HAND_FILES'), 'every hand backup the chain made is recorded').toBe(`${one},${two}`);
    const before = box.readEnv();
    const r = box.run(['rollback-b', 'local']);
    expect(r.status).not.toBe(0);
    expect(r.last).toMatch(new RegExp(`^ROLLBACK-B STOP: ${one.replace(/\./g, '\\.')} is on the box: roll forward only`));
    expect(box.readEnv(), '.env is untouched').toBe(before);
    for (const f of [one, two]) expect(existsSync(path.join(box.backups, f)), `${f} is still there`).toBe(true);
    expect(box.stateGet('NEWBACKUP')).toBe(two);
    expect(box.stateGet('B_STEP')).toBe('B2');
  });

  it('refuses to remove a file it did not make, naming it, before it writes anything (FM-1)', () => {
    const box = newBox();
    toStageBWritten(box);
    box.run(['backup-chain'], { input: 'wrong\n' });
    const nb = box.stateGet('NEWBACKUP') as string;
    // A file in the nightly form that sorts between the cut-over and the hand backup, and is not one of this chain's.
    box.addBackup('makrai-20261016-132000.sql.gz.gpg', OLD.pass, 1000);
    const before = box.readEnv();
    const r = box.run(['rollback-b', 'local']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('Files named after makrai-20261016-000001.sql.gz.gpg that this chain did not make: makrai-20261016-132000.sql.gz.gpg');
    expect(r.last).toBe('ROLLBACK-B STOP: cannot tell whose these are, so none is removed: roll forward, or ask');
    expect(box.readEnv()).toBe(before);
    expect(existsSync(path.join(box.backups, nb))).toBe(true);
  });

  it('removes the file a backup left behind when its log did not finish, though it was never recorded as NEWBACKUP (FM-1)', () => {
    const box = newBox();
    toStageBWritten(box);
    box.flag('backup-truncated-log');
    const r = box.run(['backup-chain'], { input: 'x\n' });
    expect(r.last).toBe('BACKUP-CHAIN STOP: B4: the backup log does not end with Backup complete.');
    expect(box.stateGet('NEWBACKUP')).toBeUndefined();
    const left = readdirSync(box.backups).filter((f) => f > 'makrai-20261016-000001.sql.gz.gpg');
    expect(left).toHaveLength(1);
    expect(box.stateGet('HAND_FILES'), 'recorded, kept or not').toBe(left[0]);
    const rb = box.run(['rollback-b', 'local']);
    expect(rb.last, rb.all).toBe('ROLLBACK-B OK');
    expect(existsSync(path.join(box.backups, left[0])), 'the stray hand backup is gone').toBe(false);
    expect(box.envValue('BACKUP_PASSPHRASE')).toBe(OLD.pass);
  });

  it('stops, with .env and every file untouched, when a file outside the nightly form would be the newest after the removal (NF-3)', () => {
    const box = newBox();
    toStageBWritten(box);
    box.run(['backup-chain'], { input: 'wrong\n' });
    const nb = box.stateGet('NEWBACKUP') as string;
    box.addBackup('makrai-manual.sql.gz.gpg', OLD.pass, 0);
    const before = box.readEnv();
    const r = box.run(['rollback-b', 'local']);
    expect(r.status).not.toBe(0);
    expect(r.last).toBe('ROLLBACK-B STOP: the newest backup would be makrai-manual.sql.gz.gpg, not makrai-20261016-000001.sql.gz.gpg, after the removal; nothing was changed');
    expect(box.readEnv(), '.env is untouched').toBe(before);
    expect(existsSync(path.join(box.backups, nb))).toBe(true);
    expect(existsSync(path.join(box.backups, 'makrai-manual.sql.gz.gpg'))).toBe(true);
    expect(box.stateGet('NEWBACKUP')).toBe(nb);
  });

  it('a Stage B retried after a forced rollback-b line takes a new hand backup and proves the new escrow against it (N2, NF-1)', () => {
    const box = newBox();
    toChainDone(box);
    const first = box.stateGet('NEWBACKUP') as string;
    box.setNow('2026-10-16T14:20:00Z');
    expect(box.run(['rollback-b', 'line']).last).toBe('ROLLBACK-B OK');
    // The first attempt's file was made under a passphrase that is gone: it is no longer the chain's.
    expect(box.stateGet('NEWBACKUP')).toBeUndefined();
    expect(box.stateGet('ESCROW_NEW')).toBeUndefined();
    expect(box.stateGet('HAND_FILES'), 'but it is remembered as a hand backup, for save-prev-b').toBe(first);
    const chain = retryStageB(box, first);
    expect(chain.stdout).toContain('B7 box_has_new=yes');
    expect(box.stateGet('HAND_FILES')).toMatch(new RegExp(`^${first.replace(/\./g, '\\.')},makrai-20261017-\\d{6}\\.sql\\.gz\\.gpg$`));
  });

  it('the same retry works after a hand backup that failed late was adopted and rollback-b line was run (N2, NF-1)', () => {
    const box = newBox();
    toStageBWritten(box);
    box.flag('backup-fail-late');
    const failed = box.run(['backup-chain'], { input: `${box.envValue('BACKUP_PASSPHRASE')}\n` });
    expect(failed.last).toBe('BACKUP-CHAIN STOP: B4 failed');
    const first = box.stateGet('NEWBACKUP') as string;
    box.flag('backup-fail-late', false);
    box.setNow('2026-10-16T14:20:00Z');
    expect(box.run(['rollback-b', 'line']).last).toBe('ROLLBACK-B OK');
    expect(box.stateGet('NEWBACKUP')).toBeUndefined();
    retryStageB(box, first);
  });

  it('a stage-b that writes a second passphrase clears the first attempt\'s chain, even without rollback-b line (N2)', () => {
    // The state a retry could find: B_STEP cleared by hand, NEWBACKUP and ESCROW_NEW left from an earlier chain.
    const box = newBox();
    toChainDone(box);
    const first = box.stateGet('NEWBACKUP') as string;
    writeFileSync(box.state, box.stateText().replace(/^B_STEP=.*\n/m, '').replace(/^B_DONE=.*\n/m, ''));
    writeFileSync(box.envPath, box.read(box.prevB));
    box.setNow('2026-10-16T14:20:00Z');
    expect(box.stateGet('NEWBACKUP')).toBe(first);
    const nightly = 'makrai-20261017-000001.sql.gz.gpg';
    box.addBackup(nightly, OLD.pass, 1000);
    box.setNow('2026-10-17T07:20:00Z');
    expect(box.run(['save-prev-b']).last).toBe('SAVE-PREV-B OK');
    expect(box.run(['escrow-check', 'pre'], { input: `${OLD.pass}\n` }).last).toBe('ESCROW-CHECK OK');
    expect(box.run(['stage-b']).last).toBe('STAGE-B OK');
    expect(box.stateGet('NEWBACKUP')).toBeUndefined();
    expect(box.stateGet('ESCROW_NEW')).toBeUndefined();
    expect(box.stateGet('HAND_FILES'), 'kept for save-prev-b').toBe(first);
  });

  it('stage-b cut by a full disk: rollback-b refuses the gutted .env in both modes and names the recovery command; the command, then rollback-b line, restores (NR-2)', () => {
    const box = newBox();
    stageA(box);
    box.setNow('2026-10-16T13:20:05Z');
    expect(box.run(['save-prev-b']).last).toBe('SAVE-PREV-B OK');
    expect(box.run(['escrow-check', 'pre'], { input: `${OLD.pass}\n` }).last).toBe('ESCROW-CHECK OK');
    const text = box.readEnv();
    // The new passphrase is longer than the old one, so the intended file is longer by the difference before the cut.
    const cutAt = text.indexOf('HEALTHCHECK_PING_URL=') + (64 - OLD.pass.length) + 'HEALTHCHECK_PING_URL=https://hc.inv'.length;
    box.setWorld('sudo-cut-bytes', `${cutAt}`);
    const r = box.run(['stage-b']);
    expect(r.stdout).toContain('env: WRITE FAILED');
    expect(r.last).toBe('STAGE-B STOP: .env may be partial: run the command printed above, then rollback-b line, then stage-b again. BACKUP_PASSPHRASE was not written');
    box.flag('sudo-cut-bytes', false);
    const cut = box.readEnv();
    for (const mode of ['line', 'local']) {
      const rb = box.run(['rollback-b', mode]);
      expect(rb.status, mode).not.toBe(0);
      expect(rb.stdout).toContain('.env has lost lines outside the rotated keys: RESEND_API_KEY');
      expect(rb.last).toMatch(/^ROLLBACK-B STOP: nothing was written\. Run the recovery command the WRITE FAILED line printed \(it makes \.env the intended file\), then this rollback again;/);
      expect(box.readEnv(), `${mode}: .env is as the cut left it`).toBe(cut);
    }
    const cmd = /^env: free space, then: (.*)$/m.exec(r.stdout)?.[1] as string;
    expect(box.sh(cmd).status).toBe(0);
    const line = box.run(['rollback-b', 'line']);
    expect(line.last, line.all).toBe('ROLLBACK-B OK');
    expect(box.readEnv()).toBe(box.read(box.prevB));
    expect(box.run(['stage-b']).last, 'and stage-b can be run again').toBe('STAGE-B OK');
  });

  it('rollback-b does not take the passphrase line it is about to restore for a lost line (NR-2)', () => {
    // BACKUP_PASSPHRASE is the last line, and the write is cut at a line boundary just before it: the only line missing is the one
    // rollback-b puts back, so the file is not gutted.
    const lines = [...envLines().filter((l) => !l.startsWith('BACKUP_PASSPHRASE=')), `BACKUP_PASSPHRASE=${OLD.pass}`];
    const box = newBox({ lines });
    stageA(box);
    box.setNow('2026-10-16T13:20:05Z');
    expect(box.run(['save-prev-b']).last).toBe('SAVE-PREV-B OK');
    expect(box.run(['escrow-check', 'pre'], { input: `${OLD.pass}\n` }).last).toBe('ESCROW-CHECK OK');
    box.setWorld('sudo-cut-bytes', `${box.readEnv().indexOf('BACKUP_PASSPHRASE=')}`);
    expect(box.run(['stage-b']).stdout).toContain('env: WRITE FAILED');
    box.flag('sudo-cut-bytes', false);
    expect(box.readEnv().endsWith('\n')).toBe(true);
    expect(box.readEnv()).not.toContain('BACKUP_PASSPHRASE=');
    const rb = box.run(['rollback-b', 'line']);
    expect(rb.last, rb.all).toBe('ROLLBACK-B OK');
    expect(box.readEnv()).toBe(box.read(box.prevB));
  });

  it('tells the owner to keep the new escrow entry when rollback-b line is forced after files were made under it, and never takes such a file as the cut-over (FM-10)', () => {
    const box = newBox();
    toChainDone(box);
    const nb = box.stateGet('NEWBACKUP') as string;
    box.setNow('2026-10-16T14:20:00Z');
    const r = box.run(['rollback-b', 'line']);
    expect(r.last, r.all).toBe('ROLLBACK-B OK');
    expect(r.stdout).toContain(`Files made under the new passphrase remain: ${nb}`);
    expect(r.stdout).toContain('Keep the new escrow entry; do not delete it.');
    expect(r.stdout).toContain('at least 43 days');
    const again = box.run(['save-prev-b']);
    expect(again.status).not.toBe(0);
    expect(again.last).toMatch(/^SAVE-PREV-B STOP: the newest backup \(\S+\) was made by an earlier attempt of this chain, under the new passphrase/);
  });
});

describe('makrai-rotate-secrets.sh: the optional admin password (A7)', () => {
  it('rotates ADMIN_PASSWORD right after STAGE-A OK with its own root copy, and its own rollback gives back every byte (F2)', () => {
    const box = newBox({ admin: true });
    const { stage } = stageA(box);
    expect(stage.last, stage.all).toBe('STAGE-A OK');
    expect(stage.stdout, 'stage-a says where A7 goes').toContain('run admin-password next (A7), at an open gate (hh:15 to hh:50 UTC), before the report to the agent');
    const afterA = box.readEnv();
    const r = box.run(['admin-password']);
    expect(r.status, r.all).toBe(0);
    expect(r.stdout).toContain('A7 OK');
    expect(r.last).toBe('ADMIN-PASSWORD OK');
    expect(box.envValue('ADMIN_PASSWORD')).toMatch(/^[0-9a-f]{64}$/);
    expect(envMinus(box.readEnv(), ['ADMIN_PASSWORD'])).toEqual(envMinus(afterA, ['ADMIN_PASSWORD']));
    expect(box.mode(box.prevAdmin)).toBe('600');
    expect(box.stateGet('ADMIN_ROTATED')).toBe('1');
    // check-a expects it as the one extra changed key (the README says W2 then shows CHANGED ADMIN_PASSWORD).
    const check = box.run(['check-a']);
    expect(check.last, check.all).toBe('CHECK-A OK');
    expect(check.stdout).toContain('keydiff CHANGED ADMIN_PASSWORD');
    expect(check.stdout).toContain('ok    keydiff_names=ADMIN_PASSWORD,APP_DATABASE_URL,NEXTAUTH_SECRET,POSTGRES_PASSWORD');
    const again = box.run(['admin-password']);
    expect(again.status, 'a second rotation would overwrite the only copy of the old value').not.toBe(0);
    expect(again.stdout).toContain('PREV-STALE');
    const back = box.run(['admin-password', 'rollback']);
    expect(back.last, back.all).toBe('ADMIN-PASSWORD OK');
    expect(back.stdout).toContain('RA-admin OK');
    expect(box.readEnv()).toBe(afterA);
    expect(box.stateGet('ADMIN_ROTATED')).toBeUndefined();
    expect(leaks(box, [stage, r, check, again, back])).toEqual([]);
  });

  it('refuses, with .env untouched, when .env has no ADMIN_PASSWORD line: it never adds a key (F3, FM-11)', () => {
    const box = newBox();
    stageA(box);
    const before = box.readEnv();
    const generated = box.generated().length;
    const r = box.run(['admin-password']);
    expect(r.status).not.toBe(0);
    expect(r.last).toBe('ADMIN-PASSWORD STOP: no ADMIN_PASSWORD line: nothing to rotate');
    expect(box.readEnv()).toBe(before);
    expect(existsSync(box.prevAdmin)).toBe(false);
    expect(box.generated().length).toBe(generated);
    expect(box.stateGet('ADMIN_ROTATED')).toBeUndefined();
  });

  it('is A7: refused before STAGE-A OK and once Stage B has started, so its root copy is always shredded (F2)', () => {
    const box = newBox({ admin: true });
    const early = 'ADMIN-PASSWORD STOP: Stage A is not complete: run admin-password once it is (STAGE-A OK, or VERIFY-A OK after a stop in A6), before Stage B (A7)';
    expect(box.run(['admin-password']).last).toBe(early);
    box.run(['save-prev-a']);
    expect(box.run(['admin-password']).last, 'between save-prev-a and stage-a it would make stage-a stop').toBe(early);
    expect(stageA(box).stage.last).toBe('STAGE-A OK');
    box.setNow('2026-10-16T13:20:05Z');
    expect(box.run(['save-prev-b']).last).toBe('SAVE-PREV-B OK');
    const before = box.readEnv();
    const late = box.run(['admin-password']);
    expect(late.status).not.toBe(0);
    expect(late.last).toBe('ADMIN-PASSWORD STOP: Stage B has started: too late for admin-password, whose root copy shred-prev would not cover. Nothing was changed');
    expect(box.readEnv()).toBe(before);
    expect(existsSync(box.prevAdmin)).toBe(false);
    // Nor over a partly rolled-back Stage A.
    const partial = newBox({ admin: true });
    stageA(partial);
    expect(partial.run(['rollback-a', 'APP_DATABASE_URL']).last).toBe('ROLLBACK-A OK');
    expect(partial.run(['admin-password']).last).toBe('ADMIN-PASSWORD STOP: a partial rollback of Stage A was done (APP_DATABASE_URL): finish with rollback-a all first');
  });

  it('is taken back with rollback-a all, which removes env.prev-admin, so a second attempt can rotate it (FM-11)', () => {
    const box = newBox({ admin: true });
    stageA(box);
    rotateAdmin(box);
    expect(existsSync(box.prevAdmin)).toBe(true);
    const full = box.run(['rollback-a', 'all']);
    expect(full.last, full.all).toBe('ROLLBACK-A OK');
    expect(existsSync(box.prevAdmin), 'the copy that held the new secrets went with it').toBe(false);
    expect(box.stateGet('ADMIN_ROTATED')).toBeUndefined();
    expect(box.envValue('ADMIN_PASSWORD')).toBe(OLD.admin);
    stageA(box);
    rotateAdmin(box); // not PREV-STALE
    expect(box.envValue('ADMIN_PASSWORD')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a rollback before any rotation, and when the root copy is gone, and never reads either as the key being absent (T24-V1, T9)', () => {
    const box = newBox({ admin: true });
    const before = box.readEnv();
    const r = box.run(['admin-password', 'rollback']);
    expect(r.status).not.toBe(0);
    expect(r.last).toBe('ADMIN-PASSWORD STOP: the line was not restored');
    expect(box.readEnv(), 'the live ADMIN_PASSWORD line is still there').toBe(before);
    stageA(box);
    rotateAdmin(box);
    const mid = box.readEnv();
    rmSync(box.prevAdmin);
    const gone = box.run(['admin-password', 'rollback']);
    expect(gone.status).not.toBe(0);
    expect(gone.last).toMatch(/^ADMIN-PASSWORD STOP: the line was not restored/);
    expect(box.readEnv()).toBe(mid);
    expect(box.envValue('ADMIN_PASSWORD')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('A7 cut by a full disk: admin-password rollback refuses the gutted .env and names the recovery command; the command, then the rollback, restores (NR-2)', () => {
    const box = newBox({ admin: true });
    stageA(box);
    const afterA = box.readEnv();
    box.setWorld('sudo-cut-bytes', `${afterA.indexOf('HEALTHCHECK_PING_URL=') + 'HEALTHCHECK_PING_URL=https://hc.inv'.length}`);
    const r = box.run(['admin-password']);
    expect(r.stdout).toContain('env: WRITE FAILED');
    expect(r.last).toBe('ADMIN-PASSWORD STOP: .env may be partial: run the command printed above, then admin-password rollback. ADMIN_PASSWORD was not written');
    box.flag('sudo-cut-bytes', false);
    const cut = box.readEnv();
    const rb = box.run(['admin-password', 'rollback']);
    expect(rb.status).not.toBe(0);
    expect(rb.stdout).toContain('.env has lost lines outside the rotated keys: RESEND_API_KEY');
    expect(rb.last).toMatch(/^ADMIN-PASSWORD STOP: nothing was written\. Run the recovery command the WRITE FAILED line printed/);
    expect(box.readEnv()).toBe(cut);
    const cmd = /^env: free space, then: (.*)$/m.exec(r.stdout)?.[1] as string;
    expect(box.sh(cmd).status).toBe(0);
    const done = box.run(['admin-password', 'rollback']);
    expect(done.last, done.all).toBe('ADMIN-PASSWORD OK');
    expect(box.readEnv()).toBe(afterA);
  });

  it('refuses a usage error', () => {
    expect(newBox().run(['admin-password', 'nope']).last).toBe('ADMIN-PASSWORD STOP: usage: admin-password [rotate|rollback]');
  });

  it('is allowed in check-a as the one extra changed key, and nowhere else; check-b sees only the passphrase (F2)', () => {
    const box = newBox({ admin: true });
    stageA(box);
    rotateAdmin(box);
    expect(box.run(['check-a']).last).toBe('CHECK-A OK');
    box.writeEnv(box.readEnv().replace(/^RESEND_API_KEY=.*$/m, 'RESEND_API_KEY=re_changed'));
    const bad = box.run(['check-a']);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toContain('FAIL  keydiff_names=');
    const chain = newBox({ admin: true });
    toChainDone(chain, rotateAdmin);
    const b = chain.run(['check-b']);
    expect(b.last, b.all).toBe('CHECK-B OK');
    expect(b.stdout).toContain('ok    keydiff_names=BACKUP_PASSPHRASE');
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
      ['the new owner password reached the operator\'s shell history (T6)', (b) => writeFileSync(path.join(b.root, 'home', userInfo().username, '.bash_history'), `psql ${b.envValue('POSTGRES_PASSWORD')}\n`), 'FAIL  leak_history=1'],
      ['a new value is in a journal field other than the message: a process\'s command line (S4)', (b) => b.setWorld('journal-fields', `_CMDLINE=psql -c ${b.envValue('POSTGRES_PASSWORD')}\n`), 'FAIL  leak_journal=1'],
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

  it('reads shell histories inside the sandbox only: the operator\'s home is the stand-in\'s, not the developer\'s (T6)', () => {
    const box = afterA();
    box.run(['check-a']);
    const reads = box.argv().filter((l) => l.includes('.bash_history'));
    expect(reads.length).toBeGreaterThan(0);
    for (const l of reads) for (const f of l.split(' ').filter((t) => t.endsWith('.bash_history'))) expect(f.startsWith(box.root), f).toBe(true);
    expect(reads.some((l) => l.includes(`${box.root}/home/${userInfo().username}/.bash_history`)), 'the operator\'s history is read').toBe(true);
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
      ['the passphrase is in a journal field other than the message (S4)', (b) => b.setWorld('journal-fields', `_CMDLINE=gpg ${b.envValue('BACKUP_PASSPHRASE')}\n`), 'FAIL  leak_journal=1'],
      ['the hand backup\'s log does not end in Backup complete (F11)', (b) => b.append(path.join(b.root, 'srv/makrai/backup.log'), '[2026-10-16T13:50:00+00:00] Starting backup...\n'), 'FAIL  backup_complete_last=0'],
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

describe('makrai-rotate-secrets.sh: the next night, when only a watchdog ping failed (OW-3)', () => {
  const nightly = 'makrai-20261017-000001.sql.gz.gpg';
  const WARN_B = '[2026-10-17T00:00:10+00:00] WARNING: watchdog ping failed -- the backup is fine, but an absent ping will raise a false alarm.';
  const WARN_O = '[2026-10-17T00:30:10+00:00] WARNING: watchdog ping failed -- the copy is fine, but an absent ping will raise a false alarm.';
  const night = (box: Box, backup: string[], offsite: string[]): void => {
    box.addBackup(nightly, box.envValue('BACKUP_PASSPHRASE') as string, 1000);
    const log = (f: string, lines: string[]): void => box.append(path.join(box.root, 'srv/makrai', f), `${lines.join('\n')}\n`);
    log('backup.log', backup);
    log('offsite-copy.log', offsite);
    log('restore-test.log', [`[2026-10-17T01:00:20+00:00] fetched=${nightly} age_min=60`, '[2026-10-17T01:00:44+00:00] Restore test PASSED']);
    box.append(path.join(box.root, 'var/log/makrai/synthetic.log'), 'result=pass at=2026-10-17T07:07:04Z\n');
    box.setNow('2026-10-17T07:30:00Z');
  };
  const VERIFIED = '[2026-10-17T00:00:09+00:00] Backup verified and encrypted: x';
  const COMPLETE = '[2026-10-17T00:00:10+00:00] Backup complete.';
  const COPIED = '[2026-10-17T00:30:09+00:00] Off-site copy complete: 3 backup file(s) mirrored.';

  it('check-next and shred-prev take a nightly whose only fault is its watchdog ping, and report it', () => {
    const box = newBox();
    toChainDone(box);
    night(box, [VERIFIED, WARN_B, COMPLETE], [COPIED, WARN_O]);
    const next = box.run(['check-next']);
    expect(next.last, next.all).toBe('CHECK-NEXT OK');
    for (const l of [
      'ok    backup_complete_last=1', 'ok    backup_ping=failed',
      'info  backup_ping_note=the nightly backup was fine; only its watchdog ping failed: tell the agent',
      'ok    offsite_last_complete=1', 'ok    offsite_ping=failed',
      'info  offsite_ping_note=the nightly off-site copy was fine; only its watchdog ping failed: tell the agent',
    ]) expect(next.stdout.split('\n'), l).toContain(l);
    const shred = box.run(['shred-prev']);
    expect(shred.last, shred.all).toBe('SHRED-PREV OK');
    for (const f of [box.prevA, box.prevB, box.stagedProvision]) expect(existsSync(f), f).toBe(false);
  });

  it('still requires each nightly run to have finished, and its last line to be a watchdog line', () => {
    const cases: Array<[string, string[], string[], string]> = [
      ['the backup did not finish', [VERIFIED, WARN_B], [COPIED, WARN_O], 'FAIL  backup_complete_last=0'],
      ['the line before Backup complete. is no watchdog line', [VERIFIED, COMPLETE], [COPIED, WARN_O], 'FAIL  backup_ping=other'],
      ['the copy did not finish', [VERIFIED, WARN_B, COMPLETE], ['[2026-10-17T00:30:01+00:00] Starting off-site copy...', WARN_O], 'FAIL  offsite_last_complete=0'],
      ['the copy ends in an error, not a watchdog line', [VERIFIED, WARN_B, COMPLETE], [COPIED, '[2026-10-17T00:30:10+00:00] ERROR: something else'], 'FAIL  offsite_ping=other'],
    ];
    for (const [name, backup, offsite, want] of cases) {
      const box = newBox();
      toChainDone(box);
      night(box, backup, offsite);
      const r = box.run(['check-next']);
      expect(r.status, `${name}: ${r.all}`).not.toBe(0);
      expect(r.stdout, name).toContain(want);
      expect(box.run(['shred-prev']).last, name).toMatch(/^SHRED-PREV STOP: the next night's chain is not proven/);
      expect(existsSync(box.prevA), name).toBe(true);
    }
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
    const table = SECTION.slice(SECTION.indexOf('### The subcommands'), SECTION.indexOf("### The owner's sequence")).split('\n').filter((l) => /^\| `[a-z]/.test(l) && l.includes('|', 5));
    const names = table.map((l) => /^\| `([a-z-]+)/.exec(l)?.[1] as string);
    expect(names).toEqual(SUBCOMMANDS);
    // The rollback row names every key the script accepts, RA-app among them (FM-2).
    const rollbackA = table.find((l) => l.startsWith('| `rollback-a')) as string;
    for (const k of ['`NEXTAUTH_SECRET`', '`POSTGRES_PASSWORD`', '`APP_DATABASE_URL`', '`DATABASE_URL`', '`app`', '`all`']) expect(rollbackA, k).toContain(k);
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
    for (const key of ['NEXTAUTH_SECRET', 'POSTGRES_PASSWORD', 'APP_DATABASE_URL', 'DATABASE_URL', 'app', 'all']) {
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
    // OW-6: the read after rollback-a app is the agent's too, and is precheck with the one argument it accepts.
    expect(agent.map((l) => /makrai-rotate-secrets\.sh ([a-z-]+(?: --[a-z-]+)?) 2>&1/.exec(l)?.[1])).toEqual(['precheck', 'precheck --post-rollback', 'check-a', 'check-b', 'check-next']);
    expect(flat(SECTION)).toContain('`precheck --post-rollback` is the read after `rollback-a app`');
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
    for (const m of ['A0 OK', 'SAVE-PREV-A OK', 'B0 OK', 'SAVE-PREV-B OK', 'ESCROW-CHECK OK', 'escrow_decrypt=1', 'B2 shape=1', 'B2 OK', 'STAGE-B OK', 'PRECHECK OK', 'CHECK-NEXT OK', 'SHRED-PREV OK', 'env_prev_files=0', 'A7 OK', 'ADMIN-PASSWORD OK', 'RA-admin OK', 'RA env restored', 'RA-full OK', 'RA-nextauth OK', 'RA-owner OK', 'RA-app OK', 'RA-app-line OK', 'RA-dburl OK', 'RB-line OK', 'RB-local OK', 'PREV-CURRENT', 'PREV-STALE', 'WRITE FAILED', 'another makrai-rotate-secrets.sh command is running', 'B5 escrow not proven', 'B7 failed', 'B8 failed']) {
      expect(doc.includes(m), `README: ${m}`).toBe(true);
      expect(printsMarker(m), `script: ${m}`).toBe(true);
    }
  });

  it('states the rules of the gate and the timing the same way the script keeps them', () => {
    const doc = flat(SECTION);
    expect(doc).toContain('between hh:15 and hh:50 UTC');
    expect(doc).toContain('hours 06, 22, 23, 00, 01, 02 or 03 UTC');
    // OW-1: the admin rollback writes .env, so it keeps the gate; the one exception is rolling Stage A back.
    expect(doc).toContain('`rollback-b` and `admin-password rollback` keep the gate like the stages. Rolling Stage A back is the exception');
    expect(SRC).toContain("case $h in 6|22|23|0|1|2|3)");
    expect(SRC).toContain('[ "$m" -ge 15 ] && [ "$m" -le 50 ]');
    // F6, FM-8: the real deadlines. Stage B starts by 20:50, a rollback by 21:50 (the gate), and the decision is made by about 21:30.
    expect(doc).toContain('Start Stage B no later than 20:50 UTC');
    expect(SRC).toContain('Stage B starts no later than 20:50 UTC');
    expect(doc).toContain('`rollback-b` is gated like a stage, so it can start only by 21:50 UTC');
    expect(doc).toContain('decided by about 21:30 UTC');
    expect(doc).not.toContain('23:00 UTC');
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
    // OW-4: stage-b's own reminder, quoted in B2, gives the same order: relabel (B2), escrow (B3), then the chain.
    const hint = 'Now relabel the old entry (README B2), escrow the new value (B3), then run backup-chain.';
    expect(b2).toContain(`the reminder \`${hint}\``);
    expect(fn('cmd_stage_b')).toContain(`say '${hint}'`);
    expect(hint.indexOf('relabel')).toBeLessThan(hint.indexOf('escrow'));
    expect(b2).toContain('If `stage-b` stopped, leave the label as it was');
    expect(doc).toContain('username must differ from both existing entries');
    expect(doc).toContain('"STALE: does not match server"');
    expect(doc).toContain('Paste at the script\'s own hidden prompt and press Enter; the script reads one line');
  });

  it('gives per-rollback expectations for the precheck, a stop rule for B7 and names every row it points at (T24-V18)', () => {
    const doc = flat(SECTION);
    // F8: the owner role's rollback alone leaves the new NEXTAUTH_SECRET in .env.
    expect(doc).toContain('After `rollback-a all`, or after `rollback-a POSTGRES_PASSWORD` followed by `rollback-a NEXTAUTH_SECRET`, it must read as before Stage A');
    expect(doc).toContain('`postgres_vs_env` reads DIFFERENT, so run `precheck --post-rollback`');
    expect(doc).toContain('| `B7 failed` |');
    expect(doc).toContain('wait 2 minutes and run `backup-chain` once more');
    for (const row of ['`B4 failed`', '`B5 escrow not proven`', '`B7 failed`', '`NEWBACKUP` is on the box']) expect(doc, row).toContain(`| ${row}`);
    expect(doc).toContain('after the copies are shredded there is no rollback');
    expect(doc).toContain('which must start by 21:50 UTC on the day of Stage B');
    expect(doc).toContain('`rollback-b` is gated like a stage (so it starts by 21:50 UTC, not later), and refuses once a backup named after the newest file this chain made exists');
  });

  it('puts admin-password in the owner sequence as A7: after STAGE-A OK, before the post-check, and only if the line exists (F2, F3)', () => {
    const doc = flat(SECTION);
    const stageA = doc.indexOf('**Stage A.**');
    const a7 = doc.indexOf('**A7 (only if W1 reported `key_ADMIN_PASSWORD_lines=1`).**');
    const w2 = doc.indexOf("**W2. The agent's post-check A**");
    const stageB = doc.indexOf('**Stage B.**');
    expect(stageA > -1 && stageA < a7 && a7 < w2 && w2 < stageB, 'A7 sits between Stage A and W2').toBe(true);
    const block = doc.slice(a7, w2);
    expect(block).toContain('Once Stage A is complete (`STAGE-A OK`, or `VERIFY-A OK` after a stop in A6), at the next open gate, and before W2 and Stage B');
    expect(block, 'both reminders say the gate').toContain('both say `at an open gate`');
    expect(SRC).toContain("run admin-password next (A7), at an open gate (hh:15 to hh:50 UTC), before the report to the agent.");
    expect(block).toContain('Expect `A7 OK` and `ADMIN-PASSWORD OK`');
    expect(block).toContain('`no ADMIN_PASSWORD line: nothing to rotate`');
    expect(block).toContain('once Stage B has started or `shred-prev` has run');
    expect(fencedLines(SECTION).some((l) => l.endsWith('makrai-rotate-secrets.sh admin-password')), 'the command is in a block').toBe(true);
    expect(doc, 'the paragraph after shred-prev is gone').not.toContain('**Optional: `ADMIN_PASSWORD`.**');
    expect(doc).toContain('`CHANGED ADMIN_PASSWORD` if A7 ran');
    expect(SRC).toContain('no ADMIN_PASSWORD line: nothing to rotate');
  });

  it('gives each Stage A stop its own forward and back, with rollback-a app for an outage (F4, F5, FM-2, FM-7)', () => {
    const rows = SECTION.split('\n').filter((l) => l.startsWith('| '));
    const row = (start: string): string => {
      const r = rows.find((l) => l.startsWith(start));
      expect(r, start).toBeDefined();
      return r as string;
    };
    expect(row('| A5 failed |')).toContain('`stage-a` (retries the restart)');
    expect(row('| A5 failed |')).toContain('`rollback-a app` (RA-app)');
    const a6 = row('| `A6 health=bad`');
    expect(a6).toContain('`verify-a`');
    expect(a6).toContain('`rollback-a app`');
    expect(row('| `WRITE FAILED ... kept in <tmp>` |')).toContain('run the command it prints, then `rollback-a all`, then `stage-a`');
    expect(row('| `.env is not whole`')).toContain('`rollback-a all`');
    expect(row('| A1, A2 (no value generated)')).not.toContain('write failed');
    expect(row('| `APP-URL STOP`')).toContain('so there is no restart');
    const doc = flat(SECTION);
    expect(doc).toContain('`rollback-a app` prints `APP-PROVISION OK`, `RA-app OK` and `ROLLBACK-A OK`');
    expect(doc).toContain('`rollback-a app` always runs `up`, once');
    // The script says the same where it matters.
    expect(SRC).toContain('Back: rollback-a APP_DATABASE_URL (the running container is left alone)');
    expect(SRC).toContain('rollback-a app (RA-app: both lines back, makrai_app back, one restart)');
  });

  it('says what to do when check-a or check-b fails, and how a later rotation starts clean (F7)', () => {
    const doc = flat(SECTION);
    for (const row of ['| `tcp_owner_env=REFUSED` |', '| an old value `ACCEPTED`', '| a leak count above 0', '| an unexpected `keydiff` line |']) expect(doc, row).toContain(row);
    expect(doc).toContain('`fix-owner`, then `check-a` again');
    expect(doc).toContain('a fresh, reviewed run, never an in-script retry');
    expect(doc).toContain('`shred-prev` renames `/root/.makrai-rotate-state` to `.makrai-rotate-state.done-<UTC>`');
    expect(SRC).toContain('arch="$STATE.done-$(date -u +%Y%m%dT%H%M%SZ)"');
    expect(doc).toContain("`rollback-a all` (RA-full) restores the whole `.env` from `/root/env.prev-a`");
  });

  it('gives the release facts the precheck reports as info, with the values to compare them to (F10)', () => {
    const doc = flat(SECTION);
    expect(doc).toContain('`checkout_tag=v0.5.1`');
    expect(doc).toContain(`\`lib_sha256_prefix=${sha256('ops/host/makrai-lib.sh').slice(0, 12)}\``);
    for (const k of ['env_stat=600 regular file', 'env_owner_is_the_checkouts_owner=yes', 'synthetic_last_result=result=pass', '`synthetic_last_age_min` at most 70', '`logging_collector=off`']) expect(doc, k).toContain(k);
    for (const c of ['chk synthetic_last_age_min', 'chk env_owner_is_the_checkouts_owner', 'chk env_stat', 'info checkout_tag', 'info lib_sha256_prefix']) expect(SRC, c).toContain(c);
  });

  it('says that a ping that failed is accepted and reported by check-b, which still requires the run to have finished (F11)', () => {
    const doc = flat(SECTION);
    expect(doc).toContain('`check-b` then reports `backup_ping=failed`, with a note, and still passes');
    expect(doc).toContain('`backup_ping=failed` is reported and not judged either (the accepted B4 case), but the run must have ended in `Backup complete.`');
    expect(SRC).toContain("chk backup_complete_last");
    // OW-2: the off-site copy's ping, in B7 and in check-b; OW-3: both nightly pings in check-next.
    expect(doc).toContain('prints `B7 OK (the copy is fine, only its watchdog ping failed: tell the agent)` the same way, and `check-b` then reports `offsite_ping=failed`, with a note');
    expect(SRC).toContain("say 'B7 OK (the copy is fine, only its watchdog ping failed: tell the agent)'");
    expect(doc).toContain('So is `offsite_ping=failed` (the accepted B7 case), with `offsite_last_complete=1`.');
    expect(doc).toContain('A nightly backup or copy whose only fault is its watchdog ping still passes: `check-next` requires the run to have finished (`backup_complete_last=1`, `offsite_last_complete=1`) and reports `backup_ping=failed` or `offsite_ping=failed`');
  });

  it('quotes what stage-a prints before T0, says where a value may be, and marks escrow-check as state only (F12, S7)', () => {
    const doc = flat(SECTION);
    expect(doc).toContain('`provision script staged, sha256 aa8aea6818dc`');
    expect(SRC).toMatch(/^readonly PROV_SHA256=aa8aea6818dc[0-9a-f]{52}$/m);
    expect(doc).toContain('`now hh:mmZ, scheduled jobs running: 0, package upgrades running: 0`');
    const where = "A value is never in argv, logs or display. It is in shell variables, in root-owned temp files in `/root`, and, for the length of one command, in the environment of short-lived processes run as root (awk, the provisioning script and its docker CLI, psql in the postgres container) or as `.env`'s owner (the operator's jobs, through `load_env`).";
    expect(doc).toContain(where);
    // The header of the script says it in the same words.
    expect(flat(SRC.replace(/\n#\s*/g, ' '))).toContain("short-lived processes run as root (awk, the provisioning script and its docker CLI, psql in the postgres container) or as .env's owner (the operator's jobs, through load_env)");
    const escrow = SECTION.split('\n').find((l) => l.startsWith('| `escrow-check pre')) as string;
    expect(escrow).toContain('state only');
  });

  it('says the installed copy refuses the test hook, what a run that honours it prints, and that it refuses a .env of the wrong mode (S2, S3, F13)', () => {
    const doc = flat(SECTION);
    expect(doc).toContain('`MAKRAI_ROTATE_ROOT` is a test hook');
    expect(doc).toContain('The installed copy (`/usr/local/sbin/makrai-rotate-secrets.sh`) refuses it and exits 2.');
    expect(doc).toContain('prints `WARNING rotate_root=<dir> (test tree)` as its first line');
    expect(doc).toContain('It refuses to write a `.env` that is not mode 600.');
  });

  it('tells the owner to paste a password only at the hidden prompt, and what the chain does after its start (S5, FM-12, FM-9, FM-1)', () => {
    const doc = flat(SECTION);
    expect(doc).toContain("Copy the new entry's password only when the hidden prompt is shown, and paste nothing before it.");
    expect(doc).toContain('is dropped when the chain stops, not run by the shell');
    expect(doc).toContain('**The chain after its start.**');
    expect(doc).toContain('`backup-chain` checks the whole gate once, at its start.');
    expect(doc).toContain('stops with `nothing left the server`');
    expect(doc).toContain('it refuses while a hold is set');
    expect(doc).toContain('`backup-chain` refuses when `BACKUP_PASSPHRASE` in `.env` is the one `env.prev-b` has');
    expect(doc).toContain('it lists every nightly-form file named after `LASTOLD`');
    expect(doc).toContain('`save-prev-b` will not take such a file as the cut-over');
  });

  it('documents the guards of the second round: the lock of verify-a, a cut-short .env, the night hours, the retry, the outage path (N1-N7, NF-1, NF-2, NF-6, NF-7)', () => {
    const doc = flat(SECTION);
    const rows = SECTION.split('\n').filter((l) => l.startsWith('| `'));
    const verify = rows.find((l) => l.startsWith('| `verify-a`')) as string;
    expect(verify).toContain('state only (records A_DONE when A6 passes after a stop in A6');
    expect(verify).toContain('takes the lock');
    // N1, NF-2: a write cut in the middle of a line
    expect(doc).toContain('So is a `.env` that ends part-way through a line (a disk that filled in the middle of a line)');
    expect(doc).toContain('The restore excuses a cut only when `.env` is, byte for byte, the start of `env.prev-a`, or the start of an intended file that a failed write kept (`/root/.t24-env.*`, or the deploy\'s `/srv/makrai/app/.env.new`) and that holds no change by someone else');
    // RR3-1, RR3-2: an empty .env is a cut too; the deploy's own kept file, and its own recovery command.
    expect(doc).toContain('So is an empty `.env` (a disk that was full before the first byte).');
    expect(doc).toContain("For `.env.new` it says to finish the deploy's write first, with set_env's last step (`cat /srv/makrai/app/.env.new > /srv/makrai/app/.env && rm -f /srv/makrai/app/.env.new`), then roll back key by key.");
    expect(doc).toContain("or that a deploy's `set_env` left `/srv/makrai/app/.env.new` because its write into `.env` failed");
    expect(SRC).toContain('readonly DEPLOY_NEW=$APP/.env.new');
    expect(doc).toContain('If its own write is cut short, even to nothing, it prints the command that finishes it');
    // OW-9: verify-a after a stop in A6 completes Stage A, and A7 follows it.
    expect(rows.find((l) => l.startsWith('| `A6 health=bad`'))).toContain('its `VERIFY-A OK` completes Stage A (then A7, if it applies)');
    // NR-1: a deploy's change lying after the cut point is in the kept file, and the restore refuses.
    expect(doc).toContain('the kept file does, and then the restore refuses, naming the key, and says to run the recovery command the WRITE FAILED line printed, then roll back key by key');
    expect(doc).toContain("test -s /root/env.prev-a && sudo -u <operator> sh -c 'cat > \"$1\"' sh <.env> < /root/env.prev-a");
    expect(doc).toContain('A per-key rollback (and `rollback-b`, and `admin-password rollback`) refuses, writing nothing, a `.env` that has lost lines outside the rotated keys or ends part-way through a line');
    // NR-4, NR-1: the recovery command first, rollback-a all second, and what is left once Stage B has started.
    expect(doc).toContain('The recovery command the WRITE FAILED line printed comes first, because it makes `.env` the intended file; `rollback-a all` comes second, only if nothing else changed `.env`, and it is refused once Stage B has started, when the lost lines are put back from `env.prev-a` by hand');
    // NR-2: a write cut by a full disk in B2 and in A7.
    expect(doc).toContain('`STAGE-B STOP: .env may be partial: run the command printed above, then rollback-b line, then stage-b again. BACKUP_PASSPHRASE was not written`');
    expect(doc).toContain('`ADMIN-PASSWORD STOP: .env may be partial: run the command printed above, then admin-password rollback. ADMIN_PASSWORD was not written` (A7)');
    expect(doc).toContain('`rollback-b` (either mode) refuses a gutted `.env` and says so');
    // N4: the night hours the chain keeps out of, and the retry when a nightly came after NEWBACKUP
    expect(doc).toContain('not reached the nightly hours (23:40 UTC to 03:59, and the hour 06;');
    expect(doc).not.toContain('(06, 22, 23, 00, 01, 02, 03 UTC) and that no backup');
    expect(doc).toContain('If a nightly made after `NEWBACKUP` exists');
    expect(doc).toContain('run `backup-chain --fresh` (B4 to B8 again)');
    // N2, NF-1: the retry after a rollback
    expect(doc).toContain("A `stage-b` that writes a passphrase, and `rollback-b line`, forget the earlier attempt's `NEWBACKUP` and escrow proof");
    expect(doc).toContain('takes a new hand backup under the new value and asks for its escrow at B5');
    // N5, NF-7: the outage path
    expect(doc).toContain('does not wait for the hour or minute window, but it still stops while a scheduled job or a package upgrade runs');
    expect(doc).toContain('`rollback-a app` ends the outage at once');
    expect(doc).toContain('before that that `makrai_app` was not touched and `stage-a` carries on');
    // N3: the agent's closing read after shred-prev
    expect(doc).toContain('it prints `rotation_closed=<archive>` and `env_prev_files=0`');
    expect(SRC).toContain('info rotation_closed');
    // OW-7: after shred-prev, a refusal names the closed rotation, not a step that ran.
    expect(doc).toContain('It cannot be run twice: the second says `the rotation is closed (<archive>); nothing to shred`.');
    expect(doc).not.toContain('the second finds no state');
    expect(fn('cmd_shred_prev')).toContain("closed_stop 'nothing to shred'");
    expect(fn('closed_stop')).toContain('stop "the rotation is closed (${arch##*/}); $1"');
    for (const c of ['check-a', 'check-b', 'save-prev-b', 'stage-b', 'backup-chain']) expect(doc, c).toContain(`\`${c}\``);
    // N7: Compose's failure lines
    expect(doc).toContain('`Container ... Error`, `container ... is unhealthy`');
    expect(doc).toContain('see: docker ps -a --filter name=docker-nextjs-1; docker logs --tail 50 docker-nextjs-1');
  });

  it('names every check line the way the script prints it, and says what a keydiff count line is (OW-5)', () => {
    // The names a check prints: `chk NAME` / `info NAME`, a name built from a variable (`chk "key_${k}_lines"`) as a pattern,
    // and the NAME= markers printed by say.
    const printed = new Set<string>();
    const templates: RegExp[] = [];
    for (const m of SRC.matchAll(/\b(?:chk|info) ("?)([a-z][A-Za-z0-9_${}]*)\1 /g)) {
      if (m[2].includes('$')) templates.push(new RegExp(`^${m[2].replace(/\$\{?[A-Za-z_]+\}?/g, '[A-Za-z_]+')}$`));
      else printed.add(m[2]);
    }
    for (const m of SRC.matchAll(/\bsay "([A-Za-z][A-Za-z0-9_]*)=/g)) printed.add(m[1]);
    const known = (n: string): boolean => printed.has(n) || templates.some((t) => t.test(n));
    expect(known('postgres_container_POSTGRES_PASSWORD_vs_env')).toBe(true);
    expect(known('key_ADMIN_PASSWORD_lines')).toBe(true);
    const inline = flat(SECTION.replace(/```[\s\S]*?```/g, '')).match(/`[^`]+`/g)?.map((t) => t.slice(1, -1)) ?? [];
    const bad: string[] = [];
    for (const t of inline) {
      const eq = t.indexOf('=');
      if (eq > 0) {
        // `name=value`: a name the script prints; `MARKER name=value`: text the script prints literally (A6 health=, B7 rc=).
        const before = t.slice(0, eq);
        if (/^[A-Za-z][A-Za-z0-9_]*$/.test(before) ? !(known(before) || SRC.includes(`${before}=`)) : !SRC.includes(`${before}=`)) bad.push(t);
      } else if (/^[a-z][a-z0-9]*(_[A-Za-z0-9]+){2,}$/.test(t)) {
        // a bare check name, or the stem of one (`postgres_vs_env`)
        if (!known(t) && ![...printed].some((n) => n.startsWith(`${t}_`))) bad.push(t);
      }
    }
    expect(bad, 'quoted in the README, printed by no check').toEqual([]);
    const doc = flat(SECTION);
    expect(doc).toContain('The `keydiff SAME-count N` line after them is a count of the keys that did not change, not a key line');
    expect(SRC).toContain('print "SAME-count " s');
    for (const n of ['postgres_container_POSTGRES_PASSWORD_vs_env=DIFFERENT', 'journal_nextjs_jwt_session_errors', 'offsite_failed_since_TB', 'restore_failed_since_TB']) expect(doc, n).toContain(`\`${n}\``);
  });

  it('says what escrow-check new is for, in the table and the header, as its refusal does (OW-8)', () => {
    const row = SECTION.split('\n').find((l) => l.startsWith('| `escrow-check pre')) as string;
    expect(row).toContain('`pre` is B1. `new` works only after B4: it proves B5 for the recorded hand backup, so `backup-chain` then skips its own prompt (before B4, `backup-chain` asks at its prompt)');
    expect(row).not.toContain('B1, B5:');
    const header = SRC.split('\nset -Eeuo')[0];
    expect(header).toContain('# escrow-check pre|new|<file> B1 (pre); B5');
    expect(header).toContain('(new, only after');
    expect(SRC).toContain('escrow-check new proves B5 for the hand backup once B4 has made it; before that, backup-chain asks for the new value at its own prompt');
  });

  it('says that the four checks write nothing, and what rollback-a all will not undo (S1, FM-4)', () => {
    const doc = flat(SECTION);
    expect(doc).toContain('None of the four writes anything');
    expect(doc).toContain('`precheck` runs `git --no-optional-locks status`');
    expect(doc).toContain('when `.env` has a key CHANGED or ADDED since `env.prev-a` other than the rotated ones');
    expect(doc).toContain('A key that is missing is fine: that is the partial write this restore exists for.');
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
    // S7: the Rules bullet says where a value may be, as the section does.
    expect(flat(README)).toContain("a value is in the environment only of short-lived processes run as root or as `.env`'s owner");
  });
});
