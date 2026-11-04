import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { checkRateLimit, resetRateLimitStore, RATE_LIMITS } from '@/lib/rate-limit';

/**
 * `proxy` is driven for real. The token is the only thing stubbed: `getToken` answers with the user named in
 * the `x-test-user-id` header, so a case chooses who it is without a session cookie; the security logger is
 * silenced because every case here refuses on purpose.
 */
vi.mock('next-auth/jwt', () => ({
  getToken: ({ req }: { req: Request }) => {
    const id = req.headers.get('x-test-user-id');
    return Promise.resolve(id ? { id } : null);
  },
}));
// `onRefusalLogged` runs where the proxy logs a first refusal, which is after the limiter has answered and
// before the proxy works out Retry-After: a case uses it to move the clock between the two.
let onRefusalLogged: (() => void) | null = null;
vi.mock('@/lib/security-logger', () => ({
  logSecurityEvent: (event: string) => { if (event === 'RATE_LIMIT_EXCEEDED') onRefusalLogged?.(); },
}));
const { proxy } = await import('@/proxy');

type Limit = { window: number; max: number; keyBy: 'ip' | 'userId' };

/**
 * The limit a request falls under, read through `checkRateLimit` alone, because `findConfig` is not exported:
 * `max` is the result's `limit`, the window is the distance to `resetAt` under a frozen clock, and the key is
 * the user when a second address with the same user shares the first one's bucket.
 */
function limitOf(method: string, path: string): Limit {
  resetRateLimitStore();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T08:00:00Z'));
  try {
    const first = checkRateLimit(method, path, '10.9.9.1', 'probe-user');
    const second = checkRateLimit(method, path, '10.9.9.2', 'probe-user');
    return {
      window: first.resetAt.getTime() - Date.now(),
      max: first.limit,
      keyBy: second.remaining < first.remaining || !second.success ? 'userId' : 'ip',
    };
  } finally {
    vi.useRealTimers();
    resetRateLimitStore();
  }
}

const HOUR = 60 * 60 * 1000;
const ip = '10.0.0.5';

/** Drives the proxy as `opts.userId` until it refuses (a 429, or the 303 of an export navigation) and returns that answer. */
async function exhaustAndCall(
  handler: typeof proxy, method: string, pathAndQuery: string,
  opts: { headers?: Record<string, string>; userId?: string } = {},
): Promise<Response> {
  const headers = { 'x-forwarded-for': ip, 'x-test-user-id': opts.userId ?? 'u', ...opts.headers };
  for (let i = 0; i < 500; i++) {
    const res = await handler(new NextRequest(`http://localhost${pathAndQuery}`, { method, headers }));
    if (res.status === 429 || res.status === 303) return res;
  }
  throw new Error(`${method} ${pathAndQuery} was never refused`);
}

beforeEach(() => {
  resetRateLimitStore();
  process.env.NEXTAUTH_SECRET ??= 'test-secret-for-rate-limit-v060';
});
afterEach(() => resetRateLimitStore());

