import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { hash } from 'bcryptjs';
import { resetDb, testDb } from '../helpers/db';
import { buildOrg } from '../helpers/recordFixture';
import { currentAcceptances } from '../helpers/legalStub';
import { sessionFor, clearSession } from '../helpers/authSession';
import { hashInvitationToken } from '../../lib/data/invitationToken';

/**
 * NFR-SEC-18 (SRS line 2997; obligation B19): new and changed passwords are at least 12 characters, bcrypt cost 12, and
 * an existing shorter password keeps working until its next change. Verified on the validator, on sign-in, and on the
 * three routes that set a password: sign-up from an invitation (route 31), reset (route 34) and change (route 35).
 */
vi.mock('next/headers', () => ({ cookies: async () => ({ set: () => {} }) }));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => {} }));
vi.mock('../../lib/email/send', async (orig) => ({ ...(await orig<typeof import('../../lib/email/send')>()), sendEmail: vi.fn(async () => ({ id: 'm1' })) }));

const { validatePassword, PASSWORD_MIN_LENGTH } = await import('../../lib/validate');
const { authorizeCredentials } = await import('../../lib/auth/credentials');
const { POST: CHANGE } = await import('../../app/api/users/me/password/route');
const { POST: REGISTER } = await import('../../app/api/v1/invitations/[token]/register/route');
const { POST: COMPLETE } = await import('../../app/api/password-reset/complete/route');

function sameOriginJson(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost' }, body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDb();
  clearSession();
});

describe('passwords of at least 12 characters (NFR-SEC-18)', () => {
  it('NFR-SEC-18: 11 characters are refused with 422, 12 accepted, an existing 8-character password still signs in', async () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(validatePassword('a'.repeat(11))).toEqual({ field: 'password', message: 'Password must be at least 12 characters' });
    expect(validatePassword('a'.repeat(12))).toBeNull();
    expect(validatePassword('a'.repeat(129))).toEqual({ field: 'password', message: 'Password must be 128 characters or fewer' });
    const fx = await buildOrg();
    await testDb.user.update({ where: { id: fx.members.viewer.userId }, data: { passwordHash: await hash('eight888', 12) } });
    expect(await authorizeCredentials({ email: fx.members.viewer.email, password: 'eight888' },
      new Request('http://localhost/api/auth/callback/credentials', { method: 'POST' }))).not.toBeNull();
    sessionFor(fx.members.viewer.userId);
    for (const newPassword of ['b'.repeat(11), 'b'.repeat(129)]) {
      const res = await CHANGE(sameOriginJson('/api/users/me/password', { currentPassword: 'eight888', newPassword }));
      const body = await res.json();
      expect([res.status, body.code, body.fields?.[0]?.field]).toEqual([422, 'validation', 'newPassword']);
    }
    const ok = await CHANGE(sameOriginJson('/api/users/me/password', { currentPassword: 'eight888', newPassword: 'b'.repeat(12) }));
    expect(ok.status).toBe(200);
  }, 60_000);

  it('NFR-SEC-18: sign-up (route 31) and reset (route 34) refuse 11 characters with 422', async () => {
    const fx = await buildOrg();
    const raw = randomBytes(32).toString('hex');
    await testDb.invitation.create({ data: {
      orgId: fx.org.id, email: 'policy-invitee@fixture.test', role: 'viewer', tokenHash: hashInvitationToken(raw),
      invitedById: fx.members.owner.userId, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    } });
    const r31 = await REGISTER(sameOriginJson(`/api/v1/invitations/${raw}/register`, { name: 'Policy Invitee', password: 'p'.repeat(11), acceptances: currentAcceptances() }), { params: Promise.resolve({ token: raw }) });
    expect([r31.status, (await r31.json()).fields.map((f: { field: string }) => f.field)]).toEqual([422, ['password']]);
    expect(await testDb.user.count({ where: { email: 'policy-invitee@fixture.test' } })).toBe(0);

    const reset = randomBytes(32).toString('hex');
    await testDb.passwordResetToken.create({ data: { userId: fx.members.viewer.userId, tokenHash: hashInvitationToken(reset), expiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
    const r34 = await COMPLETE(sameOriginJson('/api/password-reset/complete', { token: reset, newPassword: 'p'.repeat(11) }));
    const b34 = await r34.json();
    expect([r34.status, b34.code, b34.fields]).toEqual([422, 'validation', [{ field: 'newPassword', message: 'Password must be at least 12 characters' }]]);
    expect((await COMPLETE(sameOriginJson('/api/password-reset/complete', { token: reset, newPassword: 'p'.repeat(12) }))).status).toBe(204);
  }, 60_000);
});
