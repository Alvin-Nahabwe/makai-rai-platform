import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { OrgRole } from '@prisma/client';
import { testDb, resetDb } from '../helpers/db';
import { buildOrg, buildPlatformAdmin, type FixtureAccount, type OrgFixture } from '../helpers/recordFixture';
import { sessionFor, clearSession } from '../helpers/authSession';
import { hashInvitationToken } from '../../lib/data/invitationToken';
import { ACCEPTED_KINDS } from '../../types/legal';

/**
 * Route 32, POST /api/v1/invitations/[token] (FR-ACC-01, FR-ACC-03; contract Routes row 32): a
 * signed-in account accepts an invitation for its own email through the definer function, after
 * the acceptance gate; and the race of route 31's shared transaction, which needs a second
 * acceptance to exist.
 */

vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn(async () => ({ id: 'email-test-id' })) }));
let realAcceptInvitationViaDefiner!: typeof import('@/lib/data/definer').acceptInvitationViaDefiner;
vi.mock('@/lib/data/definer', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/data/definer')>();
  realAcceptInvitationViaDefiner = real.acceptInvitationViaDefiner;
  return { ...real, acceptInvitationViaDefiner: vi.fn(real.acceptInvitationViaDefiner) };
});

const { POST: ACCEPT_ROUTE } = await import('@/app/api/v1/invitations/[token]/route');
const { POST: REGISTER_ROUTE } = await import('@/app/api/v1/invitations/[token]/register/route');
const { acceptInvitationViaDefiner } = await import('@/lib/data/definer');

const M23 = 'This invitation link does not work. It may have expired, been used, or been replaced by a newer one. Ask the person who invited you to send it again.';

let fx: OrgFixture;
let invitee: FixtureAccount;