describe('v0.6.0 rate-limit keys', () => {
  it('NFR-SEC-20: the eleventh document issue in an hour is limited, and previews count', () => {
    for (let i = 0; i < 10; i++) expect(checkRateLimit('POST', '/api/v1/orgs/a/projects/p/reviews/r/documents', ip, 'u').success).toBe(true);
    expect(checkRateLimit('POST', '/api/v1/orgs/a/projects/p/reviews/r/documents/preview', ip, 'u').success).toBe(false);
  });

  it('NFR-SEC-20 and section 6.2: seals 20 an hour, seal checks 20, team exports 3, personal exports 3, uploads 10 a minute', () => {
    expect(limitOf('POST', '/api/v1/orgs/a/projects/p/reviews/r/seals')).toEqual({ window: HOUR, max: 20, keyBy: 'userId' });
    expect(limitOf('GET', '/api/v1/orgs/a/projects/p/reviews/r/seals/s/check')).toEqual({ window: HOUR, max: 20, keyBy: 'userId' });
    expect(limitOf('GET', '/api/v1/orgs/a/export')).toEqual({ window: HOUR, max: 3, keyBy: 'userId' });
    expect(limitOf('GET', '/api/users/me/export')).toEqual({ window: HOUR, max: 3, keyBy: 'userId' });
    expect(limitOf('POST', '/api/v1/orgs/a/projects/p/evidence')).toEqual({ window: 60_000, max: 10, keyBy: 'userId' });
    expect(limitOf('POST', '/api/v1/orgs/a/projects/p/reviews/r/documents')).toEqual({ window: HOUR, max: 10, keyBy: 'userId' });
    expect(limitOf('POST', '/api/v1/orgs/a/projects/p/reviews/r/documents/preview')).toEqual({ window: HOUR, max: 10, keyBy: 'userId' });
  });

  it('NFR-SEC-20: a key counts all of its slugs and projects together, so a new slug is not a new budget (D-151)', () => {
    for (let i = 0; i < 3; i++) expect(checkRateLimit('GET', `/api/v1/orgs/org-${i}/export`, ip, 'u').success).toBe(true);
    expect(checkRateLimit('GET', '/api/v1/orgs/another/export', ip, 'u').success).toBe(false);
    // and another user is another budget
    expect(checkRateLimit('GET', '/api/v1/orgs/another/export', ip, 'v').success).toBe(true);
  });

  it('FR-MEM-01: no proxy key matches invitations or members/leave (the service counts invitations)', () => {
    expect(limitOf('POST', '/api/v1/orgs/a/members')).toEqual(RATE_LIMITS['default']);
    expect(limitOf('POST', '/api/v1/orgs/a/members/leave')).toEqual(RATE_LIMITS['default']);
    expect(limitOf('POST', '/api/v1/orgs/a/invitations/i/resend')).toEqual(RATE_LIMITS['default']);
    expect(limitOf('POST', '/api/v1/orgs/a/invitations/i/revoke')).toEqual(RATE_LIMITS['default']);
  });

  it('NFR-SEC-20: the keys that were there stay as they were', () => {
    // The two address-keyed sign-in keys are gone (FR-ACC-05, NFR-SEC-06, ruling 10); proxy.ts skips /api/auth/ paths.
    // ... except the per-account session-read keys (ruling RE-2).
    expect(Object.keys(RATE_LIMITS).filter((k) => k.includes('/api/auth')).sort()).toEqual(['GET:/api/auth/session$', 'POST:/api/auth/session$']);
    expect(limitOf('DELETE', '/api/users/me')).toEqual({ window: HOUR, max: 1, keyBy: 'userId' });
    expect(limitOf('POST', '/api/v1/orgs')).toEqual({ window: HOUR, max: 5, keyBy: 'userId' });
    // RM removes this key with the assessment routes.
    if ('POST:/api/v1/orgs/*/assessments/*/evidence' in RATE_LIMITS) {
      expect(limitOf('POST', '/api/v1/orgs/a/assessments/x/evidence')).toEqual({ window: 60_000, max: 10, keyBy: 'userId' });
    }
  });
});

describe('the proxy 429', () => {
  it('NFR-SEC-20 M-19: the proxy answers 429 with code rate_limited and retryAfterSeconds', async () => {
    const res = await exhaustAndCall(proxy, 'POST', '/api/v1/orgs/a/projects/p/evidence');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({ error: 'Too many requests. Please try again later.', code: 'rate_limited', retryAfterSeconds: Number(res.headers.get('Retry-After')) });
    expect(Number.isInteger(body.retryAfterSeconds) && body.retryAfterSeconds >= 1).toBe(true);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
  });
});

describe('the proxy 429 at the end of a window', () => {
  afterEach(() => { onRefusalLogged = null; vi.useRealTimers(); });

  it('NFR-SEC-20: retryAfterSeconds is at least one second when the window ends between the limiter and the answer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T08:00:00Z'));
    const headers = { 'x-forwarded-for': ip, 'x-test-user-id': 'late' };
    const send = () => proxy(new NextRequest('http://localhost/api/v1/orgs/a/projects/p/evidence', { method: 'POST', headers }));
    for (let i = 0; i < 10; i++) expect((await send()).status).toBe(200);
    onRefusalLogged = () => vi.setSystemTime(new Date('2026-11-02T08:01:30Z')); // the window ended at 08:01:00
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('1');
    expect((await res.json()).retryAfterSeconds).toBe(1);
  });
});

// route 20 (contract Routes row 20, Rate-limit keys; owner question B4): only the key 'GET:/api/v1/orgs/*/export', only a navigation
const ORG = 'acme-health';
const PID = '3f2b8c1e-5a47-4d0b-9e61-7c2d4a9b0f13';
const NAV = { 'sec-fetch-mode': 'navigate' };

