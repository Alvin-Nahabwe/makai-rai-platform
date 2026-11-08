import { beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWN_DEVICE_COOKIE,
  KNOWN_DEVICE_TTL_S,
  knownDeviceCookieOptions,
  readKnownDevice,
  signKnownDevice,
} from '../../lib/auth/knownDevice';

/**
 * The known-device cookie (FR-ACC-05, calls R-2 and R-49): a browser that signed in to an account keeps its own failure
 * count, so failures from other browsers never lock it out. Its value is signed with a key derived from the auth secret,
 * so a forged, altered, expired or other-account value reads as no known device (obligation B3).
 */
beforeAll(() => {
  process.env.NEXTAUTH_SECRET ??= 'test-secret-for-known-device-cookie-0123456789';
});

describe('known-device cookie', () => {
  it('FR-ACC-05: a signed cookie reads back; a tampered, expired or other-account cookie is not a known device', () => {
    const now = new Date('2026-11-02T08:00:00Z');
    const { value, expires } = signKnownDevice({ deviceId: 'd1', userId: 'u1' }, now);
    expect(expires.getTime()).toBe(now.getTime() + KNOWN_DEVICE_TTL_S * 1000);
    expect(readKnownDevice(`${KNOWN_DEVICE_COOKIE}=${value}`, now)).toEqual({ deviceId: 'd1', userId: 'u1' });
    // Among other cookies, as a browser sends them.
    expect(readKnownDevice(`a=b; ${KNOWN_DEVICE_COOKIE}=${value}; c=d`, now)).toEqual({ deviceId: 'd1', userId: 'u1' });
    // Another account's id, with the first account's signature.
    expect(readKnownDevice(`${KNOWN_DEVICE_COOKIE}=${value.replace('.u1.', '.u2.')}`, now)).toBeNull();
    // A later expiry with the old signature.
    const [d, u, exp, sig] = value.split('.');
    expect(readKnownDevice(`${KNOWN_DEVICE_COOKIE}=${d}.${u}.${Number(exp) + 3600}.${sig}`, now)).toBeNull();
    // Past its 30 days.
    expect(readKnownDevice(`${KNOWN_DEVICE_COOKIE}=${value}`, new Date(now.getTime() + (KNOWN_DEVICE_TTL_S + 1) * 1000))).toBeNull();
    expect(readKnownDevice(`${KNOWN_DEVICE_COOKIE}=garbage`, now)).toBeNull();
    expect(readKnownDevice(`${KNOWN_DEVICE_COOKIE}=a.b.c.d.e`, now)).toBeNull();
    expect(readKnownDevice(null, now)).toBeNull();
    expect(readKnownDevice('', now)).toBeNull();
    expect(knownDeviceCookieOptions(now)).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/api/auth', expires: now });
  });

  it('FR-ACC-05: the signature depends on the auth secret', () => {
    const now = new Date('2026-11-02T08:00:00Z');
    const { value } = signKnownDevice({ deviceId: 'd1', userId: 'u1' }, now);
    const saved = process.env.NEXTAUTH_SECRET;
    process.env.NEXTAUTH_SECRET = 'a-different-secret-for-the-known-device-test-0123';
    try {
      expect(readKnownDevice(`${KNOWN_DEVICE_COOKIE}=${value}`, now)).toBeNull();
    } finally {
      process.env.NEXTAUTH_SECRET = saved;
    }
  });
});
