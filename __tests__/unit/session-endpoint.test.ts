import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { guardSessionRead, SESSION_PATH } from '../../lib/auth/sessionEndpoint';

/**
 * The session-read guard (NFR-SEC-07; obligation B21). next-auth's `GET` and `POST /api/auth/session` answer 200 with the
 * user and re-sign the cookie for any token that decodes, with no database check (lib/auth/callbacks.ts), so a session
 * the app refuses everywhere else (epoch raised, account inactive, past 7 days) would still read as signed in there and
 * have its expiry moved. The guard resolves the identity first on that one path; a refused session gets next-auth's own
 * answer for no session, with its session-token cookies cleared and nothing signed. The live half (a real cookie, a
 * running server) is e2e/account.spec.ts.
 */
const ID = { userId: 'u1', email: 'u1@fixture.test', name: 'U', platformRole: 'assessor', mustChangePassword: false };
const delegateResponse = () => new Response('{"user":{"id":"u1"}}', { status: 200, headers: { 'set-cookie': 'authjs.session-token=fresh; Max-Age=43200' } });
const request = (path: string, init: { method?: string; cookie?: string; body?: string } = {}) => new Request(`http://localhost${path}`, {
  method: init.method ?? 'GET',
  headers: init.cookie ? { cookie: init.cookie } : {},
  body: init.body,
});
const setCookies = (r: Response) => r.headers.getSetCookie();

