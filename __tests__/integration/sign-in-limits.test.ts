import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../helpers/db';
import { buildOrg, type FixtureMember } from '../helpers/recordFixture';

/**
 * The sign-in check (FR-ACC-05, NFR-SEC-06), driven for real against the identity lane: real bcrypt (cost 12, the
 * fixture's), real rows. Obligations B1 (an atomic count before the comparison), B2 (the count restarts after a lock
 * expires; a known device has its own count) and B4 (every refusal costs one comparison, so timing does not tell which
 * emails have accounts).
 *
 * `cookies()` from next/headers needs a Next request scope, so it is replaced by a recorder: the test reads the
 * known-device cookie the sign-in set from there and sends it back in the next request's Cookie header, as a browser does.
 * The password hash pool's `compare` (lib/auth/passwordHash.ts, bcryptjs on worker threads) is wrapped so the test counts
 * comparisons, the dummy-hash ones included. `recordSignInFailure` (the spraying alert, NFR-OBS-04) is recorded
 * here and tested on its own in sign-in-alerts.test.ts.
 */
const h = vi.hoisted(() => ({ set: [] as Array<{ name: string; value: string; options: Record<string, unknown> }> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: (name: string, value: string, options: Record<string, unknown>) => { h.set.push({ name, value, options }); } }),
}));
vi.mock('../../lib/auth/passwordHash', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/auth/passwordHash')>();
  return { ...actual, compare: vi.fn(actual.compare) };
});
vi.mock('../../lib/auth/signInAlerts', () => ({ recordSignInFailure: vi.fn() }));

const bcrypt = await import('../../lib/auth/passwordHash');
const { authorizeCredentials, LOCK_THRESHOLD, LOCK_MS, SIGN_IN_FLOOR_MS, signInDeps } = await import('../../lib/auth/credentials');
const { KNOWN_DEVICE_COOKIE } = await import('../../lib/auth/knownDevice');
const { recordSignInFailure } = await import('../../lib/auth/signInAlerts');

const WRONG = 'wrong-password-x';

/** Test-local: `authorizeCredentials` with a request that carries `cookie`, as the credentials POST would. */
function signInWithPassword(email: string, password: string, cookie?: string) {
  const headers: Record<string, string> = cookie ? { cookie } : {};
  return authorizeCredentials({ email, password }, new Request('http://localhost/api/auth/callback/credentials', { method: 'POST', headers }));
}

/** The last known-device cookie a sign-in set, as a Cookie header value. */
function capturedCookie(name: string): string {
  const last = [...h.set].reverse().find((c) => c.name === name);
  if (!last) throw new Error(`no ${name} cookie was set`);
  return `${name}=${last.value}`;
}

async function lockAccount(m: FixtureMember): Promise<void> {
  await testDb.user.update({ where: { id: m.userId }, data: { failedLoginAttempts: LOCK_THRESHOLD, lockedUntil: new Date(Date.now() + LOCK_MS) } });
}

let a: FixtureMember;
let b: FixtureMember;
let locked: FixtureMember;

