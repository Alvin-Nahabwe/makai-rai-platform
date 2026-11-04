import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { isSignInPath, RATE_LIMITS, resetRateLimitStore } from '../../lib/rate-limit';

/**
 * Ruling 10 (SRS FR-ACC-05, NFR-SEC-06; obligation B6): many people sign in from one institutional address, so no layer
 * may limit sign-in by the client address. Sign-in is limited per account (lib/auth/credentials.ts) and by the
 * process-wide admission (lib/auth/signInAdmission.ts) only. Here: the application's half. nginx's half is
 * __tests__/lint/nginx-sign-in.test.ts.
 *
 * `getToken` is stubbed to no session, so every request is unauthenticated and the default rule would key on the address.
 */
vi.mock('next-auth/jwt', () => ({ getToken: () => Promise.resolve(null) }));
vi.mock('../../lib/security-logger', () => ({ logSecurityEvent: () => {} }));
const { proxy } = await import('../../proxy');

function req(method: string, path: string, ip: string) {
  return new NextRequest(`http://localhost${path}`, { method, headers: { 'x-forwarded-for': ip } });
}

beforeEach(() => resetRateLimitStore());

describe('no sign-in limit keyed on the address (NFR-SEC-06)', () => {
  it('NFR-SEC-06: no layer keys sign-in on the client address', async () => {
    expect(Object.keys(RATE_LIMITS).filter((k) => k.includes('/api/auth'))).toEqual([]);
    for (const p of ['/api/auth/callback/credentials', '/api/auth/csrf', '/api/auth/session', '/api/auth/signout']) expect(isSignInPath(p)).toBe(true);
    for (const p of ['/api/authx', '/api/users/me', '/api/v1/orgs/x/projects', '/login']) expect(isSignInPath(p)).toBe(false);
    for (let i = 0; i < 200; i++) expect((await proxy(req('POST', '/api/auth/callback/credentials', '10.0.0.1'))).status).not.toBe(429);
    for (let i = 0; i < 200; i++) expect((await proxy(req('GET', '/api/auth/session', '10.0.0.1'))).status).not.toBe(429);
  });

  it('NFR-SEC-06: the default rule still applies to every other API path', async () => {
    const max = RATE_LIMITS.default.max;
    for (let i = 0; i < max; i++) expect((await proxy(req('GET', '/api/v1/orgs/x/projects', '10.0.0.2'))).status).not.toBe(429);
    expect((await proxy(req('GET', '/api/v1/orgs/x/projects', '10.0.0.2'))).status).toBe(429);
  });

  it('UX-01: a sign-in path still never hands the handler a client-sent x-pathname', async () => {
    const res = await proxy(new NextRequest('http://localhost/api/auth/session', { headers: { 'x-pathname': '/account', 'x-forwarded-for': '10.0.0.3' } }));
    expect(res.headers.get('x-middleware-request-x-pathname')).toBeNull();
    expect((res.headers.get('x-middleware-override-headers') ?? '').split(',')).not.toContain('x-pathname');
  });
});
