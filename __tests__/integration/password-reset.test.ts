import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { compare } from 'bcryptjs';
import { resetDb, testDb } from '../helpers/db';
import { buildOrg, buildPlatformAdmin, type FixtureMember } from '../helpers/recordFixture';
import { captureLogs, scanLines } from '../helpers/logCapture';

/**
 * Password reset by email (FR-ACC-06, NFR-SEC-05 for reset tokens; obligations B7 to B11 and B15), through the real route
 * handlers (contract rows 33 and 34) against the identity lane. `after()` from next/server is replaced by a queue that
 * `flush()` runs, as Next runs the callbacks once the response is sent; the mail transport is a recorder.
 */
const q = vi.hoisted(() => ({ pending: [] as Array<() => unknown> }));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (cb: () => unknown) => { q.pending.push(cb); } }));
vi.mock('../../lib/email/send', async (orig) => ({ ...(await orig<typeof import('../../lib/email/send')>()), sendEmail: vi.fn(async () => ({ id: 'm1' })) }));

const { sendEmail } = await import('../../lib/email/send');
const { POST: REQUEST } = await import('../../app/api/password-reset/route');
const { POST: COMPLETE } = await import('../../app/api/password-reset/complete/route');
const { resolveIdentity, SessionError } = await import('../../lib/auth/identity');
const { RESET_PER_ACCOUNT_PER_HOUR, RESET_PER_PLATFORM_PER_HOUR, RESET_TTL_MS } = await import('../../lib/data/passwordReset');

const M21 = 'If an account exists for this email, we have sent a link. It works once and expires in 30 minutes.';
const M22 = 'This link has expired or has already been used. Ask for a new one.';
const E03 = 'Reset your MAK-AI RAI Platform password';
const E02 = 'Your MAK-AI RAI Platform password was changed';

async function flush(): Promise<void> {
  while (q.pending.length > 0) await q.pending.shift()!();
}

function sameOriginJson(body: unknown, path = '/api/password-reset', origin = 'http://localhost'): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'localhost', origin },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const completeReq = (body: unknown, origin?: string) => sameOriginJson(body, '/api/password-reset/complete', origin);

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
const sentTo = (subject: string) => vi.mocked(sendEmail).mock.calls.filter(([m]) => m.subject === subject).map(([m]) => m.to);

/** Asks for a reset for `m`, runs the queued work, and reads the token from the E-03 link after '#token='. */
async function requestAndCapture(m: FixtureMember | { email: string }): Promise<string> {
  vi.mocked(sendEmail).mockClear();
  expect((await REQUEST(sameOriginJson({ email: m.email }))).status).toBe(202);
  await flush();
  const mail = vi.mocked(sendEmail).mock.calls.find(([x]) => x.subject === E03 && x.to === m.email);
  if (!mail) throw new Error('no E-03 was sent');
  const raw = /#token=([0-9a-f]+)/.exec(mail[0].text)?.[1];
  if (!raw) throw new Error('E-03 carries no token');
  return raw;
}

const epochOf = async (m: FixtureMember) => (await testDb.user.findUniqueOrThrow({ where: { id: m.userId } })).sessionEpoch;
const hashOf = async (m: FixtureMember) => (await testDb.user.findUniqueOrThrow({ where: { id: m.userId } })).passwordHash;
const lockOf = async (m: FixtureMember) => {
  const u = await testDb.user.findUniqueOrThrow({ where: { id: m.userId } });
  return { failedLoginAttempts: u.failedLoginAttempts, lockedUntil: u.lockedUntil };
};
const tokenFor = (m: FixtureMember, epoch: number) => ({ id: m.userId, sessionEpoch: epoch, sessionIssuedAt: Math.floor(Date.now() / 1000) });

