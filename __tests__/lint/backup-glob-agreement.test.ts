import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The watchdog must look for the files the backup script actually writes.
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
 * Two scripts, one filename convention, in one document, with nothing tying
 * them together — the shape AGENTS.md §3 describes as two exhaustive lists
 * nothing checks for contact. This is the check for contact.
 */

const RUNBOOK = readFileSync('docs/runbooks/backup-restore.md', 'utf8');

/**
 * Every `-name '...'` pattern, grouped by the script it belongs to.
 *
 * Split on shebangs rather than on marker phrases. The first version scanned
 * line by line for a phrase identifying each script, and the backup script
 * contains a comment mentioning "Dead-man's switch" — describing the watchdog
 * it pings — so its own globs were attributed to the other script and the test
 * reported the wrong thing. A shebang is an unambiguous boundary; a phrase in a
 * comment is not.
 */
function globsByScript(): Record<string, string[]> {
  const chunks = RUNBOOK.split('#!/usr/bin/env bash').slice(1);
  const out: Record<string, string[]> = {};
  for (const chunk of chunks) {
    const body = chunk.split('```')[0];
    const name = /Dead-man's switch for/.test(body.slice(0, 400)) ? 'check' : 'backup';
    const globs = [...body.matchAll(/-name\s+'([^']+)'/g)].map((m) => m[1]);
    if (globs.length) (out[name] ??= []).push(...globs);
  }
  return out;
}

describe('the backup script and the watchdog agree on filenames', () => {
  it('finds globs in both scripts, so a parser failure cannot pass vacuously', () => {
    const g = globsByScript();
    expect(Object.keys(g).sort(), 'did not locate both scripts').toEqual(['backup', 'check']);
    expect(g.backup.length, 'no globs found in the backup script').toBeGreaterThan(0);
    expect(g.check.length, 'no globs found in the watchdog').toBeGreaterThan(0);
  });

  it('has a watchdog glob that matches the file the backup script writes', () => {
    const g = globsByScript();
    // What the backup script produces, taken from the runbook rather than
    // assumed: the BACKUP_FILE assignment.
    const produced = RUNBOOK.match(/BACKUP_FILE="\$\{BACKUP_DIR\}\/(makrai-\$\{TIMESTAMP\}[^"]*)"/);
    expect(produced, 'could not find the BACKUP_FILE assignment').not.toBeNull();
    const example = produced![1].replace('${TIMESTAMP}', '20260831-000001');

    const matches = (glob: string) => {
      const re = new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      return re.test(example);
    };

    expect(
      g.check.some(matches),
      `the watchdog looks for ${JSON.stringify(g.check)} but the backup script writes ` +
        `"${example}". It will find nothing and report NO BACKUPS while backups are fine — ` +
        `a false alarm, which is how a dead-man's switch stops being believed.`,
    ).toBe(true);
  });

  it('has a prune glob that also matches, or old backups accumulate forever', () => {
    const g = globsByScript();
    const produced = RUNBOOK.match(/BACKUP_FILE="\$\{BACKUP_DIR\}\/(makrai-\$\{TIMESTAMP\}[^"]*)"/);
    const example = produced![1].replace('${TIMESTAMP}', '20260831-000001');
    const matches = (glob: string) => {
      const re = new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      return re.test(example);
    };
    expect(
      g.backup.some(matches),
      `no glob in the backup script matches its own output "${example}" — the prune and the ` +
        `size comparison would both silently do nothing.`,
    ).toBe(true);
  });
});
