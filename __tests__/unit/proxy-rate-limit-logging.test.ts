import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetRateLimitStore, RATE_LIMITS } from '../../lib/rate-limit';

/**
 * C6 whole-branch review, orphan sweep. `RATE_LIMIT_EXCEEDED` was declared
 * in `lib/security-logger.ts`'s `SecurityEvent` union and emitted by
 * nothing. `proxy.ts` built the 429 and returned it without logging -- in a
 * file that already imports `logSecurityEvent` and calls it two blocks
 * earlier for `AUTH_TOKEN_DECODE_FAILURE`. The consequence is narrow but
 * bad: the structured log is silent during exactly the traffic pattern the
 * limiter exists to blunt, so a credential-stuffing or upload-flood attempt
 * leaves no trace in the one stream an operator would look at.
 *
 * `proxy` is exercised for real here (not mocked): the rate-limit store is
 * process-local (`lib/rate-limit.ts`), so driving the same key past its
 * configured max is enough to reach the 429 branch. `getToken` is stubbed
 * to return null -- an unauthenticated request keys on IP, which is what
 * these probes want, and it avoids needing a real session cookie.
 */
const getTokenMock = vi.hoisted(() => vi.fn((): Promise<unknown> => Promise.resolve(null)));
vi.mock('next-auth/jwt', () => ({ getToken: getTokenMock }));

const loggerState = vi.hoisted(() => ({ throws: false }));
const logged: Array<{ event: string; severity: string; ctx?: Record<string, unknown> }> = [];
vi.mock('../../lib/security-logger', () => ({
  logSecurityEvent: (event: string, severity: string, ctx?: Record<string, unknown>) => {
    if (loggerState.throws) throw new Error('logger down');
    logged.push({ event, severity, ctx });
  },
}));

// Imported AFTER the mocks above so `proxy` binds the mocked module.
const { proxy } = await import('../../proxy');

// An address-keyed probe with no session: DELETE /api/users/me (key DELETE:/api/users/me$, 5 an hour) keys on the address when no user is
// known. The sign-in paths it used are no longer limited by address (FR-ACC-05, NFR-SEC-06).
const LIMITED_PATH = '/api/users/me';

function req(ip: string) {
  return new NextRequest(`http://localhost${LIMITED_PATH}`, {
    method: 'DELETE',
    headers: { 'x-forwarded-for': ip },
  });
}

beforeEach(() => {
  resetRateLimitStore();
  logged.length = 0;
  getTokenMock.mockReset();
  getTokenMock.mockImplementation(() => Promise.resolve(null));
  process.env.NEXTAUTH_SECRET ??= 'test-secret-for-proxy-rate-limit-logging';
});

afterEach(() => {
  resetRateLimitStore();
});

