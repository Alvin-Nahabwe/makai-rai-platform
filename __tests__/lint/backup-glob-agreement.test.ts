import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * The scripts that touch backup files must look for the files the backup
 * script actually writes.
 *
 * On 2026-08-30 encryption was added: the backup script began writing
 * `makrai-<ts>.sql.gz.gpg` instead of `makrai-<ts>.sql.gz`. Its own globs were
 * updated. `makrai-backup-check.sh` was not — it kept searching for
 * `makrai-*.sql.gz`, matched nothing, and at 06:00 UTC the next morning
 * reported NO BACKUPS AT ALL and emailed the owner, while nine perfectly good
 * encrypted backups sat in the directory beside it.
 *
 * A false alarm is the specific way a dead-man's switch dies. Its whole value
 * is that a message means something; one that fires when everything is fine
 * teaches the reader to ignore the next one, and the next one is real. That
 * makes this worse than the missing-alerting state it replaced.
 *
 * The off-site copy and the restore test are two more scripts on the same
 * filename convention, and they fail in the opposite, quieter way: a glob that
 * matches nothing copies nothing, and the run still exits 0.
 *
 * Several scripts, one filename convention, nothing tying them together — the
 * shape AGENTS.md §3 describes as exhaustive lists nothing checks for contact.
 * This is the check for contact.
 *
 * The scripts are read from `ops/host/`, where they are tracked. They used to
 * be parsed out of the copies pasted into `docs/runbooks/backup-restore.md`,
 * which could say something different from the file the host ran.
 */

const HOST_DIR = 'ops/host';
const BACKUP = 'makrai-backup.sh';
const CHECK = 'makrai-backup-check.sh';
const OFFSITE = 'makrai-offsite-copy.sh';
const RESTORE = 'makrai-restore-test.sh';

function source(file: string): string {
  expect(existsSync(`${HOST_DIR}/${file}`), `${HOST_DIR}/${file} does not exist`).toBe(true);
  return readFileSync(`${HOST_DIR}/${file}`, 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
}

/**
 * Every `-name '...'` (find) and `--include='...'` (rsync) pattern in a script's
 * code. Comment lines are skipped: the watchdog's header quotes the old, wrong
 * glob in prose, and that is not a pattern it searches for.
 */
function globs(file: string): string[] {
  return [...source(file).matchAll(/(?:-name\s+|--include=)'([^']+)'/g)].map((m) => m[1]);
}

/** The filename the backup script writes, taken from its BACKUP_FILE assignment. */
function producedExample(): string {
  const produced = source(BACKUP).match(/BACKUP_FILE="\$\{BACKUP_DIR\}\/(makrai-\$\{TIMESTAMP\}[^"]*)"/);
  expect(produced, 'could not find the BACKUP_FILE assignment').not.toBeNull();
  return produced![1].replace('${TIMESTAMP}', '20260831-000001');
}

function matches(glob: string, example: string): boolean {
  const re = new RegExp(
    '^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
  );
  return re.test(example);
}

describe('the scripts that touch backup files agree on filenames', () => {
  it('finds globs in every script, so a parser failure cannot pass vacuously', () => {
    for (const file of [BACKUP, CHECK, OFFSITE, RESTORE]) {
      expect(globs(file).length, `no globs found in ${file}`).toBeGreaterThan(0);
    }
  });

  it('has a watchdog glob that matches the file the backup script writes', () => {
    const example = producedExample();
    expect(
      globs(CHECK).some((g) => matches(g, example)),
      `the watchdog looks for ${JSON.stringify(globs(CHECK))} but the backup script writes ` +
        `"${example}". It will find nothing and report NO BACKUPS while backups are fine — ` +
        `a false alarm, which is how a dead-man's switch stops being believed.`,
    ).toBe(true);
  });

  it('has a prune glob that also matches, or old backups accumulate forever', () => {
    const example = producedExample();
    expect(
      globs(BACKUP).some((g) => matches(g, example)),
      `no glob in the backup script matches its own output "${example}" — the prune and the ` +
        `size comparison would both silently do nothing.`,
    ).toBe(true);
  });

  it('has an off-site glob and a restore glob that match too, or nothing is copied or tested', () => {
    const example = producedExample();
    for (const file of [OFFSITE, RESTORE]) {
      expect(
        globs(file).some((g) => matches(g, example)),
        `${file} selects ${JSON.stringify(globs(file))} but the backup script writes "${example}". ` +
          `It would copy (or restore) nothing and still exit 0.`,
      ).toBe(true);
    }
  });

  it('has a restore filter that accepts the name the backup writes and rejects odd ones', () => {
    // The restore test takes the newest of the names this filter lets through. A
    // looser one would pick a hand-named file, or a name with a path in it, as
    // "newest"; a stricter one would find nothing.
    const filter = /grep -E '(\^makrai-[^']+)'/.exec(source(RESTORE));
    expect(filter, 'the restore test has no filter on the exact timestamped name').not.toBeNull();
    const re = new RegExp(filter![1]);
    const example = producedExample();
    expect(re.test(example), `the restore filter ${re} rejects "${example}", which the backup writes`).toBe(true);
    for (const odd of [
      'makrai-pre-migration.sql.gz.gpg',
      '../makrai-20261008-000001.sql.gz.gpg',
      'makrai-20261008-000001.sql.gz',
    ]) {
      expect(re.test(odd), `the restore filter ${re} accepts "${odd}"`).toBe(false);
    }
  });
});
