import { randomBytes, randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { identityDb } from '../data/identity';
import { logSecurityEvent } from '../security-logger';
import { KNOWN_DEVICE_COOKIE, KNOWN_DEVICE_TTL_S, knownDeviceCookieOptions, readKnownDevice, signKnownDevice } from './knownDevice';
import { compare, hash } from './passwordHash';
import { releaseComparisonSlot } from './signInAdmission';
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
 *   it is refused against the dummy hash without testing the real one; the count restarts at zero once a lock
 *   has expired, so one wrong attempt after a lock does not lock the account again.
 * - A browser with a valid known-device cookie for this account (lib/auth/knownDevice.ts) and a `known_devices` row seen in
 *   the last 30 days uses that row's own count and lock, so failures from other browsers never lock it out.
 * - Unknown, deactivated and locked accounts are compared against the dummy hash, so every refusal costs one comparison and the
 *   answer is the same `null`.
 * - Comparisons run on worker threads (lib/auth/passwordHash.ts). One the pool rejects (its worker died, or it ran past
 *   10 s) throws out of here, never reads as a match: NextAuth answers it as a server problem, after the refusal floor.
 * The success path sets the known-device cookie through `cookies()` from next/headers, which a route handler merges into
 * its own response; the sign-in route is one.
 */
export const LOCK_THRESHOLD = 5;
export const LOCK_MS = 15 * 60 * 1000;

/**
 * A cost-12 hash of 32 random bytes, made once per process on first use: what a refusal is compared against. It is made
 * and compared on the same worker pool as real hashes (lib/auth/passwordHash.ts), so a refusal costs what a real check
 * does. A failed attempt to make it is forgotten, so the next sign-in tries again rather than failing for good.
 */
let dummyHash: Promise<string> | null = null;
function dummyHashOnce(): Promise<string> {
  dummyHash ??= hash(randomBytes(32).toString('hex'), 12).catch((e: unknown) => {
    dummyHash = null;
    throw e;
  });
  return dummyHash;
}

type Counters = { kind: 'account' } | { kind: 'device'; deviceId: string };
type SignedIn = { id: string; email: string; name: string; sessionEpoch: number };

/**
 * Every refusal resolves no earlier than this long after the call began, and so does a check that throws. The refusal
 * kinds differ by a few database round trips (an unknown email does none; a known account's wrong password counts and
 * may lock), and that gap alone would tell which emails have accounts. 500 ms is above the slowest refusal's work at cost 12; a refusal that took longer waits no
 * more. A success is not padded, and neither is the admission's 503 `sign_in_busy`, which is no answer about credentials.
 */
export const SIGN_IN_FLOOR_MS = 500;

/** The clock and the sleep of the refusal floor; tests replace them to check the floor exactly. */
export const signInDeps = {
  now: (): number => Date.now(),
  sleepUntil: (t: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, t - Date.now()))),
};

export async function authorizeCredentials(
  credentials: Partial<Record<'email' | 'password', unknown>> | undefined,
  request: Request,
): Promise<SignedIn | null> {
  const start = signInDeps.now();
  let result: SignedIn | null = null;
  try {
    result = await checkCredentials(credentials, request);
    return result;
  } finally {
    // Every answer but a success waits out the floor, a check that threw included (C4 finding F5): how soon a failure
    // answers must not tell more than a refusal does. The comparison is done, so the admission slot goes back before the
    // wait and the floor never holds one of the four.
    if (result === null) {
      releaseComparisonSlot();
      const deadline = start + SIGN_IN_FLOOR_MS;
      if (signInDeps.now() < deadline) await signInDeps.sleepUntil(deadline);
    }
  }
}

async function checkCredentials(
  credentials: Partial<Record<'email' | 'password', unknown>> | undefined,
  request: Request,
): Promise<SignedIn | null> {
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
    await compare(password, await dummyHashOnce());
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
    await compare(password, await dummyHashOnce());
    logSecurityEvent('AUTH_LOGIN_FAILURE', 'warn', { userId: user.id, details: { attempts } });
    recordSignInFailure({ userId: user.id, locked });
    return null;
  }

  if ((await compare(password, user.passwordHash)) !== true) { // a match only on a real true (C4 pool re-review m3)
    logSecurityEvent('AUTH_LOGIN_FAILURE', 'warn', { userId: user.id, details: { attempts } });
    recordSignInFailure({ userId: user.id, locked });
    return null;
  }

  await identityDb.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
  const deviceId = counters.kind === 'device' ? counters.deviceId : await reusableDeviceId(user.id, now) ?? randomUUID();
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
 * A row of this account that no live cookie can name any more, taken over for a browser signing in without one (C4
 * ruling CR-5, option b), so the table does not grow by one row per cookieless sign-in. `lastSeenAt` is written only on a
 * success, the moment a cookie of that row gets its 30-day expiry, so a row last seen over 30 days ago is named only by
 * expired cookies, which readKnownDevice refuses. The oldest such row is claimed by one conditional update, so two
 * concurrent sign-ins never share it; the loser tries the next, and after three tries a new row is inserted instead. The
 * identity role has no DELETE on known_devices, so rows are recycled, not pruned. Null when there is none to take.
 */
async function reusableDeviceId(userId: string, now: Date): Promise<string | null> {
  const cutoff = new Date(now.getTime() - KNOWN_DEVICE_TTL_S * 1000);
  for (let attempt = 0; attempt < 3; attempt++) {
    const stale = await identityDb.knownDevice.findFirst({
      where: { userId, lastSeenAt: { lt: cutoff } }, orderBy: { lastSeenAt: 'asc' }, select: { id: true },
    });
    if (!stale) return null;
    const claimed = await identityDb.knownDevice.updateMany({
      where: { id: stale.id, userId, lastSeenAt: { lt: cutoff } },
      data: { failedCount: 0, lockedUntil: null, lastSeenAt: now },
    });
    if (claimed.count === 1) return stale.id;
  }
  return null;
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
