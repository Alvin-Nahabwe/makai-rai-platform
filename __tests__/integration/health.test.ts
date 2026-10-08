import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/health against the real database (INFRA-12).
 *
 * `__tests__/unit/health-route.test.ts` replaces the data client. This file does not: the
 * route runs over `appClient` on `APP_DATABASE_URL` (makrai_app), exactly as the container
 * does, so it proves the query the healthcheck sends is one that role is allowed to send.
 */

describe('GET /api/health', () => {
  it('reaches the real database', async () => {
    const { GET } = await import('../../app/api/health/route');
    const { databaseReachable } = await import('../../lib/data/health');

    await expect(databaseReachable()).resolves.toBe(true);
    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"status":"ok"}');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /api/health with the database unreachable', () => {
  // hmrSingleton keeps the client on globalThis outside production (lib/data/connection.ts),
  // so a second client for a different URL needs the first one out of the way.
  const slot = globalThis as Record<string, unknown>;
  let realClient: unknown;

  afterEach(() => {
    slot.appClient = realClient;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('answers 503 with nothing from the driver in the body', async () => {
    // A real connection attempt that is refused: port 1 has no listener. The point is the
    // driver's own error, ECONNREFUSED and the address, never reaching the response.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    realClient = slot.appClient;
    delete slot.appClient;
    vi.stubEnv('APP_DATABASE_URL', 'postgresql://makrai_app:unused@127.0.0.1:1/makrai_test');
    vi.resetModules();
    const { GET } = await import('../../app/api/health/route');

    const res = await GET();
    const body = await res.text();

    expect(res.status).toBe(503);
    expect(body).toBe('{"status":"unavailable"}');
    expect(body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|makrai_app/);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