/** Every text column of every public table holding exactly `value`, as "table.column". */
async function textColumnsContaining(value: string): Promise<string[]> {
  const cols = await testDb.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type IN ('text', 'character varying')`,
  );
  const hits: string[] = [];
  for (const c of cols) {
    const [{ n }] = await testDb.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${c.table_name}" WHERE "${c.column_name}" = $1`, value);
    if (Number(n) > 0) hits.push(`${c.table_name}.${c.column_name}`);
  }
  return hits;
}

let a: FixtureMember;
let b: FixtureMember;

beforeEach(async () => {
  await resetDb();
  q.pending.length = 0;
  vi.mocked(sendEmail).mockClear();
  vi.stubEnv('EMAIL_FROM_ADDRESS', 'noreply@makrai.example');
  vi.stubEnv('RESEND_API_KEY', 're_test_local');
  const fx = await buildOrg();
  a = fx.members.assessor;
  b = fx.members.reviewer;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('password reset (FR-ACC-06)', () => {
  it('FR-ACC-06: the limits are 30 minutes, 3 an account an hour and 200 a platform hour', () => {
    expect([RESET_TTL_MS, RESET_PER_ACCOUNT_PER_HOUR, RESET_PER_PLATFORM_PER_HOUR]).toEqual([30 * 60 * 1000, 3, 200]);
  });

  it('FR-ACC-06 M-21: known and unknown emails get identical 202 bodies and medians within 50 ms; only the first sends E-03', async () => {
    const timed = async (n: number, fn: () => Promise<Response>) => {
      const t: number[] = []; const bodies: string[] = []; const statuses: number[] = [];
      for (let i = 0; i < n; i++) {
        const s = performance.now(); const r = await fn(); t.push(performance.now() - s);
        statuses.push(r.status); bodies.push(await r.text());
      }
      return { median: t.sort((x, y) => x - y)[Math.floor(n / 2)], bodies, statuses };
    };
    const known = await timed(50, () => REQUEST(sameOriginJson({ email: a.email })));
    const unknown = await timed(50, () => REQUEST(sameOriginJson({ email: 'nobody@fixture.test' })));
    const malformed = await timed(5, () => REQUEST(sameOriginJson('{not json')));
    expect(new Set([...known.bodies, ...unknown.bodies, ...malformed.bodies])).toEqual(new Set([JSON.stringify({ message: M21 })]));
    expect(known.statuses.concat(unknown.statuses, malformed.statuses).every((s) => s === 202)).toBe(true);
    expect(Math.abs(known.median - unknown.median)).toBeLessThan(50);
    // Nothing happens before the answer: every send waits for the queued work.
    expect(sendEmail).not.toHaveBeenCalled();
    await flush();
    expect(vi.mocked(sendEmail).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(sendEmail).mock.calls.every(([m]) => m.to === a.email && m.subject === E03)).toBe(true);
  }, 60_000);

  it('FR-ACC-06: the link changes the password once, ends every earlier session and clears the lock', async () => {
    const epoch = await epochOf(a);
    await testDb.user.update({ where: { id: a.userId }, data: { failedLoginAttempts: 5, lockedUntil: new Date(Date.now() + 15 * 60 * 1000), mustChangePassword: true } });
    await testDb.knownDevice.create({ data: { userId: a.userId, failedCount: 5, lockedUntil: new Date(Date.now() + 60_000) } });
    const raw = await requestAndCapture(a);
    expect((await COMPLETE(completeReq({ token: raw, newPassword: 'n'.repeat(12) }))).status).toBe(204);
    expect(await epochOf(a)).toBe(epoch + 1);
    expect(await lockOf(a)).toEqual({ failedLoginAttempts: 0, lockedUntil: null });
    expect((await testDb.user.findUniqueOrThrow({ where: { id: a.userId } })).mustChangePassword).toBe(false);
    expect(await testDb.knownDevice.findMany({ where: { userId: a.userId }, select: { failedCount: true, lockedUntil: true } })).toEqual([{ failedCount: 0, lockedUntil: null }]);
    expect(await compare('n'.repeat(12), await hashOf(a))).toBe(true);
    await expect(resolveIdentity(tokenFor(a, epoch))).rejects.toThrow(SessionError);
    await expect(resolveIdentity(tokenFor(a, epoch))).rejects.toThrow(/revoked/);
  }, 60_000);

  it('FR-ACC-06 NFR-SEC-05 M-22: a used, expired or superseded link is refused and the password is unchanged', async () => {
    const usedRaw = await requestAndCapture(a);
    expect((await COMPLETE(completeReq({ token: usedRaw, newPassword: 'u'.repeat(12) }))).status).toBe(204);
    const before = await hashOf(a);
    const olderRaw = await requestAndCapture(a);
    await requestAndCapture(a); // a newer request voids the older link
    const expiredRaw = await requestAndCapture(b);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 30 * 60 * 1000 + 1);
    for (const raw of [usedRaw, olderRaw, expiredRaw, 'f'.repeat(64), 'not-a-token']) {
      const r = await COMPLETE(completeReq({ token: raw, newPassword: 'z'.repeat(12) }));
      expect([r.status, await r.json()]).toEqual([410, { error: M22, code: 'reset_link_unusable' }]);
    }
    expect(await hashOf(a)).toBe(before);
    expect(await compare('z'.repeat(12), await hashOf(b))).toBe(false);
  }, 60_000);

  it('FR-ACC-06: a refused new password answers 422 and consumes nothing', async () => {
    const raw = await requestAndCapture(a);
    const r = await COMPLETE(completeReq({ token: raw, newPassword: '' }));
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ code: 'validation', fields: [{ field: 'newPassword', message: 'Password is required' }] });
    expect((await COMPLETE(completeReq({ token: raw, newPassword: 'n'.repeat(12) }))).status).toBe(204);
  }, 60_000);

  it('FR-ACC-06: the fourth request in an hour sends nothing; the 201st across the platform sends nothing', async () => {
    for (let i = 0; i < 4; i++) expect((await REQUEST(sameOriginJson({ email: a.email }))).status).toBe(202);
    await flush();
    expect(sentTo(E03)).toEqual([a.email, a.email, a.email]);
    vi.mocked(sendEmail).mockClear();
    // 197 more rows from other accounts within the hour make 200 across the platform.
    await testDb.passwordResetToken.createMany({ data: Array.from({ length: RESET_PER_PLATFORM_PER_HOUR - 3 }, (_, i) => ({
      userId: b.userId, tokenHash: sha256Hex(`filler-${i}`), expiresAt: new Date(Date.now() + RESET_TTL_MS),
    })) });
    const fresh = (await buildOrg()).members.viewer;
    const r = await REQUEST(sameOriginJson({ email: fresh.email }));
    expect([r.status, await r.json()]).toEqual([202, { message: M21 }]);
    await flush();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await testDb.passwordResetToken.count({ where: { userId: fresh.userId } })).toBe(0);
  }, 60_000);

  it('FR-ACC-06: administrator, deactivated and deleted accounts get the same answer and no email', async () => {
    const admin = await buildPlatformAdmin();
    await testDb.user.update({ where: { id: b.userId }, data: { isActive: false } });
    const gone = (await buildOrg()).members.viewer;
    await testDb.user.update({ where: { id: gone.userId }, data: { email: `deleted-${gone.userId}@invalid`, isActive: false } });
    for (const email of [admin.email, b.email, `deleted-${gone.userId}@invalid`]) {
      const r = await REQUEST(sameOriginJson({ email }));
      expect([r.status, await r.json()]).toEqual([202, { message: M21 }]);
    }
    await flush();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await testDb.passwordResetToken.count()).toBe(0);
  }, 60_000);

  it('FR-ACC-06: an address in another letter case or with spaces finds the account; the link goes to the stored address', async () => {
    expect((await REQUEST(sameOriginJson({ email: `  ${a.email.toUpperCase()} ` }))).status).toBe(202);
    await flush();
    expect(sentTo(E03)).toEqual([a.email]);
  }, 60_000);

  it('NFR-SEC-05: the database holds only the hash of a known reset token', async () => {
    const raw = await requestAndCapture(a);
    expect(raw).toMatch(/^[0-9a-f]{64}$/); // 256 bits
    expect(await textColumnsContaining(raw)).toEqual([]);
    expect(await testDb.passwordResetToken.count({ where: { tokenHash: sha256Hex(raw) } })).toBe(1);
    const row = await testDb.passwordResetToken.findFirstOrThrow({ where: { tokenHash: sha256Hex(raw) } });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(RESET_TTL_MS - 5_000);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThanOrEqual(RESET_TTL_MS + 5_000);
  }, 60_000);

  it('NFR-OBS-01: reset events hold ids only', async () => {
    let raw = '';
    const { lines } = await captureLogs(async () => {
      raw = await requestAndCapture(a);
      await REQUEST(sameOriginJson({ email: 'nobody@fixture.test' }));
      await flush();
      expect((await COMPLETE(completeReq({ token: raw, newPassword: 'n'.repeat(12) }))).status).toBe(204);
      await flush();
    });
    const events = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    expect(events.filter((e) => e.event === 'PASSWORD_RESET_REQUESTED').map((e) => e.userId ?? null)).toEqual([a.userId, null]);
    expect(events.filter((e) => e.event === 'PASSWORD_RESET_COMPLETED').map((e) => e.userId)).toEqual([a.userId]);
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
    expect(lines.filter((l) => l.includes(raw) || l.includes(sha256Hex(raw)))).toEqual([]);
    expect(sentTo(E02)).toEqual([a.email]);
  }, 60_000);

  it('NFR-OBS-01: a failed E-03 send is logged by id with a fixed reason and the answer is still 202', async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error(`Email send failed (validation_error): ${a.email}`));
    const { lines } = await captureLogs(async () => {
      expect((await REQUEST(sameOriginJson({ email: a.email }))).status).toBe(202);
      await flush();
    });
    const events = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((e) => e.event === 'PASSWORD_RESET_REQUESTED');
    expect(events).toEqual([expect.objectContaining({ level: 'error', userId: a.userId, details: { sent: false, reason: 'send_failed' } })]);
    expect(scanLines(lines, { markers: false, emails: true })).toEqual([]);
  }, 60_000);

  it('FR-ACC-06: with mail unset, a request leaves the earlier link working and spends no quota', async () => {
    const raw = await requestAndCapture(a);
    vi.stubEnv('EMAIL_FROM_ADDRESS', '');
    const { lines } = await captureLogs(async () => {
      expect((await REQUEST(sameOriginJson({ email: a.email }))).status).toBe(202);
      await flush();
    });
    const events = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((e) => e.event === 'PASSWORD_RESET_REQUESTED');
    expect(events).toEqual([expect.objectContaining({ level: 'error', userId: a.userId, details: { sent: false, reason: 'sender_unset' } })]);
    expect(await testDb.passwordResetToken.count({ where: { userId: a.userId } })).toBe(1);
    vi.stubEnv('EMAIL_FROM_ADDRESS', 'noreply@makrai.example');
    expect((await COMPLETE(completeReq({ token: raw, newPassword: 'n'.repeat(12) }))).status).toBe(204);
  }, 60_000);

  it('NFR-SEC-08: cross-origin POST answers 403 cross_origin', async () => {
    const r1 = await REQUEST(sameOriginJson({ email: a.email }, '/api/password-reset', 'https://evil.example'));
    expect([r1.status, (await r1.json()).code]).toEqual([403, 'cross_origin']);
    const raw = await requestAndCapture(a);
    const r2 = await COMPLETE(completeReq({ token: raw, newPassword: 'n'.repeat(12) }, 'https://evil.example'));
    expect([r2.status, (await r2.json()).code]).toEqual([403, 'cross_origin']);
    await flush();
    expect(await compare('n'.repeat(12), await hashOf(a))).toBe(false);
  }, 60_000);
});