describe('guardSessionRead', () => {
  it('NFR-SEC-07: the guarded path is /api/auth/session', () => {
    expect(SESSION_PATH).toBe('/api/auth/session');
  });

  it.each(['/api/auth/csrf', '/api/auth/providers', '/api/auth/signout', '/api/auth/callback/credentials', '/api/auth/sessionx'])(
    'NFR-SEC-07: %s goes straight to next-auth and reads no identity', async (path) => {
      const resolve = vi.fn(async () => null);
      const own = delegateResponse();
      const delegate = vi.fn(async () => own);
      const r = await guardSessionRead(request(path), delegate, { resolve });
      expect(resolve).not.toHaveBeenCalled();
      expect(delegate).toHaveBeenCalledTimes(1);
      expect(r).toBe(own);
    });

  it.each(['/api/auth/callback/credentials', '/api/auth/signout', '/api/auth/signin/credentials'])(
    'NFR-SEC-07: a POST to %s goes straight to next-auth and reads no identity', async (path) => {
      const resolve = vi.fn(async () => null);
      const own = delegateResponse();
      const delegate = vi.fn(async () => own);
      const r = await guardSessionRead(request(path, { method: 'POST', body: 'csrfToken=x' }), delegate, { resolve });
      expect(resolve).not.toHaveBeenCalled();
      expect(delegate).toHaveBeenCalledTimes(1);
      expect(r).toBe(own);
    });

  it('NFR-SEC-07 UX-43: a live session gets next-auth\'s own Response, unchanged', async () => {
    const own = delegateResponse();
    const delegate = vi.fn(async () => own);
    const req = request('/api/auth/session', { cookie: 'authjs.session-token=live' });
    const r = await guardSessionRead(req, delegate, { resolve: async () => ID });
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(delegate).toHaveBeenCalledWith(req);
    expect(r).toBe(own);
  });

  it('NFR-SEC-07: a live session\'s POST goes to next-auth unchanged', async () => {
    const own = delegateResponse();
    const delegate = vi.fn(async () => own);
    const req = request('/api/auth/session', { method: 'POST', cookie: 'authjs.session-token=live', body: 'csrfToken=x&data=%7B%7D' });
    const r = await guardSessionRead(req, delegate, { resolve: async () => ID });
    expect(delegate).toHaveBeenCalledWith(req);
    expect(r).toBe(own);
    expect(req.bodyUsed).toBe(false);
  });

  it('NFR-SEC-07: a refused session gets 200, null, next-auth\'s no-session headers and no fresh token', async () => {
    const delegate = vi.fn(async () => delegateResponse());
    const r = await guardSessionRead(request('/api/auth/session', { cookie: 'authjs.session-token=revoked' }), delegate, { resolve: async () => null });
    expect(delegate).not.toHaveBeenCalled();
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect([r.headers.get('cache-control'), r.headers.get('expires'), r.headers.get('pragma')]).toEqual(['private, no-cache, no-store', '0', 'no-cache']);
    expect(await r.json()).toBeNull();
    const cookies = setCookies(r);
    expect(cookies).toHaveLength(1);
    for (const c of cookies) {
      expect(c).toMatch(/^[^=]+=;/);
      expect(c).toMatch(/Max-Age=0/);
    }
  });

  it('NFR-SEC-07: a refused session clears every session-token cookie the request carried and no other', async () => {
    const cookie = 'authjs.session-token.0=a; authjs.session-token.1=b; __Secure-authjs.session-token=c; authjs.callback-url=x; authjs.csrf-token=y';
    const r = await guardSessionRead(request('/api/auth/session', { cookie }), vi.fn(), { resolve: async () => null });
    const cookies = setCookies(r);
    expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual(['__Secure-authjs.session-token', 'authjs.session-token.0', 'authjs.session-token.1']);
    for (const c of cookies) {
      const attrs = c.split(';').map((s) => s.trim());
      expect(attrs).toEqual(expect.arrayContaining(['Max-Age=0', 'Path=/', 'HttpOnly', 'SameSite=Lax']));
      expect(attrs.includes('Secure')).toBe(c.startsWith('__Secure-'));
    }
  });

  it('NFR-SEC-07: /api/auth/session/ with a trailing slash is guarded too', async () => {
    const delegate = vi.fn(async () => delegateResponse());
    const r = await guardSessionRead(request('/api/auth/session/'), delegate, { resolve: async () => null });
    expect(delegate).not.toHaveBeenCalled();
    expect(await r.json()).toBeNull();
  });

  it('NFR-SEC-07: a refused session\'s POST answers 200, null, with no cache headers and no fresh token', async () => {
    const delegate = vi.fn(async () => delegateResponse());
    const r = await guardSessionRead(request('/api/auth/session', { method: 'POST', cookie: 'authjs.session-token=revoked', body: 'data=%7B%7D' }), delegate, { resolve: async () => null });
    expect(delegate).not.toHaveBeenCalled();
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect([r.headers.get('cache-control'), r.headers.get('expires'), r.headers.get('pragma')]).toEqual([null, null, null]);
    expect(await r.json()).toBeNull();
    for (const c of setCookies(r)) expect(c).toMatch(/^[^=]+=;.*Max-Age=0/);
    expect(setCookies(r).some((c) => /session-token(\.\d+)?=[^;]/.test(c))).toBe(false);
  });

  it('NFR-SEC-07: a database failure propagates and is not answered as no session', async () => {
    const delegate = vi.fn(async () => delegateResponse());
    await expect(guardSessionRead(request('/api/auth/session'), delegate, { resolve: async () => { throw new Error('db down'); } })).rejects.toThrow('db down');
    expect(delegate).not.toHaveBeenCalled();
  });

  it('NFR-SEC-07: the guard imports neither auth nor next-auth/jwt', () => {
    const src = readFileSync('lib/auth/sessionEndpoint.ts', 'utf8');
    expect(src).not.toMatch(/from\s+['"](@\/lib\/auth|\.\.\/auth|\.\/\.\.\/auth)['"]/);
    expect(src).not.toMatch(/import\(\s*['"](@\/lib\/auth|\.\.\/auth)['"]\s*\)/);
    expect(src).not.toMatch(/next-auth\/jwt/);
  });

  it('NFR-SEC-07: the route wraps GET and POST with the guard and exports nothing else', () => {
    const src = readFileSync('app/api/auth/[...nextauth]/route.ts', 'utf8');
    expect(src).toMatch(/export function GET\([^)]*\)[^{]*\{\s*return guardSessionRead\(/);
    expect(src).toMatch(/export function POST\([^)]*\)[^{]*\{\s*return guardSessionRead\(/);
    expect([...src.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)].map((m) => m[1])).toEqual(['GET', 'POST']);
  });
});
