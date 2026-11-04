import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { compare } from 'bcryptjs';
import { resetDb, testDb } from '../helpers/db';
import { buildOrg, type FixtureMember } from '../helpers/recordFixture';
import { captureLogs } from '../helpers/logCapture';
import { sessionFor, clearSession } from '../helpers/authSession';

/**
 * The password change on S-21 and S-29 (route 35; FR-ACC-08) and E-02 after every change and reset (FR-ACC-09;
 * obligations B12, B14, B15), through the real route handlers. `after()` is a queue `flush()` runs; the mail transport
 * is a recorder. FR-ACC-08's own cases are __tests__/integration/password-gate.test.ts, which runs unchanged.
 */
const q = vi.hoisted(() => ({ pending: [] as Array<() => unknown> }));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (cb: () => unknown) => { q.pending.push(cb); } }));
vi.mock('../../lib/email/send', async (orig) => ({ ...(await orig<typeof import('../../lib/email/send')>()), sendEmail: vi.fn(async () => ({ id: 'm1' })) }));
vi.mock('@/lib/data/passwordReset', async (orig) => {
  const real = await orig<typeof import('@/lib/data/passwordReset')>();
  return { ...real, voidResetTokens: vi.fn(real.voidResetTokens) };
});
vi.mock('@/lib/auth/identity', async (orig) => {
  const real = await orig<typeof import('@/lib/auth/identity')>();
  return { ...real, requireIdentityForApi: vi.fn(real.requireIdentityForApi) };
});

const { sendEmail } = await import('../../lib/email/send');
const { requireIdentityForApi } = await import('@/lib/auth/identity');
const { voidResetTokens } = await import('@/lib/data/passwordReset');
const { POST: CHANGE } = await import('../../app/api/users/me/password/route');
const { POST: REQUEST } = await import('../../app/api/password-reset/route');
const { POST: COMPLETE } = await import('../../app/api/password-reset/complete/route');

const E02 = 'Your MAK-AI RAI Platform password was changed';
const E03 = 'Reset your MAK-AI RAI Platform password';

async function flush(): Promise<void> {
  while (q.pending.length > 0) await q.pending.shift()!();
}
function sameOriginJson(path: string, body: unknown, origin = 'http://localhost'): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin }, body: JSON.stringify(body),
  });
}
const change = (body: unknown, origin?: string) => CHANGE(sameOriginJson('/api/users/me/password', body, origin));

async function requestAndCapture(m: FixtureMember): Promise<string> {
  await REQUEST(sameOriginJson('/api/password-reset', { email: m.email }));
  await flush();
  const mail = [...vi.mocked(sendEmail).mock.calls].reverse().find(([x]) => x.subject === E03 && x.to === m.email);
  return /#token=([0-9a-f]{64})/.exec(mail![0].text)![1];
}

let a: FixtureMember;

