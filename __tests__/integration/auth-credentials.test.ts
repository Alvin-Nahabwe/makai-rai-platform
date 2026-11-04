import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { hash } from 'bcryptjs';
import { resetDb, testDb } from '../helpers/db';
import { buildOrg } from '../helpers/recordFixture';
import { identityDb } from '../../lib/data/identity';
import { FIXTURE_PASSWORD } from '../helpers/fixture';
import { authorizeCredentials } from '../../lib/auth/credentials';
import { logSecurityEvent } from '../../lib/security-logger';

// The real logger, wrapped so the test can also see what it was HANDED. The logger redacts
// whatever it is given, so output alone cannot tell "the call site names no email" from "the
// call site names one and the redactor caught it". Only the first is the plan.
vi.mock('../../lib/security-logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/security-logger')>();
  return { ...actual, logSecurityEvent: vi.fn(actual.logSecurityEvent) };
});

/**
 * The sign-in path, driven for real against the identity lane: real bcrypt, real rows.
 *
 * RL 2.3 / 7.12 (P1, P2): a failed or successful sign-in used to write the account's email
 * into the security log. It now writes `userId`, which is enough to follow one account
 * through a brute force (P2: `userId` and `attempts` stay) and is not personal data.
 *
 * `authorizeCredentials` is the body of the Credentials provider's `authorize`, moved out
 * of `lib/auth.ts` so it can be called here without NextAuth, a cookie jar or a request.
 */

const EMAIL = 'lockout-probe@example.test';
// The fixtures' shared test password, and a different string that is certainly not it.
const PASSWORD = FIXTURE_PASSWORD;
const WRONG = `${FIXTURE_PASSWORD}-not`;

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error';
const METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'error'];
/** The part of a vitest spy this file uses. */
type Spy = { mock: { calls: unknown[][] }; mockClear(): unknown; mockRestore(): void };
const spies = {} as Record<ConsoleMethod, Spy>;

beforeEach(async () => {
  await resetDb();
  vi.mocked(logSecurityEvent).mockClear();
  for (const m of METHODS) spies[m] = vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  for (const m of METHODS) spies[m].mockRestore();
});

/** Everything written to the console since the test began, as the lines a log collector would see. */
const output = (): string[] => METHODS.flatMap((m) => spies[m].mock.calls.map((c) => c.map(String).join(' ')));
const events = (): Record<string, unknown>[] => output().map((l) => JSON.parse(l) as Record<string, unknown>);

/** An organisation's owner (K0a's buildOrg) with EMAIL and PASSWORD. */
async function makeUser(): Promise<string> {
  const fx = await buildOrg();
  const userId = fx.members.owner.userId;
  // Cost 4: the hash is only here to be compared against. The cost is stored in it.
  await testDb.user.update({ where: { id: userId }, data: { email: EMAIL, name: 'Lockout Probe', passwordHash: await hash(PASSWORD, 4) } });
  return userId;
}

