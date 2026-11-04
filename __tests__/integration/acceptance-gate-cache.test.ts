import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { buildOrg } from '../helpers/recordFixture';
import { sessionFor, clearSession } from '../helpers/authSession';

/**
 * One request reads an account's acceptance rows once (FR-ACC-04): an org page runs requireIdentity three times (the
 * (authenticated) layout, the org layout and the page), the layout's NewerLegalTextNotice reads what is offered, and
 * S-05 reads what is missing and offered. lib/data/acceptances.ts reads the rows through React `cache()`.
 *
 * Outside a React server render `cache()` does not memoise, so this file stands one in for it: the mocked `cache`
 * keeps one table per "request", which a case starts afresh with `newRequest()`, as React keeps one per request.
 * What is pinned is that every reader goes through `cache()`, and the count of reads of consent_records.
 */
const request = vi.hoisted(() => ({ tables: [] as Array<Map<string, unknown>> }));
vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const cache = <A extends unknown[], R>(fn: (...args: A) => R) => {
    const seen = new Map<string, R>();
    request.tables.push(seen as Map<string, unknown>);
    return (...args: A): R => {
      const key = JSON.stringify(args);
      if (!seen.has(key)) seen.set(key, fn(...args));
      return seen.get(key)!;
    };
  };
  return { ...real, cache };
});
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-pathname': '/orgs/x/dashboard' }) }));
/** Counts reads of consent_records: a Prisma delegate's methods cannot be spied on, so identityDb passes through a proxy. */
const reads = vi.hoisted(() => ({ count: 0, failNext: null as Error | null }));
vi.mock('@/lib/data/identity', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/data/identity')>();
  const delegate = real.identityDb.consentRecord;
  // Over an empty target: the delegate's own properties are non-configurable, which a Proxy may not change.
  const consentRecord = new Proxy({} as typeof delegate, {
    get(_target, prop) {
      if (prop !== 'findMany') {
        const value = Reflect.get(delegate, prop);
        return typeof value === 'function' ? value.bind(delegate) : value;
      }
      return (...args: Parameters<typeof delegate.findMany>) => {
        reads.count += 1;
        if (reads.failNext) { const e = reads.failNext; reads.failNext = null; return Promise.reject(e); }
        return delegate.findMany(...args);
      };
    },
  });
  const identityDb = new Proxy(real.identityDb, { get: (t, p, r) => (p === 'consentRecord' ? consentRecord : Reflect.get(t, p, r)) });
  return { ...real, identityDb };
});

const { requireIdentity, requireIdentityForApi } = await import('@/lib/auth/identity');
const { missingAcceptances, offeredAcceptances } = await import('@/lib/data/acceptances');

/** A new request: every cache() table is emptied. */
const newRequest = () => { for (const t of request.tables) t.clear(); };

beforeEach(async () => {
  await resetDb();
  clearSession();
  newRequest();
  reads.count = 0;
  reads.failNext = null;
});

describe('one request reads the acceptance rows once (FR-ACC-04)', () => {
  it('FR-ACC-04: the gates, the newer-text notice and S-05\'s reads of one request share one read of consent_records', async () => {
    const fx = await buildOrg();
    sessionFor(fx.members.owner.userId);
    newRequest();
    reads.count = 0;
    await requireIdentity();
    await requireIdentity();
    await requireIdentity();
    await requireIdentityForApi();
    await offeredAcceptances(fx.members.owner.userId);
    await missingAcceptances(fx.members.owner.userId);
    expect(reads.count).toBe(1);
    newRequest();
    await requireIdentityForApi();
    expect(reads.count).toBe(2);   // a new request reads again
  });

  it('FR-ACC-04: a failed read refuses the request and is not taken for "nothing missing"; the next request reads again', async () => {
    const fx = await buildOrg();
    sessionFor(fx.members.owner.userId);
    reads.failNext = new Error('simulated: consent_records unreadable');
    newRequest();
    await expect(requireIdentityForApi()).rejects.toThrow('simulated: consent_records unreadable');
    await expect(missingAcceptances(fx.members.owner.userId)).rejects.toThrow('simulated: consent_records unreadable');
    newRequest();
    await expect(requireIdentityForApi()).resolves.toMatchObject({ userId: fx.members.owner.userId });
  });
});
