import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { requireAuthSecret } from './secret';
import { usesSecureCookies } from './secureCookie';

/**
 * The known-device cookie (FR-ACC-05, calls R-2 and R-49). A browser that signed in to an account gets this cookie, and
 * while it holds it the account's sign-in failures from that browser are counted on its own `known_devices` row, so
 * failures from other browsers never lock it out.
 *
 * Value: `<deviceId>.<userId>.<expiry epoch seconds>.<base64url HMAC-SHA256 of the first three parts>`. The key is derived
 * from the auth secret with HKDF, so there is no new secret to provision; rotating `NEXTAUTH_SECRET` invalidates every
 * known-device cookie, which costs only the escape from a targeted lock-out until the next successful sign-in. The cookie
 * is bound to one account by the signed `userId`, and `lib/auth/credentials.ts` also requires a `known_devices` row with
 * that id and user, so a valid signature alone is not enough.
 */
export const KNOWN_DEVICE_COOKIE = 'makrai.kd';
export const KNOWN_DEVICE_TTL_S = 30 * 24 * 60 * 60;

const HKDF_INFO = 'makrai known-device v1';

/** Derived on each call, so a test (or a process) that changes the secret is never served a key from the old one. */
function key(): Buffer {
  return Buffer.from(hkdfSync('sha256', requireAuthSecret(), '', HKDF_INFO, 32));
}

function mac(payload: string): Buffer {
  return createHmac('sha256', key()).update(payload).digest();
}

export function signKnownDevice(d: { deviceId: string; userId: string }, now: Date): { value: string; expires: Date } {
  const expirySeconds = Math.floor(now.getTime() / 1000) + KNOWN_DEVICE_TTL_S;
  const payload = `${d.deviceId}.${d.userId}.${expirySeconds}`;
  return { value: `${payload}.${mac(payload).toString('base64url')}`, expires: new Date(expirySeconds * 1000) };
}

/** The cookie's value from a `Cookie` request header, or null when it is not there. */
function cookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * The device and account a valid cookie names, or null for a missing, malformed, wrongly signed or expired value. The
 * signature is compared with `timingSafeEqual`. A null here means "not a known device", never an error: the sign-in then
 * counts against the account, as for any other browser.
 */
export function readKnownDevice(cookieHeader: string | null, now: Date): { deviceId: string; userId: string } | null {
  if (!cookieHeader) return null;
  const value = cookieValue(cookieHeader, KNOWN_DEVICE_COOKIE);
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const [deviceId, userId, expiry, signature] = parts;
  if (!deviceId || !userId || !/^\d{1,12}$/.test(expiry)) return null;
  const expected = mac(`${deviceId}.${userId}.${expiry}`);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (Number(expiry) * 1000 <= now.getTime()) return null;
  return { deviceId, userId };
}

/**
 * Set only by the sign-in route and read only there, so the path is `/api/auth`: no page or other API request carries it.
 * `Secure` follows the session cookie's rule (lib/auth/secureCookie.ts), so local development over http still works.
 */
export function knownDeviceCookieOptions(expires: Date): { httpOnly: true; secure: boolean; sameSite: 'lax'; path: '/api/auth'; expires: Date } {
  return { httpOnly: true, secure: usesSecureCookies(), sameSite: 'lax', path: '/api/auth', expires };
}
