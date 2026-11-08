import { describe, expect, it } from 'vitest';
import { shText } from '../helpers/spawnText';

/**
 * NFR-SEC-13: the reminder job has one production caller, the internal route (OPS, route 40).
 * This file proves no other file calls it. It does not prove nginx refuses the path or that the
 * route checks its token: those are OPS's FR-OPS-02 tests.
 */

/** Repository files under `roots` whose text contains `needle` (a fixed string); a root that does not exist is skipped. */
function grepFiles(needle: string, roots: string[]): string[] {
  const out = shText(`git grep -l -F --untracked -e '${needle.replace(/'/g, `'\\''`)}' -- ${roots.map((r) => `'${r}'`).join(' ')} || true`);
  return out.split('\n').filter(Boolean).sort();
}

describe('the reminder job\'s only trigger', () => {
  it('NFR-SEC-13 FR-OPS-02: runReminders has no production caller but the internal route', () => {
    const callers = grepFiles('runReminders', ['app', 'lib', 'components', 'proxy.ts']).filter((f) => f !== 'lib/reminders/job.ts');
    expect(callers.filter((f) => f !== 'app/api/internal/reminders/route.ts')).toEqual([]);
  });

  it('NFR-SEC-13: the job module is reachable from no page or client component', () => {
    expect(grepFiles("from '@/lib/reminders/job'", ['app', 'components']).filter((f) => !f.startsWith('app/api/internal/'))).toEqual([]);
  });

  it('NFR-SEC-13 (self-test): the search finds the job in its own file, so an empty result means no caller', () => {
    expect(grepFiles('runReminders', ['lib'])).toContain('lib/reminders/job.ts');
  });
});
