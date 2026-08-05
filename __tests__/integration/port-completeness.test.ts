import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { ROUTE_ACTIONS, NON_ACTION_ROUTES } from '../../lib/authz/routeActions';

/**
 * Task 7's completeness checklist, generated from disk rather than
 * hand-written (D-103: a hand-written list that must be complete is a
 * latent defect with a timestamp). These two tests enumerate the real
 * `app/api/**\/route.ts` tree and the real `app`/`lib`/`components` source
 * tree on every run — they fail on any file that falls outside the ported
 * boundary, including one added after this task closes.
 */

function isDeclared(f: string): boolean {
  const actions = ROUTE_ACTIONS[f];
  if (actions && Object.keys(actions).length > 0) return true;
  return NON_ACTION_ROUTES.includes(f);
}

describe('port completeness', () => {
  it('every route declares an action in ROUTE_ACTIONS (or is a documented non-action route)', () => {
    const files = execSync(`find app/api -name route.ts`).toString().trim().split('\n').filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    const undeclared = files.filter((f) => !isDeclared(f));
    expect(undeclared).toEqual([]); // the failure message names the file
  });

  it('no file outside lib/data imports lib/db', () => {
    const hits = execSync(
      `grep -rln "from '@/lib/db'\\|from '.*\\/db'" app lib components --include=*.ts --include=*.tsx || true`,
    )
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((f) => !f.startsWith('lib/data/'));
    expect(hits).toEqual([]);
  });
});
