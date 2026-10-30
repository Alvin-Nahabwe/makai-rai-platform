import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

/**
 * NFR-SEC-05 (SRS line 2925): "exactly one code path inserts into `users` outside the seed script",
 * enumerated over the tracked files of app, lib and components (the seed is prisma/seed.ts, outside
 * them). And SRS 9.5 step 6: no code writes consent_records."ipAddress" again; the database trigger
 * consent_records_null_ip (migration *_v060_consent_ip_null) is the second line.
 *
 * The child runs `git grep` with NO_COLOR=1 and no FORCE_COLOR, and escape sequences are stripped,
 * so a colour setting in the environment cannot change the lines compared below.
 */
function grepFiles(roots: readonly string[], pattern: RegExp): Array<{ file: string; line: string }> {
  const { FORCE_COLOR: _force, ...env } = process.env;
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-n', '-I', ...(pattern.flags.includes('i') ? ['-i'] : []), '-E', pattern.source, '--', ...roots],
      { encoding: 'utf8', env: { ...env, NO_COLOR: '1' } });
  } catch (e) {
    // git grep exits 1 when nothing matches; anything else is a real failure.
    if ((e as { status?: number }).status !== 1) throw e;
  }
  return out.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').split('\n').filter(Boolean).map((l) => {
    const [file, , ...rest] = l.split(':');
    return { file, line: rest.join(':') };
  });
}

describe('account creation and acceptance rows have one write path each', () => {
  it('NFR-SEC-05: exactly one code path inserts into users outside the seed script', () => {
    const hits = grepFiles(['app', 'lib', 'components'], /\.user\.(create|createMany|upsert)\(|INSERT INTO\s+"?users"?/i);
    expect(hits.map((h) => h.file)).toEqual(['lib/data/preauth.ts']);
    expect(hits).toHaveLength(1);
  });

  it('FR-ACC-03 NFR-SEC-05: no code under app, lib or components names ipAddress', () => {
    expect(grepFiles(['app', 'lib', 'components'], /ipAddress/).map((h) => h.file)).toEqual([]);   // the database trigger of Task 3b is the second line
  });

  it('NFR-SEC-05 (lint self-test): the patterns find what they look for', () => {
    expect(grepFiles(['__tests__/helpers'], /\.user\.(create|createMany|upsert)\(/).length).toBeGreaterThan(0);
    expect(grepFiles(['__tests__/integration'], /ipAddress/).length).toBeGreaterThan(0);
  });
});