beforeEach(async () => {
  await resetDb();
  h.set.length = 0;
  vi.mocked(bcrypt.compare).mockClear();
  vi.mocked(recordSignInFailure).mockClear();
  const fx = await buildOrg();
  a = fx.members.assessor;
  b = fx.members.reviewer;
  locked = fx.members.viewer;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('sign-in limits per account (FR-ACC-05, NFR-SEC-06)', () => {
  /** How many comparisons ran against `m`'s stored hash (not the dummy one) since the spy was last cleared. */
  async function realComparisons(m: FixtureMember): Promise<number> {
    const { passwordHash } = await testDb.user.findUniqueOrThrow({ where: { id: m.userId } });
    return vi.mocked(bcrypt.compare).mock.calls.filter((c) => c[1] === passwordHash).length;
  }

  it('FR-ACC-05 NFR-SEC-06: 20 concurrent wrong passwords lock the account', async () => {
    vi.mocked(bcrypt.compare).mockClear();
    await Promise.all(Array.from({ length: 20 }, () => signInWithPassword(a.email, WRONG)));
    const u = await testDb.user.findUniqueOrThrow({ where: { id: a.userId } });
    expect(u.failedLoginAttempts).toBe(20);
    expect(u.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(vi.mocked(recordSignInFailure)).toHaveBeenCalledWith({ userId: a.userId, locked: true });
    // B1: a burst gets at most LOCK_THRESHOLD real guesses; the rest are compared against the dummy hash.
    expect(await realComparisons(a)).toBeLessThanOrEqual(LOCK_THRESHOLD);
    expect(vi.mocked(bcrypt.compare)).toHaveBeenCalledTimes(20);
  }, 60_000);

  it('FR-ACC-05 NFR-SEC-06: a right password counted past the threshold is refused without testing the real hash', async () => {
    // The state a burst leaves for its later requests: five attempts counted, the lock not written yet.
    await testDb.user.update({ where: { id: a.userId }, data: { failedLoginAttempts: LOCK_THRESHOLD, lockedUntil: null } });
    vi.mocked(bcrypt.compare).mockClear();
    expect(await signInWithPassword(a.email, a.password)).toBeNull();
    expect(await realComparisons(a)).toBe(0);
    expect(vi.mocked(bcrypt.compare)).toHaveBeenCalledTimes(1);
    const u = await testDb.user.findUniqueOrThrow({ where: { id: a.userId } });
    expect(u.failedLoginAttempts).toBe(LOCK_THRESHOLD + 1);
    expect(u.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // The same holds on a known device's own counter.
    await testDb.user.update({ where: { id: a.userId }, data: { failedLoginAttempts: 0, lockedUntil: null } });
    expect(await signInWithPassword(a.email, a.password)).not.toBeNull();
    const kd = capturedCookie(KNOWN_DEVICE_COOKIE);
    await testDb.knownDevice.updateMany({ where: { userId: a.userId }, data: { failedCount: LOCK_THRESHOLD } });
    vi.mocked(bcrypt.compare).mockClear();
    expect(await signInWithPassword(a.email, a.password, kd)).toBeNull();
    expect(await realComparisons(a)).toBe(0);
  }, 60_000);

  it('FR-ACC-05 M-20: after 5 wrong passwords the right one is refused until 15 minutes pass', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let i = 0; i < 5; i++) expect(await signInWithPassword(a.email, WRONG)).toBeNull();
    expect(await signInWithPassword(a.email, a.password)).toBeNull();
    vi.setSystemTime(Date.now() + 15 * 60 * 1000 + 1);
    expect(await signInWithPassword(a.email, a.password)).toMatchObject({ id: a.userId, email: a.email });
  }, 60_000);

  it('FR-ACC-05: after a lock expires one wrong attempt does not lock it again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await lockAccount(a);
    vi.setSystemTime(Date.now() + 15 * 60 * 1000 + 1);
    await signInWithPassword(a.email, WRONG);
    const u = await testDb.user.findUniqueOrThrow({ where: { id: a.userId } });
    expect([u.failedLoginAttempts, u.lockedUntil]).toEqual([1, null]);
  }, 60_000);

  it('FR-ACC-05: a known-device browser signs in while fresh browsers keep the account locked', async () => {
    expect(await signInWithPassword(a.email, a.password)).not.toBeNull(); // sets the cookie
    const kd = capturedCookie(KNOWN_DEVICE_COOKIE);
    expect(h.set.at(-1)!.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/api/auth' });
    // Fresh browsers lock the account; their failures do not touch the device's own count.
    for (let i = 0; i < 6; i++) expect(await signInWithPassword(a.email, WRONG)).toBeNull();
    expect(await signInWithPassword(a.email, a.password)).toBeNull();
    const device = await testDb.knownDevice.findFirstOrThrow({ where: { userId: a.userId } });
    expect([device.failedCount, device.lockedUntil]).toEqual([0, null]);
    expect(await signInWithPassword(a.email, a.password, kd)).toMatchObject({ id: a.userId });
    // The cookie names this account only: another account's sign-in with it is an ordinary browser's.
    await lockAccount(b);
    expect(await signInWithPassword(b.email, b.password, kd)).toBeNull();
  }, 60_000);

  it('FR-ACC-05: a known device has its own count, and 5 wrong passwords from it lock only that device', async () => {
    expect(await signInWithPassword(a.email, a.password)).not.toBeNull();
    const kd = capturedCookie(KNOWN_DEVICE_COOKIE);
    for (let i = 0; i < 5; i++) expect(await signInWithPassword(a.email, WRONG, kd)).toBeNull();
    expect(await signInWithPassword(a.email, a.password, kd)).toBeNull();
    const u = await testDb.user.findUniqueOrThrow({ where: { id: a.userId } });
    expect([u.failedLoginAttempts, u.lockedUntil]).toEqual([0, null]);
    // A fresh browser is not locked out by the device's lock.
    expect(await signInWithPassword(a.email, a.password)).not.toBeNull();
  }, 60_000);

  it('FR-ACC-05 (B3, C4 SO-3): a cookie whose row is older than 30 days, or gone, is not a known device', async () => {
    expect(await signInWithPassword(a.email, a.password)).not.toBeNull();
    const kd = capturedCookie(KNOWN_DEVICE_COOKIE);
    await lockAccount(a);
    await testDb.knownDevice.updateMany({ where: { userId: a.userId }, data: { lastSeenAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) } });
    expect(await signInWithPassword(a.email, a.password, kd)).toBeNull();
    await testDb.knownDevice.deleteMany({ where: { userId: a.userId } });
    expect(await signInWithPassword(a.email, a.password, kd)).toBeNull();
  }, 60_000);

  it('FR-ACC-05 (C4 ruling CR-5, option b): a sign-in from a new browser reuses the account\'s oldest row older than 30 days', async () => {
    const day = 24 * 3600 * 1000;
    await testDb.knownDevice.createMany({ data: [
      { id: 'kd-older', userId: a.userId, lastSeenAt: new Date(Date.now() - 45 * day), failedCount: 3 },
      { id: 'kd-old', userId: a.userId, lastSeenAt: new Date(Date.now() - 31 * day) },
      { id: 'kd-recent', userId: a.userId, lastSeenAt: new Date(Date.now() - 29 * day) },
      { id: 'kd-other', userId: b.userId, lastSeenAt: new Date(Date.now() - 60 * day) },
    ] });
    expect(await signInWithPassword(a.email, a.password)).not.toBeNull();
    // The oldest stale row was taken over: no row was inserted, and the new cookie names it.
    expect(await testDb.knownDevice.count({ where: { userId: a.userId } })).toBe(3);
    const reused = await testDb.knownDevice.findUniqueOrThrow({ where: { id: 'kd-older' } });
    expect(reused.failedCount).toBe(0);
    expect(reused.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(capturedCookie(KNOWN_DEVICE_COOKIE)).toMatch(/^makrai\.kd=kd-older\./);
    // The next new browser takes the other stale row; the 29-day row and another account's row are never taken.
    expect(await signInWithPassword(a.email, a.password)).not.toBeNull();
    expect(capturedCookie(KNOWN_DEVICE_COOKIE)).toMatch(/^makrai\.kd=kd-old\./);
    expect(await signInWithPassword(a.email, a.password)).not.toBeNull();
    expect(await testDb.knownDevice.count({ where: { userId: a.userId } })).toBe(4); // nothing stale left: one insert
    expect((await testDb.knownDevice.findUniqueOrThrow({ where: { id: 'kd-other' } })).userId).toBe(b.userId);
  }, 60_000);

  it('FR-ACC-05 (CR-5): two concurrent sign-ins never take the same stale row', async () => {
    await testDb.knownDevice.create({ data: { id: 'kd-stale', userId: a.userId, lastSeenAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) } });
    h.set.length = 0;
    await Promise.all([signInWithPassword(a.email, a.password), signInWithPassword(a.email, a.password)]);
    const ids = h.set.filter((c) => c.name === KNOWN_DEVICE_COOKIE).map((c) => c.value.split('.')[0]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('kd-stale');
    expect(await testDb.knownDevice.count({ where: { userId: a.userId } })).toBe(2);
  }, 60_000);

  it('FR-ACC-05: a successful sign-in resets both counts', async () => {
    for (let i = 0; i < 3; i++) await signInWithPassword(a.email, WRONG);
    expect((await testDb.user.findUniqueOrThrow({ where: { id: a.userId } })).failedLoginAttempts).toBe(3);
    expect(await signInWithPassword(a.email, a.password)).not.toBeNull();
    const u = await testDb.user.findUniqueOrThrow({ where: { id: a.userId } });
    expect([u.failedLoginAttempts, u.lockedUntil]).toEqual([0, null]);
  }, 60_000);

  it('FR-ACC-05 NFR-SEC-06: wrong password, locked and unknown email cost one comparison each, medians within 100 ms', async () => {
    await lockAccount(locked);
    vi.mocked(bcrypt.compare).mockClear();
    const median = async (fn: () => Promise<unknown>, before?: () => Promise<unknown>) => {
      const t: number[] = [];
      for (let i = 0; i < 50; i++) {
        if (before) await before();
        const s = performance.now();
        await fn();
        t.push(performance.now() - s);
      }
      return t.sort((x, y) => x - y)[25];
    };
    // `b` is reset to no failures before each wrong attempt, outside the timing, so it never locks.
    const resetB = () => testDb.user.update({ where: { id: b.userId }, data: { failedLoginAttempts: 0, lockedUntil: null } });
    const w = await median(() => signInWithPassword(b.email, WRONG), resetB);
    const l = await median(() => signInWithPassword(locked.email, locked.password));
    const n = await median(() => signInWithPassword('nobody@fixture.test', 'x'));
    expect(Math.max(w, l, n) - Math.min(w, l, n)).toBeLessThan(100);
    expect(vi.mocked(bcrypt.compare)).toHaveBeenCalledTimes(150);
  }, 180_000);

  it('FR-ACC-05 NFR-SEC-06: a deactivated account costs one comparison and changes no count', async () => {
    await testDb.user.update({ where: { id: a.userId }, data: { isActive: false } });
    vi.mocked(bcrypt.compare).mockClear();
    expect(await signInWithPassword(a.email, a.password)).toBeNull();
    expect(vi.mocked(bcrypt.compare)).toHaveBeenCalledTimes(1);
    const u = await testDb.user.findUniqueOrThrow({ where: { id: a.userId } });
    expect([u.failedLoginAttempts, u.lockedUntil]).toEqual([0, null]);
  }, 60_000);
});

/**
 * The refusal floor (controller ruling on B4): a known account's wrong password does a few more database round trips than
 * an unknown email, so every refusal resolves no earlier than SIGN_IN_FLOOR_MS after the call began. The clock and the
 * sleep are the module's `signInDeps`, faked here, so the case is exact rather than a wall-clock tolerance.
 */
describe('every refusal waits out the same floor', () => {
  const START = 1_000_000;
  /** The first `now()` is the call's start; every later one is `elapsed` ms after it. */
  function fakeClock(elapsed: number) {
    let first = true;
    vi.spyOn(signInDeps, 'now').mockImplementation(() => { if (first) { first = false; return START; } return START + elapsed; });
    return vi.spyOn(signInDeps, 'sleepUntil').mockResolvedValue(undefined);
  }

  it('FR-ACC-05 NFR-SEC-06: the floor is 500 ms', () => {
    expect(SIGN_IN_FLOOR_MS).toBe(500);
  });

  it.each([
    ['an unknown email', async () => ['nobody@fixture.test', 'x'] as const],
    ['a deactivated account', async () => { await testDb.user.update({ where: { id: a.userId }, data: { isActive: false } }); return [a.email, a.password] as const; }],
    ['a locked account', async () => { await lockAccount(a); return [a.email, a.password] as const; }],
    ['a wrong password', async () => [a.email, WRONG] as const],
    ['a request past the threshold', async () => { await testDb.user.update({ where: { id: a.userId }, data: { failedLoginAttempts: LOCK_THRESHOLD } }); return [a.email, a.password] as const; }],
  ])('FR-ACC-05 NFR-SEC-06: %s resolves no earlier than start + 500 ms', async (_kind, prepare) => {
    const [email, password] = await prepare();
    const sleep = fakeClock(120);
    expect(await signInWithPassword(email, password)).toBeNull();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(START + SIGN_IN_FLOOR_MS);
  }, 60_000);

  it('FR-ACC-05 NFR-SEC-06 (C4 F5): a check that throws still waits out the floor before the error goes on', async () => {
    const sleep = fakeClock(40);
    const broken = { headers: { get: () => { throw new Error('header read failed'); } } } as unknown as Request;
    await expect(authorizeCredentials({ email: a.email, password: a.password }, broken)).rejects.toThrow('header read failed');
    expect(sleep).toHaveBeenCalledWith(START + SIGN_IN_FLOOR_MS);
  }, 60_000);

  it.each([
    ['the real hash', () => [a.email, a.password] as const],
    ['the dummy hash', () => ['nobody@fixture.test', 'x'] as const],
  ])('FR-ACC-05: a comparison of %s the pool rejects (worker crash, timeout) fails the sign-in, never passes it', async (_kind, creds) => {
    const sleep = fakeClock(40);
    vi.mocked(bcrypt.compare).mockRejectedValueOnce(new Error('password hash worker exited (code 1)'));
    const [email, password] = creds();
    await expect(signInWithPassword(email, password)).rejects.toThrow('password hash worker exited');
    expect(sleep).toHaveBeenCalledWith(START + SIGN_IN_FLOOR_MS);
    expect(h.set).toEqual([]); // no known-device cookie: nothing of a success happened
  }, 60_000);

  it('FR-ACC-05 (C4 m3): a comparison that answers anything but true is a refusal', async () => {
    vi.mocked(bcrypt.compare).mockResolvedValueOnce('true' as unknown as boolean);
    expect(await signInWithPassword(a.email, WRONG)).toBeNull();
    expect(h.set).toEqual([]);
  }, 60_000);

  it('FR-ACC-05 NFR-SEC-06: a refusal that already took 600 ms waits no longer', async () => {
    const sleep = fakeClock(600);
    expect(await signInWithPassword(a.email, WRONG)).toBeNull();
    expect(sleep).not.toHaveBeenCalled();
  }, 60_000);

  it('FR-ACC-05: a successful sign-in is not padded', async () => {
    const sleep = fakeClock(10);
    expect(await signInWithPassword(a.email, a.password)).not.toBeNull();
    expect(sleep).not.toHaveBeenCalled();
  }, 60_000);

  it('FR-ACC-05 NFR-SEC-06: the floor is waited for real', async () => {
    const t0 = performance.now();
    expect(await signInWithPassword('nobody@fixture.test', 'x')).toBeNull();
    expect(performance.now() - t0).toBeGreaterThanOrEqual(SIGN_IN_FLOOR_MS - 5);
  }, 60_000);
});
