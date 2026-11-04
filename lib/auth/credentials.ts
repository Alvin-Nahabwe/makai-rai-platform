import { randomBytes, randomUUID } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import { cookies } from 'next/headers';
import { identityDb } from '../data/identity';
import { logSecurityEvent } from '../security-logger';
import { KNOWN_DEVICE_COOKIE, KNOWN_DEVICE_TTL_S, knownDeviceCookieOptions, readKnownDevice, signKnownDevice } from './knownDevice';
import { recordSignInFailure } from './signInAlerts';

/**
 * The body of the Credentials provider's `authorize` (lib/auth.ts), here so it can be called without NextAuth: the
 * integration tests drive it against a real database. No log line names the account's email (NFR-PRIV-03): each carries
 * `userId`, and `attempts` on a failure.
 *
 * FR-ACC-05 (SRS line 497), NFR-SEC-06:
 * - The failure count is raised by one atomic `UPDATE ... SET x = x + 1` before the password is compared, so concurrent
 *   guesses each count (the old code read the count, compared, then wrote the read value plus one).
 * - A request whose new count reaches LOCK_THRESHOLD locks the counters for LOCK_MS, and a request whose new count is past
 *   it is refused against DUMMY_HASH without testing the real one; the count restarts at zero once a lock
 *   has expired, so one wrong attempt after a lock does not lock the account again.
 * - A browser with a valid known-device cookie for this account (lib/auth/knownDevice.ts) and a `known_devices` row seen in
 *   the last 30 days uses that row's own count and lock, so failures from other browsers never lock it out.
 * - Unknown, deactivated and locked accounts are compared against DUMMY_HASH, so every refusal costs one comparison and the
 *   answer is the same `null`.
 * The success path sets the known-device cookie through `cookies()` from next/headers, which a route handler merges into
 * its own response; the sign-in route is one.
 */
export const LOCK_THRESHOLD = 5;
export const LOCK_MS = 15 * 60 * 1000;

/** A cost-12 hash of 32 random bytes, made once per process: what a refusal is compared against. */
const DUMMY_HASH: Promise<string> = hash(randomBytes(32).toString('hex'), 12);

type Counters = { kind: 'account' } | { kind: 'device'; deviceId: string };

export async function authorizeCredentials(
  credentials: Partial<Record<'email' | 'password', unknown>> | undefined,
  request: Request,
): Promise<{ id: string; email: string; name: string; sessionEpoch: number } | null> {
  if (typeof credentials?.email !== 'string' || typeof credentials?.password !== 'string') return null;
  if (credentials.email.length === 0 || credentials.password.length === 0) return null;
  const password = credentials.password;
  const now = new Date();

  const user = await identityDb.user.findUnique({ where: { email: credentials.email } });
  const cookie = readKnownDevice(request.headers.get('cookie'), now);

  let counters: Counters = { kind: 'account' };
  let lockedUntil = user?.lockedUntil ?? null;
  if (user && cookie && cookie.userId === user.id) {
    const device = await identityDb.knownDevice.findFirst({
      where: { id: cookie.deviceId, userId: user.id, lastSeenAt: { gt: new Date(now.getTime() - KNOWN_DEVICE_TTL_S * 1000) } },
    });
    if (device) {
      counters = { kind: 'device', deviceId: device.id };
      lockedUntil = device.lockedUntil;
    }
  }

  if (!user || !user.isActive || (lockedUntil && lockedUntil > now)) {
    await compare(password, await DUMMY_HASH);
    if (user) {
      if (!user.isActive) {
        logSecurityEvent('AUTH_LOGIN_FAILURE', 'warn', { userId: user.id, details: { reason: 'account_deactivated' } });
      } else {
        logSecurityEvent('AUTH_ACCOUNT_LOCKED', 'warn', { userId: user.id });
      }
      recordSignInFailure({ userId: user.id, locked: false });
    }
    return null;
  }

  const attempts = await countAttempt(user.id, counters, now);
  // `locked` is true for the one request that set the lock, so the repeated-lock alert counts locks, not requests.
  const locked = attempts >= LOCK_THRESHOLD && (await lock(user.id, counters, new Date(now.getTime() + LOCK_MS)));

  // Past the threshold the counters are locked for this request too, whatever the read above saw: a concurrent burst
  // passes that read together, so only the count the increment returned bounds it to LOCK_THRESHOLD real guesses. Such a
  // request costs the same one comparison, against the dummy hash, and never tests the real one.
  if (attempts > LOCK_THRESHOLD) {
    await compare(password, await DUMMY_HASH);
    logSecurityEvent('AUTH_LOGIN_FAILURE', 'warn', { userId: user.id, details: { attempts } });
    recordSignInFailure({ userId: user.id, locked });
    return null;
  }

  if (!(await compare(password, user.passwordHash))) {
    logSecurityEvent('AUTH_LOGIN_FAILURE', 'warn', { userId: user.id, details: { attempts } });
    recordSignInFailure({ userId: user.id, locked });
    return null;
  }

  await identityDb.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
  const deviceId = counters.kind === 'device' ? counters.deviceId : randomUUID();
  await identityDb.knownDevice.upsert({
    where: { id: deviceId },
    create: { id: deviceId, userId: user.id, failedCount: 0, lockedUntil: null, lastSeenAt: now },
    update: { failedCount: 0, lockedUntil: null, lastSeenAt: now },
  });
  const { value, expires } = signKnownDevice({ deviceId, userId: user.id }, now);
  (await cookies()).set(KNOWN_DEVICE_COOKIE, value, knownDeviceCookieOptions(expires));

  logSecurityEvent('AUTH_LOGIN_SUCCESS', 'info', { userId: user.id });

  // ADR-0002: the token carries identity and nothing else. `role` and `mustChangePassword` are read fresh from the
  // database on every request by resolveIdentity (lib/auth/identity.ts), never embedded in the token.
  return { id: user.id, email: user.email, name: user.name, sessionEpoch: user.sessionEpoch };
}

/**
 * Restarts an expired lock's count, then raises the count by one in one statement and returns the new value. Each step is
 * one UPDATE, so two concurrent requests can never both read the same value and write it plus one.
 */
async function countAttempt(userId: string, c: Counters, now: Date): Promise<number> {
  if (c.kind === 'account') {
    await identityDb.user.updateMany({ where: { id: userId, lockedUntil: { lte: now } }, data: { failedLoginAttempts: 0, lockedUntil: null } });
    const u = await identityDb.user.update({ where: { id: userId }, data: { failedLoginAttempts: { increment: 1 } }, select: { failedLoginAttempts: true } });
    return u.failedLoginAttempts;
  }
  await identityDb.knownDevice.updateMany({ where: { id: c.deviceId, userId, lockedUntil: { lte: now } }, data: { failedCount: 0, lockedUntil: null } });
  const d = await identityDb.knownDevice.update({ where: { id: c.deviceId }, data: { failedCount: { increment: 1 } }, select: { failedCount: true } });
  return d.failedCount;
}

/** Sets the lock only if none is set, so a later request never moves an existing lock's end. True when this call set it. */
async function lock(userId: string, c: Counters, until: Date): Promise<boolean> {
  const { count } = c.kind === 'account'
    ? await identityDb.user.updateMany({ where: { id: userId, lockedUntil: null }, data: { lockedUntil: until } })
    : await identityDb.knownDevice.updateMany({ where: { id: c.deviceId, userId, lockedUntil: null }, data: { lockedUntil: until } });
  return count === 1;
}
