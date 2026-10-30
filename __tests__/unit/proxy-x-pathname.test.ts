import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetRateLimitStore } from '../../lib/rate-limit';

/**
 * UX-01 (7.1.2: the gates run on every page request; gate 2 is must-change-password): `x-pathname` is the proxy's value
 * or it is absent, never the client's. `requireIdentity()` reads it to decide which page a flagged account is on, and
 * `requireIdentityForApi` will read it for gate 3 (ACC-a).
 *
 * This file calls `proxy()` itself. NextResponse.next() tells the runtime what request headers the handler sees by
 * `x-middleware-override-headers` (the names it keeps) and one `x-middleware-request-<name>` per kept header
 * (node_modules/next/dist/server/web/spec-extension/response.js); a response with no override list leaves the request's
 * own headers as the client sent them. `handlerSees` reads that contract.
 */
vi.mock('next-auth/jwt', () => ({ getToken: () => Promise.resolve(null) }));

const { proxy } = await import('../../proxy');

function handlerSees(res: Response, request: NextRequest, name: string): string | null {
  const override = res.headers.get('x-middleware-override-headers');
  if (override === null) return request.headers.get(name);
  if (!override.split(',').includes(name)) return null;
  return res.headers.get(`x-middleware-request-${name}`);
}

beforeEach(() => {
  resetRateLimitStore();
  process.env.NEXTAUTH_SECRET ??= 'test-secret-for-proxy-x-pathname';
});

describe('proxy and the x-pathname header', () => {
  it('UX-01: on /api/* the proxy removes a client\'s x-pathname, so no route handler reads the client\'s value', async () => {
    const request = new NextRequest('http://localhost/api/v1/x', { headers: { 'x-pathname': '/account', 'x-forwarded-for': '10.1.0.1' } });
    const res = await proxy(request);
    expect(res.status).toBe(200);
    expect(handlerSees(res, request, 'x-pathname')).toBeNull();
    // The rest of the request is unchanged: the handler still sees the other headers, and the answer carries the rate-limit headers.
    expect(handlerSees(res, request, 'x-forwarded-for')).toBe('10.1.0.1');
    expect(res.headers.get('X-RateLimit-Limit')).not.toBeNull();
  });

  it('UX-01: a request to /api/* with no x-pathname keeps none', async () => {
    const request = new NextRequest('http://localhost/api/v1/x', { headers: { 'x-forwarded-for': '10.1.0.2' } });
    const res = await proxy(request);
    expect(handlerSees(res, request, 'x-pathname')).toBeNull();
  });

  it('UX-01: on a page path the proxy sets x-pathname to the real pathname, whatever the client sent, in any case and twice', async () => {
    // A dynamic segment takes a name ending in .png, so this path reaches a page layout (and used to skip the proxy).
    const headers = new Headers();
    headers.append('X-Pathname', '/change-password');
    headers.append('x-pathname', '/account');
    headers.append('X-PATHNAME', '/acceptances');
    for (const path of ['/orgs/acme/projects/missing.png', '/orgs/acme/projects/missing.svg', '/does-not-exist.ico', '/orgs/acme/dashboard']) {
      const request = new NextRequest(`http://localhost${path}`, { headers });
      const res = await proxy(request);
      expect(res.headers.get('x-middleware-request-x-pathname'), path).toBe(path);
      expect(handlerSees(res, request, 'x-pathname'), path).toBe(path);
      // Exactly one x-pathname among the kept headers.
      expect((res.headers.get('x-middleware-override-headers') ?? '').split(',').filter((n) => n === 'x-pathname'), path).toHaveLength(1);
    }
  });
});
