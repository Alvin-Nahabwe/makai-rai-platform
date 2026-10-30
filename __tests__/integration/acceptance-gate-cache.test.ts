import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { buildOrg } from '../helpers/recordFixture';
import { sessionFor, clearSession } from '../helpers/authSession';

/**
 * C4 CR-6: an org page runs requireIdentity three times (the (authenticated) layout, the org layout
 * and the page), so gate 3 reads the acceptances through React `cache()`, once per request.
 *
 * Outside a React server render `cache()` does not memoise, so this file stands one in for it: the
 * mocked `cache` keeps one table for the whole file, as React keeps one per request. What is pinned
 * is that both gates read through `cache()`, not React's own memoisation.
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const cache = <A extends unknown[], R>(fn: (...args: A) => R) => {
    const seen = new Map<string, R>();
    return (...args: A): R => {
      const key = JSON.stringify(args);
      if (!seen.has(key)) seen.set(key, fn(...args));
      return seen.get(key)!;
    };
  };
  return { ...real, cache };
});
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-pathname': '/orgs/x/dashboard' }) }));
vi.mock('@/lib/data/acceptances', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/data/acceptances')>();
  return { ...real, missingAcceptances: vi.fn(real.missingAcceptances) };
});

const { requireIdentity, requireIdentityForApi } = await import('@/lib/auth/identity');
const { missingAcceptances } = await import('@/lib/data/acceptances');

beforeEach(async () => {
  await resetDb();
  clearSession();
  vi.mocked(missingAcceptances).mockClear();
});

describe('gate 3 reads the acceptances once per request (CR-6)', () => {
  it('FR-ACC-04: the layouts and the page of one request read the acceptances once, through React cache()', async () => {
    const fx = await buildOrg();
    sessionFor(fx.members.owner.userId);
    await requireIdentity();
    await requireIdentity();
    await requireIdentity();
    await requireIdentityForApi();
    expect(missingAcceptances).toHaveBeenCalledTimes(1);
    expect(missingAcceptances).toHaveBeenCalledWith(fx.members.owner.userId);
  });
});