describe('the proxy 303 for an export navigation', () => {
  it('NFR-SEC-20 (owner question B4): a refused navigation to the export goes back to S-20 with ?refused=rate_limited', async () => {
    // The Location is absolute, on the configured public origin (vitest.config.ts sets NEXTAUTH_URL): Next's proxy
    // layer parses a response Location with `new URL` and fails a relative one with ERR_INVALID_URL, a 500 (seen
    // live on port 3101), and the repo builds redirect targets from lib/publicOrigin.ts, never from the request.
    const origin = 'https://vitest.example.invalid';
    const org = await exhaustAndCall(proxy, 'GET', `/api/v1/orgs/${ORG}/export`, { headers: NAV, userId: 'u-nav-1' });
    expect([org.status, org.headers.get('location')]).toEqual([303, `${origin}/orgs/${ORG}/export?refused=rate_limited`]);
    const project = await exhaustAndCall(proxy, 'GET', `/api/v1/orgs/${ORG}/export?projectId=${PID}`, { headers: NAV, userId: 'u-nav-2' });
    expect([project.status, project.headers.get('location')]).toEqual([303, `${origin}/orgs/${ORG}/projects/${PID}/export?refused=rate_limited`]);
  });

  it('NFR-SEC-20 (owner question B4): when the public origin is not configured, a refused navigation keeps the JSON 429 and does not fail', async () => {
    // publicOrigin() throws without NEXTAUTH_URL or AUTH_URL; the refusal is already logged once per window, so the
    // redirect, a convenience, is dropped and the person still gets the refusal.
    const saved = { nextauth: process.env.NEXTAUTH_URL, auth: process.env.AUTH_URL };
    delete process.env.NEXTAUTH_URL;
    delete process.env.AUTH_URL;
    try {
      const res = await exhaustAndCall(proxy, 'GET', `/api/v1/orgs/${ORG}/export`, { headers: NAV, userId: 'u-nav-noorigin' });
      expect([res.status, res.headers.get('location')]).toEqual([429, null]);
      expect((await res.json()).code).toBe('rate_limited');
    } finally {
      if (saved.nextauth !== undefined) process.env.NEXTAUTH_URL = saved.nextauth;
      if (saved.auth !== undefined) process.env.AUTH_URL = saved.auth;
    }
  });

  it('NFR-SEC-20 (owner question B4): a fetch without the navigate header keeps the JSON 429', async () => {
    const res = await exhaustAndCall(proxy, 'GET', `/api/v1/orgs/${ORG}/export`, { headers: { 'sec-fetch-mode': 'cors' }, userId: 'u-fetch-1' });
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('rate_limited');
    expect(res.headers.get('location')).toBeNull();
    const bare = await exhaustAndCall(proxy, 'GET', `/api/v1/orgs/${ORG}/export`, { userId: 'u-fetch-2' });
    expect([bare.status, bare.headers.get('location')]).toEqual([429, null]);
  });

  it('NFR-SEC-20 (owner question B4): a slug or project id that fails its pattern keeps the JSON 429, and no other key redirects', async () => {
    const paths = [`/api/v1/orgs/Bad_Slug/export`, `/api/v1/orgs/${ORG}/export?projectId=not-a-uuid`, `/api/v1/orgs/${ORG}/export?projectId=${PID}/../x`, `/api/v1/orgs/${ORG}/export?projectId=`];
    for (const [i, path] of paths.entries()) {
      const res = await exhaustAndCall(proxy, 'GET', path, { headers: NAV, userId: `u-bad-${i}` });
      expect(res.status, path).toBe(429);
      expect((await res.json()).code, path).toBe('rate_limited');
    }
    // the personal export key: JSON 429 even for a navigation
    const other = await exhaustAndCall(proxy, 'GET', '/api/users/me/export', { headers: NAV, userId: 'u-other-1' });
    expect(other.status).toBe(429);
    expect(other.headers.get('location')).toBeNull();
    // a longer path under the same key, and another method, are not the export either
    const longer = await exhaustAndCall(proxy, 'GET', `/api/v1/orgs/${ORG}/export/extra`, { headers: NAV, userId: 'u-other-2' });
    expect([longer.status, longer.headers.get('location')]).toEqual([429, null]);
    const evidence = await exhaustAndCall(proxy, 'POST', `/api/v1/orgs/${ORG}/projects/${PID}/evidence`, { headers: NAV, userId: 'u-other-3' });
    expect([evidence.status, evidence.headers.get('location')]).toEqual([429, null]);
  });

  it('NFR-SEC-20 (owner question B4): the redirect answer has no body', async () => {
    const res = await exhaustAndCall(proxy, 'GET', `/api/v1/orgs/${ORG}/export`, { headers: NAV, userId: 'u-nav-body' });
    expect([res.status, await res.text()]).toEqual([303, '']);
  });

  it('NFR-MNT-01 (owner question B4): proxy.ts builds the redirect target with exportRefusalLocation and holds no slug or id pattern of its own', () => {
    const src = readFileSync('proxy.ts', 'utf8');
    expect(src).toContain('exportRefusalLocation(');
    expect(src).toContain('publicOrigin()');
    expect(src).not.toContain('[a-z0-9]+(?:-[a-z0-9]+)*');
    expect(src).not.toMatch(/\[0-9a-f\]\{8\}/);
  });
});