beforeEach(async () => {
  await resetDb();
  q.pending.length = 0;
  clearSession();
  vi.mocked(sendEmail).mockClear();
  vi.stubEnv('EMAIL_FROM_ADDRESS', 'noreply@makrai.example');
  vi.stubEnv('RESEND_API_KEY', 're_test_local');
  a = (await buildOrg()).members.assessor;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('password change and E-02', () => {
  it('FR-ACC-09: E-02 is sent once for a change on S-21 and once for a reset through S-03', async () => {
    sessionFor(a.userId);
    expect((await change({ currentPassword: a.password, newPassword: 'c'.repeat(12) })).status).toBe(200);
    await flush();
    expect((await COMPLETE(sameOriginJson('/api/password-reset/complete', { token: await requestAndCapture(a), newPassword: 'd'.repeat(12) }))).status).toBe(204);
    await flush();
    expect(vi.mocked(sendEmail).mock.calls.filter(([m]) => m.subject === E02).map(([m]) => m.to)).toEqual([a.email, a.email]);
  }, 60_000);

  it('FR-ACC-08: a refused change sends no E-02', async () => {
    sessionFor(a.userId);
    expect((await change({ currentPassword: 'not-the-password', newPassword: 'c'.repeat(12) })).status).toBe(400);
    await flush();
    expect(sendEmail).not.toHaveBeenCalled();
  }, 60_000);

  it('FR-ACC-06 FR-ACC-08: a password change voids earlier reset links and clears the lock', async () => {
    const raw = await requestAndCapture(a);
    await testDb.user.update({ where: { id: a.userId }, data: { failedLoginAttempts: 3 } });
    sessionFor(a.userId);
    expect((await change({ currentPassword: a.password, newPassword: 'c'.repeat(12) })).status).toBe(200);
    const r = await COMPLETE(sameOriginJson('/api/password-reset/complete', { token: raw, newPassword: 'e'.repeat(12) }));
    expect([r.status, (await r.json()).code]).toEqual([410, 'reset_link_unusable']);
    const u = await testDb.user.findUniqueOrThrow({ where: { id: a.userId } });
    expect([u.failedLoginAttempts, u.lockedUntil, u.sessionEpoch]).toEqual([0, null, 1]);
    expect(await compare('c'.repeat(12), u.passwordHash)).toBe(true);
  }, 60_000);

  it('NFR-SEC-08: cross-origin POST answers 403 cross_origin', async () => {
    sessionFor(a.userId);
    const r = await change({ currentPassword: a.password, newPassword: 'c'.repeat(12) }, 'https://evil.example');
    expect([r.status, (await r.json()).code]).toEqual([403, 'cross_origin']);
    expect((await testDb.user.findUniqueOrThrow({ where: { id: a.userId } })).sessionEpoch).toBe(0);
  }, 60_000);

  it('FR-ACC-08: an unauthenticated change answers 401 as before', async () => {
    const r = await change({ currentPassword: a.password, newPassword: 'c'.repeat(12) });
    expect([r.status, (await r.json()).error]).toEqual([401, 'Unauthorized']);
  }, 60_000);

  it('NFR-AVL-04 NFR-OBS-05: with the database unreachable, the password route answers 503 database_unavailable with a reference and writes one REQUEST_FAILED line', async () => {
    sessionFor(a.userId);
    // A network code is an outage to isDatabaseUnavailable (lib/data/pgErrors.ts); the gate's account lookup is the
    // handler's first database access, so the gate rejects with what an unreachable database gives it.
    vi.mocked(requireIdentityForApi).mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const { result, lines } = await captureLogs(() => change({ currentPassword: a.password, newPassword: 'c'.repeat(12) }));
    const body = await result.json();
    expect([result.status, body]).toEqual([503, { error: 'Service unavailable', code: 'database_unavailable', reference: expect.stringMatching(/^[0-9a-f]{8}$/) }]);
    expect(lines.filter((l) => l.includes('REQUEST_FAILED') && l.includes(body.reference))).toHaveLength(1);
  }, 60_000);

  it('FR-ACC-08: a body that is not JSON answers 422 and prints none of it', async () => {
    sessionFor(a.userId);
    const { result, lines } = await captureLogs(() => CHANGE(new NextRequest('http://localhost/api/users/me/password', {
      method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost' }, body: 'hunter2secretpw-not-json',
    })));
    expect([result.status, (await result.json()).code]).toEqual([422, 'validation']);
    expect(lines.join('\n')).not.toContain('hunter2');
  }, 60_000);

  it('FR-ACC-06 FR-ACC-08: when voiding the reset links fails, the password is unchanged and the sessions live', async () => {
    sessionFor(a.userId);
    vi.mocked(voidResetTokens).mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const r = await change({ currentPassword: a.password, newPassword: 'c'.repeat(12) });
    expect(r.status).toBe(503);
    const u = await testDb.user.findUniqueOrThrow({ where: { id: a.userId } });
    expect(u.sessionEpoch).toBe(0);
    expect(await compare(a.password, u.passwordHash)).toBe(true);
  }, 60_000);
});
