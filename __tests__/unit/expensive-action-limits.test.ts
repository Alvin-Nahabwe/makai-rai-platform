import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { checkRateLimit, resetRateLimitStore } from '../../lib/rate-limit';

/**
 * NFR-SEC-20 (SRS line 3009), "Verified by": the actions that cost the most server time are limited per account, an
 * hour at a time: documents (issues and previews together) 10, seals 20, seal checks 20, team exports 3 and personal
 * exports 3. K0b added the keys (contract "Rate-limit keys"); this proves them. The two concurrent team exports
 * (`export_busy`) are EXP's.
 *
 * The proxy case signs the session as u1 through `getToken`, which is stubbed: the limiter keys on the token's id.
 */
const session = vi.hoisted(() => ({ id: 'u1' as string | null }));
vi.mock('next-auth/jwt', () => ({ getToken: () => Promise.resolve(session.id ? { id: session.id } : null) }));
vi.mock('../../lib/security-logger', () => ({ logSecurityEvent: () => {} }));
const { proxy } = await import('../../proxy');

beforeEach(() => {
  resetRateLimitStore();
  session.id = 'u1';
});

describe('per-account limits on the expensive actions (NFR-SEC-20)', () => {
  it.each([
    ['POST', '/api/v1/orgs/o/projects/p/reviews/r/documents', 10],
    ['POST', '/api/v1/orgs/o/projects/p/reviews/r/documents/preview', 10],
    ['POST', '/api/v1/orgs/o/projects/p/reviews/r/seals', 20],
    ['GET', '/api/v1/orgs/o/projects/p/reviews/r/seals/s/check', 20],
    ['GET', '/api/v1/orgs/o/export', 3],
    ['GET', '/api/users/me/export', 3],
  ])('NFR-SEC-20: %s %s allows %i an hour per account, then 429 with the wait', (method, path, max) => {
    for (let i = 0; i < max; i++) expect(checkRateLimit(method, path, '1.1.1.1', 'u1').success).toBe(true);
    const r = checkRateLimit(method, path, '1.1.1.1', 'u1');
    expect([r.success, r.limit]).toEqual([false, max]);
    expect(r.resetAt.getTime() - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    expect(checkRateLimit(method, path, '1.1.1.1', 'u2').success).toBe(true); // per account, not per address
  });

  it('NFR-SEC-20: the account budget spans organisations and objects', () => {
    for (let i = 0; i < 10; i++) expect(checkRateLimit('POST', `/api/v1/orgs/o${i}/projects/p${i}/reviews/r${i}/documents`, '1.1.1.1', 'u1').success).toBe(true);
    expect(checkRateLimit('POST', '/api/v1/orgs/x/projects/y/reviews/z/documents/preview', '1.1.1.1', 'u1').success).toBe(false);
  });

  it('NFR-SEC-20: the proxy answers the 11th document in an hour with 429 rate_limited and retryAfterSeconds', async () => {
    const req = () => new NextRequest('http://localhost/api/v1/orgs/o/projects/p/reviews/r/documents', { method: 'POST', headers: { 'x-forwarded-for': '10.9.9.9' } });
    for (let i = 0; i < 10; i++) expect((await proxy(req())).status).not.toBe(429);
    const refused = await proxy(req());
    expect(refused.status).toBe(429);
    const body = await refused.json();
    expect(body).toMatchObject({ code: 'rate_limited' });
    expect(body.retryAfterSeconds).toBeGreaterThan(59 * 60);
    expect(refused.headers.get('retry-after')).toBe(String(body.retryAfterSeconds));
    // Another account from the same address still has its own budget.
    session.id = 'u2';
    expect((await proxy(req())).status).not.toBe(429);
  });
});
