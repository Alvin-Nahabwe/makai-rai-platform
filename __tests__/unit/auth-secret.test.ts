import { describe, it, expect, afterEach } from 'vitest';
import { encode, getToken } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

/**
 * Fix round 1, Important 2. `requireAuthSecret()` (lib/auth/secret.ts) is
 * the ONE place that reads NEXTAUTH_SECRET, shared between `lib/auth.ts`'s
 * NextAuth() config and `proxy.ts`'s standalone `getToken()` call -- see
 * that module's own doc comment for why the two need to read the identical
 * value and previously did not (D-114/D-151/D-124, task-6-report.md fix
 * round 1). Tested in isolation, matching how `lib/data/connection.ts`'s
 * `requireDatabaseUrl` (the pattern this mirrors) is tested by the routes
 * that call it -- there is no dedicated requireDatabaseUrl test file
 * either, but this function is new and small enough to warrant a direct
 * one given how much rides on it being correct.
 */
describe('requireAuthSecret', () => {
  const original = process.env.NEXTAUTH_SECRET;

  afterEach(() => {
    if (original === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = original;
  });

  it('returns NEXTAUTH_SECRET when set', async () => {
    process.env.NEXTAUTH_SECRET = 'a-real-looking-secret-value';
    const { requireAuthSecret } = await import('../../lib/auth/secret');
    expect(requireAuthSecret()).toBe('a-real-looking-secret-value');
  });

  it('throws when NEXTAUTH_SECRET is unset -- fails closed rather than returning undefined for getToken to silently mishandle', async () => {
    delete process.env.NEXTAUTH_SECRET;
    const { requireAuthSecret } = await import('../../lib/auth/secret');
    expect(() => requireAuthSecret()).toThrow(/NEXTAUTH_SECRET/);
  });

  it('throws when NEXTAUTH_SECRET is an empty string', async () => {
    process.env.NEXTAUTH_SECRET = '';
    const { requireAuthSecret } = await import('../../lib/auth/secret');
    expect(() => requireAuthSecret()).toThrow(/NEXTAUTH_SECRET/);
  });
});

/**
 * The end-to-end proof `proxy.ts`'s fix actually works, not merely that it
 * stops throwing. Reproduces exactly what `proxy.ts` now does: calls the
 * REAL `getToken` from `next-auth/jwt` with `secret: requireAuthSecret()`,
 * against a REAL session cookie encoded with `encode()` (also from
 * `next-auth/jwt`, the exact library NextAuth itself uses to mint one at
 * login) using the SAME secret and the SAME default cookie name/salt --
 * confirmed live (task-6-report.md) that `@auth/core/jwt`'s `getToken`
 * defaults `salt` to `cookieName`, so nothing beyond `secret` needs to be
 * threaded through for this to round-trip correctly.
 */
describe('proxy.ts secret fix: getToken round-trips a real session token', () => {
  const original = process.env.NEXTAUTH_SECRET;
  const TEST_SECRET = 'auth-secret-fix-round-trip-test-value';

  afterEach(() => {
    if (original === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = original;
  });

  it('decodes a real signed session cookie and recovers the userId, using requireAuthSecret() the same way proxy.ts does', async () => {
    process.env.NEXTAUTH_SECRET = TEST_SECRET;
    const { requireAuthSecret } = await import('../../lib/auth/secret');

    const encoded = await encode({
      token: { id: 'real-user-id-42', sessionEpoch: 0 },
      secret: requireAuthSecret(),
      salt: 'authjs.session-token', // next-auth's default (non-secure) cookie name
    });

    const req = new NextRequest('http://localhost/api/v1/orgs/acme/projects', {
      headers: { cookie: `authjs.session-token=${encoded}` },
    });

    // The exact call shape proxy.ts now makes.
    const token = await getToken({ req, secret: requireAuthSecret() });

    expect(token).not.toBeNull();
    expect(token?.id).toBe('real-user-id-42');
  });

  it('BEFORE this fix (no secret passed), the identical cookie throws MissingSecret rather than decoding -- proves the fix is load-bearing, not incidental', async () => {
    process.env.NEXTAUTH_SECRET = TEST_SECRET;
    const { requireAuthSecret } = await import('../../lib/auth/secret');

    const encoded = await encode({
      token: { id: 'real-user-id-42', sessionEpoch: 0 },
      secret: requireAuthSecret(),
      salt: 'authjs.session-token',
    });

    const req = new NextRequest('http://localhost/api/v1/orgs/acme/projects', {
      headers: { cookie: `authjs.session-token=${encoded}` },
    });

    // proxy.ts's OLD call shape -- no `secret`.
    await expect(getToken({ req })).rejects.toThrow(/secret/i);
  });
});
