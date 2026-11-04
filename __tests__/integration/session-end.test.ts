import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetDb, testDb } from '../helpers/db';
import { buildOrg, buildPlatformAdmin, type FixtureMember } from '../helpers/recordFixture';
import { sessionFor, clearSession } from '../helpers/authSession';

/**
 * NFR-SEC-07 (SRS line 2937; obligation B12): a session ends on its next request after each of the five cases, through
 * the one epoch check in `resolveIdentity` (lib/auth/identity.ts). These pin the existing mechanism for every case the
 * account actions now reach; they add no behaviour. The live half, with a real cookie on a running server, is
 * e2e/account.spec.ts.
 */
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }));
vi.mock('../../lib/email/send', () => ({ sendEmail: vi.fn(async () => ({ id: 'm1' })) }));

const { resolveIdentity, SessionError } = await import('../../lib/auth/identity');
const { DELETE: SIGN_OUT_EVERYWHERE } = await import('../../app/api/users/me/sessions/route');
const { POST: CHANGE } = await import('../../app/api/users/me/password/route');
const { adminSetAccountActive } = await import('../../lib/data/definer');
const { scrubUserOnDeactivation } = await import('../../lib/data/identity');
const { completePasswordReset } = await import('../../lib/data/passwordReset');
const { hashInvitationToken } = await import('../../lib/data/invitationToken');

const req = (method: string, path: string, body?: unknown, origin = 'http://localhost') => new NextRequest(`http://localhost${path}`, {
  method, headers: { 'content-type': 'application/json', host: 'localhost', origin }, body: body === undefined ? undefined : JSON.stringify(body),
});
const epochOf = async (m: FixtureMember) => (await testDb.user.findUniqueOrThrow({ where: { id: m.userId } })).sessionEpoch;
const tokenFor = (m: FixtureMember, epoch: number) => ({ id: m.userId, sessionEpoch: epoch, sessionIssuedAt: Math.floor(Date.now() / 1000) });

async function perform(kind: string, a: FixtureMember): Promise<void> {
  switch (kind) {
    case 'sign out everywhere':
      sessionFor(a.userId);
      expect((await SIGN_OUT_EVERYWHERE(req('DELETE', '/api/users/me/sessions'))).status).toBe(200);
      return;
    case 'password change':
      sessionFor(a.userId);
      expect((await CHANGE(req('POST', '/api/users/me/password', { currentPassword: a.password, newPassword: 'c'.repeat(12) }))).status).toBe(200);
      return;
    case 'password reset': {
      const raw = 'e'.repeat(64);
      await testDb.passwordResetToken.create({ data: { userId: a.userId, tokenHash: hashInvitationToken(raw), expiresAt: new Date(Date.now() + 60_000) } });
      await completePasswordReset(raw, 'r'.repeat(12), new Date());
      return;
    }
    case 'deactivation': {
      const admin = await buildPlatformAdmin();
      await adminSetAccountActive({ actorUserId: admin.userId, userId: a.userId, active: false, requestReference: null });
      return;
    }
    case 'account deletion':
      await scrubUserOnDeactivation(a.userId, 'not-a-real-hash');
      return;
    default:
      throw new Error(kind);
  }
}

beforeEach(async () => {
  await resetDb();
  clearSession();
});

describe('sessions end on the next request (NFR-SEC-07)', () => {
  it.each(['sign out everywhere', 'password change', 'password reset', 'deactivation', 'account deletion'])(
    'NFR-SEC-07 FR-ACC-07: the old session is refused after %s', async (kind) => {
      const a = (await buildOrg()).members.assessor;
      const old = tokenFor(a, await epochOf(a));
      await expect(resolveIdentity(old)).resolves.toMatchObject({ userId: a.userId });
      await perform(kind, a);
      await expect(resolveIdentity(old)).rejects.toThrow(SessionError);
    }, 60_000);

  it('NFR-SEC-08: a cross-origin DELETE of the sessions answers 403 cross_origin and ends nothing', async () => {
    const a = (await buildOrg()).members.assessor;
    sessionFor(a.userId);
    const r = await SIGN_OUT_EVERYWHERE(req('DELETE', '/api/users/me/sessions', undefined, 'https://evil.example'));
    expect([r.status, (await r.json()).code]).toEqual([403, 'cross_origin']);
    expect(await epochOf(a)).toBe(0);
  }, 60_000);
});