describe('proxy emits RATE_LIMIT_EXCEEDED when it returns a 429', () => {
  it('logs nothing for requests inside the budget', async () => {
    const max = RATE_LIMITS[`DELETE:${LIMITED_PATH}$`].max;
    for (let i = 0; i < max; i++) {
      const res = await proxy(req('10.0.0.1'));
      expect(res.status).not.toBe(429);
    }
    expect(logged.filter((e) => e.event === 'RATE_LIMIT_EXCEEDED')).toHaveLength(0);
  });

  /**
   * NON-VACUITY: the case above drives the SAME path, SAME IP, SAME method
   * right up to the limit and asserts ZERO log lines. So this test's single
   * log line can only come from the request that actually got refused --
   * not from something the proxy logs on every call.
   */
  it('logs exactly one RATE_LIMIT_EXCEEDED, at warn, on the request it refuses', async () => {
    const max = RATE_LIMITS[`DELETE:${LIMITED_PATH}$`].max;
    for (let i = 0; i < max; i++) await proxy(req('10.0.0.2'));
    const refused = await proxy(req('10.0.0.2'));

    expect(refused.status).toBe(429);
    const events = logged.filter((e) => e.event === 'RATE_LIMIT_EXCEEDED');
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe('warn');
  });

  /**
   * `code-review` finding on this very fix: emitting one line per REFUSED
   * request makes log volume track attack volume 1:1, with an
   * attacker-controlled `x-forwarded-for` and pathname in every line --
   * turning a security control into a log-amplification vector, since
   * `entry.count` keeps incrementing long past the max. Logging the
   * TRANSITION instead (the first refusal in each window) keeps the whole
   * signal an operator needs -- that the limit was breached, by which
   * identifier, on which path, and when the window resets -- at one line
   * per window rather than per request.
   */
  it('logs ONCE per window however many requests are refused after the first', async () => {
    const max = RATE_LIMITS[`DELETE:${LIMITED_PATH}$`].max;
    for (let i = 0; i < max; i++) await proxy(req('10.0.0.4'));
    for (let i = 0; i < 25; i++) {
      const res = await proxy(req('10.0.0.4'));
      expect(res.status).toBe(429);
    }
    expect(logged.filter((e) => e.event === 'RATE_LIMIT_EXCEEDED')).toHaveLength(1);
  });

  it('logs again for a DIFFERENT identifier -- the suppression is per bucket, not global', async () => {
    const max = RATE_LIMITS[`DELETE:${LIMITED_PATH}$`].max;
    for (const ip of ['10.0.0.5', '10.0.0.6']) {
      for (let i = 0; i < max; i++) await proxy(req(ip));
      await proxy(req(ip));
      await proxy(req(ip));
    }
    const events = logged.filter((e) => e.event === 'RATE_LIMIT_EXCEEDED');
    expect(events).toHaveLength(2);
    for (const e of events) expect(e.ctx).not.toHaveProperty('ip');
  });

  it('records the path that was refused and no client address (NFR-OBS-01, NFR-PRIV-03)', async () => {
    const max = RATE_LIMITS[`DELETE:${LIMITED_PATH}$`].max;
    for (let i = 0; i < max; i++) await proxy(req('10.0.0.3'));
    await proxy(req('10.0.0.3'));

    const [event] = logged.filter((e) => e.event === 'RATE_LIMIT_EXCEEDED');
    expect(event.ctx).not.toHaveProperty('ip');
    expect(event.ctx?.details).toMatchObject({ pathname: LIMITED_PATH, method: 'DELETE' });
  });
});

/**
 * NFR-OBS-01, NFR-PRIV-03 (FIX-16): an invitation link carries a bearer token in the path, and a log line holds
 * ids only. nginx masks the same segment in its access log (docker/nginx/default.conf `$log_uri`).
 */
describe('proxy masks the invitation token and logs no address (NFR-OBS-01, NFR-PRIV-03)', () => {
  const TOKEN = 'PROBETOKENabc123XYZ';
  const INVITE_PATH = `/api/v1/invitations/${TOKEN}`;
  const inviteReq = (ip: string) =>
    new NextRequest(`http://localhost${INVITE_PATH}`, { method: 'GET', headers: { 'x-forwarded-for': ip } });

  it('RATE_LIMIT_EXCEEDED for an invitation read holds the masked path, no token and no ip', async () => {
    const max = RATE_LIMITS.default.max;
    for (let i = 0; i < max; i++) {
      const res = await proxy(inviteReq('10.0.1.1'));
      expect(res.status).not.toBe(429);
    }
    const refused = await proxy(inviteReq('10.0.1.1'));

    expect(refused.status).toBe(429);
    const events = logged.filter((e) => e.event === 'RATE_LIMIT_EXCEEDED');
    expect(events).toHaveLength(1);
    expect((events[0].ctx?.details as Record<string, unknown>).pathname).toBe('/api/v1/invitations/[token]');
    expect(JSON.stringify(events[0].ctx)).not.toContain(TOKEN);
    expect(events[0].ctx).not.toHaveProperty('ip');
  });

  it('AUTH_TOKEN_DECODE_FAILURE for an invitation read holds the masked path (NFR-OBS-01)', async () => {
    getTokenMock.mockImplementation(() => Promise.reject(new Error('decode failed')));
    await proxy(inviteReq('10.0.1.2'));

    const events = logged.filter((e) => e.event === 'AUTH_TOKEN_DECODE_FAILURE');
    expect(events).toHaveLength(1);
    expect((events[0].ctx?.details as Record<string, unknown>).pathname).toBe('/api/v1/invitations/[token]');
    expect(JSON.stringify(events[0].ctx)).not.toContain(TOKEN);
  });

  it('the console fallback masks the path when the security logger itself throws (NFR-OBS-01)', async () => {
    getTokenMock.mockImplementation(() => Promise.reject(new Error('decode failed')));
    loggerState.throws = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await proxy(inviteReq('10.0.1.3'));
      const printed = JSON.stringify(spy.mock.calls);
      expect(printed).toContain('/api/v1/invitations/[token]');
      expect(printed).not.toContain(TOKEN);
    } finally {
      spy.mockRestore();
      loggerState.throws = false;
    }
  });
});