const post = (url: string, body: unknown, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${url}`, {
  method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', ...headers }, body: JSON.stringify(body),
});
function ACCEPT(token: string, headers: Record<string, string> = {}) {
  return ACCEPT_ROUTE(post(`/api/v1/invitations/${token}`, {}, headers), { params: Promise.resolve({ token }) });
}
function register(token: string, body: unknown) {
  return REGISTER_ROUTE(post(`/api/v1/invitations/${token}/register`, body), { params: Promise.resolve({ token }) });
}
async function asUser<T>(account: Pick<FixtureAccount, 'userId'>, fn: () => Promise<T>): Promise<T> {
  sessionFor(account.userId);
  return fn();
}
async function invitationRow(org: OrgFixture, a: { email: string; role: OrgRole }) {
  const raw = randomBytes(32).toString('hex');
  const inv = await testDb.invitation.create({ data: {
    orgId: org.org.id, email: a.email, role: a.role, tokenHash: hashInvitationToken(raw), invitedById: org.members.owner.userId,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  } });
  return { raw, inv };
}
async function memberRole(email: string, orgId: string) {
  const user = await testDb.user.findUniqueOrThrow({ where: { email } });
  return (await testDb.membership.findFirst({ where: { userId: user.id, orgId } }))?.role ?? null;
}

beforeEach(async () => {
  await resetDb();
  clearSession();
  vi.mocked(acceptInvitationViaDefiner).mockClear();
  fx = await buildOrg();
  // An account in another organisation, with the three acceptances, invited into fx's.
  invitee = (await buildOrg({ label: 'inv' })).members.viewer;
});

describe('route 32: accept an invitation as a signed-in account (FR-ACC-01)', () => {
  it('FR-ACC-01: a signed-in invitee with acceptances joins with the invitation role', async () => {
    const { raw } = await invitationRow(fx, { email: invitee.email, role: 'reviewer' });
    const res = await asUser(invitee, () => ACCEPT(raw));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgSlug: fx.org.slug });
    expect(await memberRole(invitee.email, fx.org.id)).toBe('reviewer');
  });

  it('FR-ACC-01: the invited email is compared without regard to case', async () => {
    const { raw } = await invitationRow(fx, { email: invitee.email.toUpperCase(), role: 'viewer' });
    expect((await asUser(invitee, () => ACCEPT(raw))).status).toBe(200);
  });

  it('FR-ACC-03 FR-ACC-04: an invitee without the three acceptances gets 403 with the missing kinds and no membership', async () => {
    const bare = (await buildOrg({ label: 'bare', acceptances: 'none' })).members.viewer;
    const { raw, inv } = await invitationRow(fx, { email: bare.email, role: 'viewer' });
    const res = await asUser(bare, () => ACCEPT(raw));
    expect([res.status, await res.json()]).toEqual([403, expect.objectContaining({ code: 'acceptances_required', missing: [...ACCEPTED_KINDS] })]);
    expect(await memberRole(bare.email, fx.org.id)).toBeNull();
    expect((await testDb.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('pending');
    expect(acceptInvitationViaDefiner).not.toHaveBeenCalled();
  });

  it('FR-ACC-01: a wrong-account attempt answers 409 wrong_account and the invitee can still accept', async () => {
    const other = fx.members.assessor;
    const { raw } = await invitationRow(fx, { email: invitee.email, role: 'viewer' });
    const wrong = await asUser(other, () => ACCEPT(raw));
    expect([wrong.status, await wrong.json()]).toEqual([409, { error: 'This invitation is for another account.', code: 'wrong_account' }]);
    expect(acceptInvitationViaDefiner).not.toHaveBeenCalled();
    expect((await asUser(invitee, () => ACCEPT(raw))).status).toBe(200);
  });

  it('FR-ACC-01: a platform administrator cannot accept an invitation', async () => {
    const admin = await buildPlatformAdmin();
    const { raw: forAdmin } = await invitationRow(fx, { email: admin.email, role: 'viewer' });
    const res = await asUser(admin, () => ACCEPT(forAdmin));
    expect([res.status, await res.json()]).toEqual([410, { error: M23, code: 'invitation_unusable' }]);
    expect(await testDb.membership.count({ where: { userId: admin.userId } })).toBe(0);
  });

  it('FR-ACC-01: a used token answers 410 with the M-23 text', async () => {
    const { raw } = await invitationRow(fx, { email: invitee.email, role: 'viewer' });
    expect((await asUser(invitee, () => ACCEPT(raw))).status).toBe(200);
    const again = await asUser(invitee, () => ACCEPT(raw));
    expect([again.status, await again.json()]).toEqual([410, { error: M23, code: 'invitation_unusable' }]);
    expect(await testDb.membership.count({ where: { userId: invitee.userId, orgId: fx.org.id } })).toBe(1);
  });

  it('FR-ACC-01 NFR-SEC-05: two concurrent accepts of one token give one membership', async () => {
    // At the database function route 32 calls: two route calls in parallel cannot be driven here, because two
    // concurrent dynamic imports of the mocked lib/auth inside one vitest worker load the real module for one of them.
    const { raw } = await invitationRow(fx, { email: invitee.email, role: 'viewer' });
    const accept = () => realAcceptInvitationViaDefiner({ tokenHash: hashInvitationToken(raw), userId: invitee.userId });
    const outcomes = await Promise.allSettled([accept(), accept()]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(outcomes.find((o) => o.status === 'rejected')).toMatchObject({ reason: { status: 410, code: 'invitation_unusable' } });
    expect(await testDb.membership.count({ where: { userId: invitee.userId, orgId: fx.org.id } })).toBe(1);
  });

  it('FR-ACC-01: with no session it answers 401, and a cross-origin POST answers 403 cross_origin', async () => {
    const { raw, inv } = await invitationRow(fx, { email: invitee.email, role: 'viewer' });
    expect((await ACCEPT(raw)).status).toBe(401);
    const xo = await asUser(invitee, () => ACCEPT(raw, { origin: 'https://evil.example' }));
    expect([xo.status, (await xo.json()).code]).toEqual([403, 'cross_origin']);
    expect((await testDb.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('pending');
  });

  it('FR-ACC-03 NFR-SEC-05: a registration that loses its token to another acceptance leaves no account and no acceptance rows', async () => {
    const { raw, inv } = await invitationRow(fx, { email: 'late@fixture.test', role: 'viewer' });
    const before = await testDb.consentRecord.count();
    vi.mocked(acceptInvitationViaDefiner).mockImplementationOnce(async (a, tx) => {
      // the other acceptance commits first, after route 31 read the invitation and inside its open transaction
      await testDb.invitation.update({ where: { id: inv.id }, data: { status: 'accepted', acceptedAt: new Date() } });
      return realAcceptInvitationViaDefiner(a, tx);
    });
    const res = await register(raw, { name: 'Late', password: 'a'.repeat(12), acceptances: [...ACCEPTED_KINDS] });
    expect([res.status, await res.json()]).toEqual([410, { error: M23, code: 'invitation_unusable' }]);
    expect(vi.mocked(acceptInvitationViaDefiner).mock.calls.at(-1)![1]).toBeDefined();   // the tx was passed
    expect(await testDb.user.count({ where: { email: 'late@fixture.test' } })).toBe(0);
    expect(await testDb.consentRecord.count()).toBe(before);
  });
});
