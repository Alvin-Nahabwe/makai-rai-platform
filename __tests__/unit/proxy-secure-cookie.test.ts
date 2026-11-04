import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { resetRateLimitStore } from '../../lib/rate-limit';

/**
 * Behind HTTPS the session cookie is named `__Secure-authjs.session-token`,
 * and `proxy.ts` must find it.
 *
 * This is DEP-04 of the 2026-08-17 platform audit, rated High and never fixed.
 * `getToken` derives BOTH the cookie it looks for and the salt it decrypts with
 * from the same value: `node_modules/@auth/core/jwt.js:86` reads
 * `cookieName = defaultCookies(secureCookie ?? false).sessionToken.name` and
 * then `salt = cookieName`. Called with no `secureCookie`, it looks for the
 * unprefixed `authjs.session-token` and salts with that name.
 *
 * Production writes the other one. `@auth/core/lib/init.js:69` picks the cookie
 * set via `config.useSecureCookies ?? url.protocol === "https:"`, and
 * `cookie.js:45` prefixes it `__Secure-` when that is true. With
 * `NEXTAUTH_URL=https://makrai.org` the cookie is therefore
 * `__Secure-authjs.session-token` -- a name `getToken` never looks for, salted
 * with a value it never uses.
 *
 * The failure is SILENT: `null` is also the legitimate answer for a request
 * with no cookie, so every authenticated request looks anonymous to the proxy
 * and every `keyBy: 'userId'` rule silently degrades to IP keying. For the
 * NAT'd classroom population this limiter is explicitly built for
 * (`lib/rate-limit.ts:2-4`), a whole lab then shares one 60/min bucket and one
 * account-deletion per hour.
 *
 * No existing test could catch it: Playwright runs over http
 * (`playwright.config.ts:19`), so the e2e suite never sees the secure cookie
 * name at all. That is why this test forces the production shape directly.
 *
 * WHAT IT ASSERTS, and why this shape rather than inspecting the token: two
 * requests carrying the SAME session from DIFFERENT client IPs. Under correct
 * userId keying they share a bucket, so the second is refused. Under the
 * IP-keyed fallback they are two different keys and both pass. The assertion is
 * therefore about behaviour a user would experience, not about an internal.
 */

const SECRET = 'test-secret-for-secure-cookie-resolution';
const SECURE_COOKIE = '__Secure-authjs.session-token';
/** max 5 per hour, keyBy userId (lib/rate-limit.ts, 'DELETE:/api/users/me'; 5 since the EXP route 39 ruling) */
const USERID_KEYED_PATH = '/api/users/me';
const USERID_KEYED_MAX = 5;

let originalUrl: string | undefined;
let originalSecret: string | undefined;

beforeEach(() => {
  originalUrl = process.env.NEXTAUTH_URL;
  originalSecret = process.env.NEXTAUTH_SECRET;
  // The production shape: HTTPS, which is what makes the cookie name secure.
  process.env.NEXTAUTH_URL = 'https://makrai.org';
  process.env.NEXTAUTH_SECRET = SECRET;
  resetRateLimitStore();
});

afterEach(() => {
  if (originalUrl === undefined) delete process.env.NEXTAUTH_URL;
  else process.env.NEXTAUTH_URL = originalUrl;
  if (originalSecret === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = originalSecret;
});

/** A session cookie exactly as production writes it: prefixed name, salted with that name. */
async function productionSessionCookie(userId: string): Promise<string> {
  const token = await encode({
    token: { sub: userId, id: userId },
    secret: SECRET,
    salt: SECURE_COOKIE,
  });
  return `${SECURE_COOKIE}=${token}`;
}

function request(cookie: string, ip: string): NextRequest {
  return new NextRequest(`https://makrai.org${USERID_KEYED_PATH}`, {
    method: 'DELETE',
    headers: { cookie, 'x-forwarded-for': ip },
  });
}

describe('proxy resolves the session cookie under its production (HTTPS) name', () => {
  it('keys a userId rule by the user, so the same session from a second IP is refused', async () => {
    const { proxy } = await import('../../proxy');
    const cookie = await productionSessionCookie('user-aaa');

    for (let i = 0; i < USERID_KEYED_MAX; i++) {
      const allowed = await proxy(request(cookie, '203.0.113.10'));
      expect(allowed.status, `request ${i + 1} of a ${USERID_KEYED_MAX}/hour rule must be allowed`).not.toBe(429);
    }

    // Same user, different client IP. Under userId keying this is the SAME
    // bucket. Under the IP fallback it is a different one and this passes.
    const second = await proxy(request(cookie, '203.0.113.11'));
    expect(
      second.status,
      'the same session from a second IP was allowed through a keyBy:userId ' +
        'rule, which means the proxy did not resolve the session and fell back ' +
        'to IP keying -- the silent DEP-04 degradation',
    ).toBe(429);
  });

  it('still treats genuinely anonymous requests as anonymous', async () => {
    // Guards the obvious over-correction: resolving a cookie that is not there.
    const { proxy } = await import('../../proxy');
    const a = await proxy(request('', '203.0.113.20'));
    const b = await proxy(request('', '203.0.113.21'));
    expect([a.status, b.status], 'two anonymous requests from different IPs are different buckets').not.toContain(429);
  });
});