describe('authorizeCredentials', () => {
  it('logs no email on a failed sign-in', async () => {
    const id = await makeUser();
    await expect(authorizeCredentials({ email: EMAIL, password: WRONG })).resolves.toBeNull();

    const lines = output();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"userId":"${id}"`);
    expect(lines[0].toLowerCase()).not.toContain(EMAIL);
    expect(lines.join('\n').toLowerCase()).not.toContain('example.test');
    expect(events()[0]).toMatchObject({ event: 'AUTH_LOGIN_FAILURE', level: 'warn', userId: id, details: { attempts: 1 } });
  });

  it('hands the logger no email in the first place, on every path', async () => {
    const id = await makeUser();
    await authorizeCredentials({ email: EMAIL, password: WRONG }); // failure
    await authorizeCredentials({ email: EMAIL, password: PASSWORD }); // success
    await identityDb.user.update({ where: { id }, data: { lockedUntil: new Date(Date.now() + 60_000) } });
    await authorizeCredentials({ email: EMAIL, password: PASSWORD }); // locked
    await identityDb.user.update({ where: { id }, data: { lockedUntil: null, isActive: false } });
    await authorizeCredentials({ email: EMAIL, password: PASSWORD }); // deactivated

    const handed = vi.mocked(logSecurityEvent).mock.calls;
    expect(handed.map((c) => c[0])).toEqual([
      'AUTH_LOGIN_FAILURE',
      'AUTH_LOGIN_SUCCESS',
      'AUTH_ACCOUNT_LOCKED',
      'AUTH_LOGIN_FAILURE',
    ]);
    expect(JSON.stringify(handed).toLowerCase()).not.toContain('example.test');
    for (const call of handed) expect(call[2]).toMatchObject({ userId: id });
  });

  it('keeps counting attempts per account, so a brute force can still be traced (P2)', async () => {
    const id = await makeUser();
    for (let i = 0; i < 5; i += 1) await authorizeCredentials({ email: EMAIL, password: WRONG });

    const failures = events().filter((e) => e.event === 'AUTH_LOGIN_FAILURE');
    expect(failures.map((e) => (e.details as { attempts: number }).attempts)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(failures.map((e) => e.userId))).toEqual(new Set([id]));
    expect(output().join('\n').toLowerCase()).not.toContain(EMAIL);

    // The fifth failure locked the account, and the next attempt says so by userId.
    spies.warn.mockClear();
    await expect(authorizeCredentials({ email: EMAIL, password: PASSWORD })).resolves.toBeNull();
    expect(events()).toEqual([expect.objectContaining({ event: 'AUTH_ACCOUNT_LOCKED', level: 'warn', userId: id })]);
    expect(output().join('\n').toLowerCase()).not.toContain(EMAIL);
  });

  it('returns the identity and logs the userId only on a good sign-in', async () => {
    const id = await makeUser();
    const out = await authorizeCredentials({ email: EMAIL, password: PASSWORD });
    expect(out).toEqual({ id, email: EMAIL, name: 'Lockout Probe', sessionEpoch: 0 });

    expect(events()).toEqual([expect.objectContaining({ event: 'AUTH_LOGIN_SUCCESS', level: 'info', userId: id })]);
    expect(output().join('\n').toLowerCase()).not.toContain(EMAIL);
    expect(events()[0]).not.toHaveProperty('details');
  });

  it('clears the failed-attempt counter on a good sign-in, as before', async () => {
    const id = await makeUser();
    await authorizeCredentials({ email: EMAIL, password: WRONG });
    await authorizeCredentials({ email: EMAIL, password: PASSWORD });
    const row = await identityDb.user.findUnique({ where: { id } });
    expect(row?.failedLoginAttempts).toBe(0);
  });

  it('logs a deactivated account by userId and reason, and still answers with the generic null', async () => {
    const id = await makeUser();
    await identityDb.user.update({ where: { id }, data: { isActive: false } });
    await expect(authorizeCredentials({ email: EMAIL, password: PASSWORD })).resolves.toBeNull();

    expect(events()).toEqual([
      expect.objectContaining({ event: 'AUTH_LOGIN_FAILURE', userId: id, details: { reason: 'account_deactivated' } }),
    ]);
    expect(output().join('\n').toLowerCase()).not.toContain(EMAIL);
  });

  it('answers null and logs nothing for an address that is not an account, so the log cannot be used to probe', async () => {
    await expect(authorizeCredentials({ email: 'nobody@example.test', password: PASSWORD })).resolves.toBeNull();
    expect(output()).toEqual([]);
  });

  it.each([[undefined], [{}], [{ email: EMAIL }], [{ password: PASSWORD }], [{ email: '', password: PASSWORD }]])(
    'answers null for missing credentials %j',
    async (credentials) => {
      await expect(authorizeCredentials(credentials as never)).resolves.toBeNull();
      expect(output()).toEqual([]);
    },
  );
});

describe('lib/auth.ts', () => {
  it('delegates to authorizeCredentials and logs nothing itself', () => {
    const source = readFileSync('lib/auth.ts', 'utf8');
    expect(source).toContain('authorizeCredentials');
    expect(source).not.toContain('logSecurityEvent');
  });
});

/**
 * The account lockout (RL 2.3; Task 16). Five wrong passwords lock an account for 15 minutes,
 * and while it is locked even the right password is refused. These pin that policy from the
 * outside: real bcrypt, real rows, and for expiry a real clock moving, not a row edited into
 * the past.
 */
describe('account lockout', () => {
  const MINUTE = 60_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Five wrong passwords, which is exactly what locks the account. */
  async function failFiveTimes(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await expect(authorizeCredentials({ email: EMAIL, password: WRONG })).resolves.toBeNull();
  }

  it('locks after 5 failed attempts and refuses the right password while locked', async () => {
    const id = await makeUser();

    // Four failures count but do not lock.
    for (let i = 0; i < 4; i += 1) await expect(authorizeCredentials({ email: EMAIL, password: WRONG })).resolves.toBeNull();
    const fourth = await identityDb.user.findUniqueOrThrow({ where: { id } });
    expect(fourth.failedLoginAttempts).toBe(4);
    expect(fourth.lockedUntil).toBeNull();

    // The fifth locks, for about 15 minutes: more than 14, and not an open-ended lock.
    await expect(authorizeCredentials({ email: EMAIL, password: WRONG })).resolves.toBeNull();
    const locked = await identityDb.user.findUniqueOrThrow({ where: { id } });
    expect(locked.failedLoginAttempts).toBe(5);
    expect(locked.lockedUntil).not.toBeNull();
    const lockedFor = (locked.lockedUntil as Date).getTime() - Date.now();
    expect(lockedFor).toBeGreaterThan(14 * MINUTE);
    expect(lockedFor).toBeLessThanOrEqual(16 * MINUTE);

    // The right password is refused with the same generic null, and the refusal changes nothing.
    await expect(authorizeCredentials({ email: EMAIL, password: PASSWORD })).resolves.toBeNull();
    const after = await identityDb.user.findUniqueOrThrow({ where: { id } });
    expect(after.failedLoginAttempts).toBe(5);
    expect(after.lockedUntil).toEqual(locked.lockedUntil);
  });

  it('signs in after the lock expires and resets the counter', async () => {
    const id = await makeUser();
    // Only the clock is faked: bcrypt and the database driver keep their real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    await failFiveTimes();
    const { lockedUntil } = await identityDb.user.findUniqueOrThrow({ where: { id } });
    expect(lockedUntil).not.toBeNull();
    const unlockAt = (lockedUntil as Date).getTime();

    // One second before the lock ends the right password is still refused...
    vi.setSystemTime(unlockAt - 1000);
    await expect(authorizeCredentials({ email: EMAIL, password: PASSWORD })).resolves.toBeNull();

    // ...and one second after it, it signs in and clears the lock and the counter.
    vi.setSystemTime(unlockAt + 1000);
    await expect(authorizeCredentials({ email: EMAIL, password: PASSWORD })).resolves.toEqual({
      id,
      email: EMAIL,
      name: 'Lockout Probe',
      sessionEpoch: 0,
    });
    const cleared = await identityDb.user.findUniqueOrThrow({ where: { id } });
    expect(cleared.failedLoginAttempts).toBe(0);
    expect(cleared.lockedUntil).toBeNull();

    // The counter really restarted: the next wrong password is attempt 1 and does not relock.
    await expect(authorizeCredentials({ email: EMAIL, password: WRONG })).resolves.toBeNull();
    const next = await identityDb.user.findUniqueOrThrow({ where: { id } });
    expect(next.failedLoginAttempts).toBe(1);
    expect(next.lockedUntil).toBeNull();
  });
});
