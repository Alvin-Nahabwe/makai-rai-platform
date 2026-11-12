import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { UnauthenticatedError, PasswordChangeRequiredError } from '@/lib/auth/identity';
import { NotFoundError, ForbiddenError } from '@/lib/data/tenant';
import { AppError } from '@/lib/http/errors';
import { isNavigation, navigationRefusal } from '@/lib/http/navigationRefusal';

/**
 * U12 (e). A download address a browser opens as a page must not leave raw JSON on the screen when the session has
 * ended. The obligations (each is one test below): only a browser navigation is redirected; the target is fixed
 * and never taken from the request; the reason depends on the person's session and never on the resource, so a
 * missing, foreign and existing resource look the same; every other refusal is left to `toResponse`.
 */

const ORIGIN = 'https://rai.example.org';
const req = (url: string, headers: Record<string, string> = {}, method = 'GET') => new NextRequest(url, { method, headers });
const NAV = { 'sec-fetch-mode': 'navigate' };

beforeEach(() => { vi.stubEnv('AUTH_URL', ORIGIN); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('isNavigation', () => {
  it('is true for a browser navigation and false for a fetch, an API client and a request with no header', () => {
    expect(isNavigation(req('http://x/api/a', NAV))).toBe(true);
    for (const mode of ['cors', 'same-origin', 'no-cors', 'websocket']) expect(isNavigation(req('http://x/api/a', { 'sec-fetch-mode': mode }))).toBe(false);
    expect(isNavigation(req('http://x/api/a'))).toBe(false);
  });
});

describe('navigationRefusal', () => {
  it('sends a signed-out navigation to the sign-in page on the public origin, with a 303 and no caching', () => {
    const res = navigationRefusal(req('http://0.0.0.0:3000/api/users/me/export', NAV), new UnauthenticatedError());
    expect(res?.status).toBe(303);
    expect(res?.headers.get('location')).toBe(`${ORIGIN}/login?reason=signed_out`);
    expect(res?.headers.get('cache-control')).toBe('no-store');
  });

  it('sends a navigation of an account that must change its password to /change-password', () => {
    const res = navigationRefusal(req('http://x/api/users/me/export', NAV), new PasswordChangeRequiredError());
    expect(res?.headers.get('location')).toBe(`${ORIGIN}/change-password`);
  });

  it('answers null for a request that is not a navigation, so the JSON status and body are the route\'s own', () => {
    expect(navigationRefusal(req('http://x/api/users/me/export'), new UnauthenticatedError())).toBeNull();
    expect(navigationRefusal(req('http://x/api/users/me/export', { 'sec-fetch-mode': 'cors' }), new UnauthenticatedError())).toBeNull();
  });

  it('never takes the target from the request: a hostile query, referer, host and origin change nothing', () => {
    const res = navigationRefusal(
      req('http://evil.example/api/users/me/export?next=https://evil.example&callbackUrl=//evil.example', { ...NAV, referer: 'https://evil.example/', origin: 'https://evil.example', host: 'evil.example', 'x-forwarded-host': 'evil.example' }),
      new UnauthenticatedError(),
    );
    expect(res?.headers.get('location')).toBe(`${ORIGIN}/login?reason=signed_out`);
  });

  it('leaves every other refusal alone, so existence is never told apart through a redirect', () => {
    for (const e of [new NotFoundError(), new ForbiddenError('record:read', 'viewer'), new AppError(404, 'not_found'), new AppError(410, 'erased'), new AppError(429, 'rate_limited'), new Error('boom')]) {
      expect(navigationRefusal(req('http://x/api/a', NAV), e), String(e.constructor.name)).toBeNull();
    }
  });

  it('answers null, to keep the JSON answer, when no public origin is configured', () => {
    vi.stubEnv('AUTH_URL', undefined);
    vi.stubEnv('NEXTAUTH_URL', undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(navigationRefusal(req('http://x/api/a', NAV), new UnauthenticatedError())).toBeNull();
  });
});
