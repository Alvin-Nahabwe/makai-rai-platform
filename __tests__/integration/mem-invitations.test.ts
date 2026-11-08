import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InviteMemberResponse } from '@/types/api';
import { RETRY_KEYED_WRITES, UNKEYED_WRITES, PENDING_ROUTES } from '@/lib/authz/routeActions';
import { acceptInvitationViaDefiner } from '@/lib/data/definer';
import { listInvitations, revokeInvitation } from '@/lib/data/members';
import { ConflictError } from '@/lib/http/errors';
import { requestDigest } from '@/lib/data/idempotency';
import { resetDb, testDb } from '../helpers/db';
import { buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { callRoute, rowCounts, sessionAs } from '../helpers/routeDriver';

/**
 * MEM Task 4: the pending list, resend (route 28) and revoke (route 29) (FR-MEM-02, NFR-INT-02). The real handlers
 * run behind AUTHZ's route driver; the email transport is the only mock.
 */
const sendEmailMock = vi.hoisted(() => vi.fn(async (_m: { to: string }) => ({ id: 'msg_1' })));
vi.mock('@/lib/email/send', () => ({ sendEmail: sendEmailMock }));

const RESEND = 'app/api/v1/orgs/[slug]/invitations/[invitationId]/resend/route.ts';
const REVOKE = 'app/api/v1/orgs/[slug]/invitations/[invitationId]/revoke/route.ts';
const REQ = '5d1f0a52-7b0e-4c52-8a9b-2f6d7c0e1a11';
const DAY = 86_400_000;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

let fx: OrgFixture;
let fxB: OrgFixture;
const post = (file: string, id: string, body: Record<string, unknown> = {}) =>
  callRoute(file, 'POST', { slug: fx.org.slug, params: { invitationId: id }, body: { requestId: randomUUID(), ...body } });
const receiptsOf = (orgId: string) => testDb.requestReceipt.findMany({ where: { orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const row = (id: string) => testDb.invitation.findUniqueOrThrow({ where: { id } });

/** A pending invitation written through testDb with a token we know. */
async function seedInvitation(f: OrgFixture, opts: { email?: string; role?: 'viewer' | 'owner'; kind?: string; by?: string } = {}) {
  const token = randomBytes(32).toString('hex');
  const inv = await testDb.invitation.create({ data: {
    orgId: f.org.id, email: opts.email ?? `pending-${randomUUID().slice(0, 8)}@fixture.test`, role: opts.role ?? 'viewer',
    tokenHash: hash(token), invitedById: opts.by ?? f.members.owner.userId, kind: opts.kind ?? 'member',
    expiresAt: new Date(Date.now() + 7 * DAY),
  } });
  return { id: inv.id, token, email: inv.email };
}

beforeEach(async () => {
  await resetDb();
  vi.stubEnv('EMAIL_FROM_ADDRESS', 'onboarding@resend.dev');
  vi.stubEnv('RESEND_API_KEY', 'fixture-key-not-real');   // sendEmail is mocked: this only satisfies the service's check
  sendEmailMock.mockClear();
  sendEmailMock.mockImplementation(async () => ({ id: 'msg_1' }));
  fx = await buildOrg();
  fxB = await buildOrg({ label: 'b' });
  sessionAs(fx.members.owner.userId);
});

async function invitee() {
  const u = await testDb.user.create({ data: { email: `invitee-${randomUUID().slice(0, 8)}@fixture.test`, name: 'Invitee', passwordHash: 'x' } });
  return { userId: u.id, email: u.email };
}

describe('pending invitations', () => {
  it('FR-MEM-02: pending invitations are listed with their expiry', async () => {
    const NOW = new Date();
    const inv = await seedInvitation(fx, { email: 'listed@fixture.test' });
    const stored = await row(inv.id);
    const list = await listInvitations(ctxFor(fx, 'owner'), NOW);
    expect(list.map((i) => [i.email, i.state, i.expiresAt])).toEqual([['listed@fixture.test', 'pending', stored.expiresAt.toISOString()]]);
    expect(await listInvitations(ctxFor(fx, 'owner'), new Date(NOW.getTime() + 8 * DAY))).toEqual([]);
  });

  it('FR-MEM-02: a resend refuses the old link and the new one works', async () => {
    const who = await invitee();
    const old = await seedInvitation(fx, { email: who.email });   // the accepting account's address, as accept_invitation requires
    const r = await post(RESEND, old.id, { showLink: true });
    expect(r.status).toBe(201);
    const body = (await r.json()) as InviteMemberResponse;
    await expect(acceptInvitationViaDefiner({ tokenHash: hash(old.token), userId: who.userId })).rejects.toMatchObject({ code: 'invitation_unusable' });
    const newToken = String(body.acceptUrl).split('/').pop()!;
    await expect(acceptInvitationViaDefiner({ tokenHash: hash(newToken), userId: who.userId })).resolves.toMatchObject({ orgId: fx.org.id });
    expect((await row(old.id)).status).toBe('revoked');
  });

  it('FR-MEM-02: a revoked link is refused, and revoking twice answers 409', async () => {
    const inv = await seedInvitation(fx);
    const who = await invitee();
    expect((await post(REVOKE, inv.id)).status).toBe(204);
    await expect(acceptInvitationViaDefiner({ tokenHash: hash(inv.token), userId: who.userId })).rejects.toMatchObject({ code: 'invitation_unusable' });
    const again = await post(REVOKE, inv.id);
    expect({ status: again.status, code: (await again.json()).code }).toEqual({ status: 409, code: 'invitation_not_pending' });
  });

  it('FR-MEM-02: an admin cannot resend or revoke an owner invitation; a first-owner invitation is 404 here', async () => {
    const ownerInv = await seedInvitation(fx, { role: 'owner' });
    const firstOwner = await seedInvitation(fx, { role: 'owner', kind: 'first_owner' });
    sessionAs(fx.members.admin.userId);
    expect((await post(RESEND, ownerInv.id, { showLink: false })).status).toBe(403);
    expect((await post(REVOKE, ownerInv.id)).status).toBe(403);
    sessionAs(fx.members.owner.userId);
    expect((await post(REVOKE, firstOwner.id)).status).toBe(404);
    expect((await post(RESEND, firstOwner.id, { showLink: false })).status).toBe(404);
    expect((await row(firstOwner.id)).status).toBe('pending');
  });

  it("FR-MEM-02 NFR-SEC-02: another organisation's invitation answers 404 and changes nothing", async () => {
    const theirs = await seedInvitation(fxB);
    expect((await post(REVOKE, theirs.id)).status).toBe(404);
    expect((await post(RESEND, theirs.id, { showLink: false })).status).toBe(404);
    expect((await row(theirs.id)).status).toBe('pending');
  });

  it('FR-MEM-01 FR-MEM-02: a resend counts toward the inviter limit', async () => {
    const old = await seedInvitation(fx);
    const stamp = (i: number) => ({
      orgId: fx.org.id, email: `fill-${i}@fixture.test`, role: 'viewer' as const, invitedById: fx.members.owner.userId,
      tokenHash: hash(`fill-${i}`), expiresAt: new Date(Date.now() + DAY),
    });
    await testDb.invitation.createMany({ data: Array.from({ length: 19 }, (_, i) => stamp(i)) });   // with `old`, 20 in the hour
    const r = await post(RESEND, old.id, { showLink: false });
    expect({ status: r.status, code: (await r.json()).code }).toEqual({ status: 429, code: 'rate_limited' });
    expect((await row(old.id)).status).toBe('pending');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('NFR-INT-02: a replay of a resend answers 200 with the invitation view and no link, creates no further invitation, and sends nothing', async () => {
    const old = await seedInvitation(fx);
    const body = { requestId: REQ, showLink: true };
    const first = await post(RESEND, old.id, body);
    const firstBody = (await first.json()) as InviteMemberResponse;
    const sends = sendEmailMock.mock.calls.length;
    const before = await rowCounts();
    const again = await post(RESEND, old.id, body);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(await again.json()).toEqual({ invitation: firstBody.invitation, acceptUrl: null, emailSent: false });
    expect(sendEmailMock.mock.calls.length).toBe(sends);
    expect(await rowCounts()).toEqual(before);
    expect(await receiptsOf(fx.org.id)).toEqual([
      expect.objectContaining({ requestId: REQ, route: `${RESEND}::POST`, rowId: firstBody.invitation.id, result: null }),
    ]);
  });

  it('NFR-INT-02: the same request id for a resend with another body or another invitation answers 409 request_id_reused and changes nothing', async () => {
    const old = await seedInvitation(fx);
    const other = await seedInvitation(fx);
    await post(RESEND, old.id, { requestId: REQ, showLink: false });
    const before = await rowCounts();
    for (const [id, body] of [[old.id, { requestId: REQ, showLink: true }], [other.id, { requestId: REQ, showLink: false }]] as const) {
      const r = await post(RESEND, id, body);
      expect({ status: r.status, code: (await r.json()).code }).toEqual({ status: 409, code: 'request_id_reused' });
    }
    expect(await rowCounts()).toEqual(before);
  });

  it('NFR-INT-02: a replay of a revoke answers 204, not 409 invitation_not_pending, and writes nothing; the same id for another invitation answers 409 request_id_reused', async () => {
    const inv = await seedInvitation(fx);
    const other = await seedInvitation(fx);
    const body = { requestId: REQ };
    expect((await post(REVOKE, inv.id, body)).status).toBe(204);
    const before = await rowCounts();
    expect((await post(REVOKE, inv.id, body)).status).toBe(204);
    expect(await rowCounts()).toEqual(before);
    expect(await receiptsOf(fx.org.id)).toEqual([expect.objectContaining({ requestId: REQ, route: `${REVOKE}::POST`, rowId: null, result: null })]);
    const clash = await post(REVOKE, other.id, body);
    expect({ status: clash.status, code: (await clash.json()).code }).toEqual({ status: 409, code: 'request_id_reused' });
    expect((await row(other.id)).status).toBe('pending');
  });

  it('NFR-INT-02: routes 28 and 29 POST are listed in RETRY_KEYED_WRITES and in no UNKEYED_WRITES entry', () => {
    for (const f of [RESEND, REVOKE]) {
      expect(RETRY_KEYED_WRITES[f]).toContain('POST');
      expect(UNKEYED_WRITES[f]).toBeUndefined();
      expect(PENDING_ROUTES).not.toContain(f);
    }
  });
});

describe('listMembers: the copied-link mark', () => {
  it('FR-ACC-10 (helper): a member is marked when the account was created after an invitation whose link was shown, and not otherwise', async () => {
    const { listMembers } = await import('@/lib/data/members');
    const accept = async (linkShown: boolean, accountFirst: boolean) => {
      const email = `joiner-${randomUUID().slice(0, 8)}@fixture.test`;
      const inv = await testDb.invitation.create({ data: {
        orgId: fx.org.id, email, role: 'viewer', invitedById: fx.members.owner.userId, tokenHash: hash(randomUUID()),
        createdAt: new Date(Date.now() - 3_600_000), expiresAt: new Date(Date.now() + DAY), linkShownAt: linkShown ? new Date() : null,
      } });
      const u = await testDb.user.create({ data: { email, name: `Joiner ${linkShown}-${accountFirst}`, passwordHash: 'x', createdAt: new Date(Date.now() - (accountFirst ? 7_200_000 : 60_000)) } });
      await testDb.consentRecord.createMany({ data: (await import('../helpers/legalStub')).stubAcceptanceRows(u.id) });
      await acceptInvitationViaDefiner({ tokenHash: inv.tokenHash, userId: u.id });
      return u.name;
    };
    const shown = await accept(true, false);
    const notShown = await accept(false, false);
    const existing = await accept(true, true);
    const byName = new Map((await listMembers(ctxFor(fx, 'owner'))).map((x) => [x.name, x.createdFromShownLink]));
    expect([byName.get(shown), byName.get(notShown), byName.get(existing)]).toEqual([true, false, false]);
  });
});

describe('an expired invitation (F10)', () => {
  it('FR-MEM-02 (F10): resend and revoke apply only to a pending invitation: an expired one answers 409 invitation_not_pending and changes nothing', async () => {
    const inv = await seedInvitation(fx);
    await testDb.invitation.update({ where: { id: inv.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const before = await rowCounts();
    for (const [file, body] of [[RESEND, { showLink: false }], [REVOKE, {}]] as const) {
      const r = await post(file, inv.id, body);
      expect({ status: r.status, code: (await r.json()).code }).toEqual({ status: 409, code: 'invitation_not_pending' });
    }
    expect(await rowCounts()).toEqual(before);
    expect((await row(inv.id)).status).toBe('pending');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('races and re-joins', () => {
  it('FR-MEM-02 (F5): two revokes of one invitation under different request ids end in one revoke and one coded 409, never a 500', async () => {
    for (let i = 0; i < 5; i++) {
      const inv = await seedInvitation(fx);
      const owner = { userId: fx.members.owner.userId, role: 'owner' as const };
      const go = () => {
        const body = { requestId: randomUUID() };
        return revokeInvitation(ctxFor(fx, 'owner'), owner, { ...body, invitationId: inv.id }, requestDigest({ path: { invitationId: inv.id }, body }));
      };
      const rs = await Promise.all([go(), go()].map((p) => p.then(() => 'ok', (e: unknown) => (e instanceof ConflictError ? 'conflict' : String(e)))));
      expect(rs.sort()).toEqual(['conflict', 'ok']);
    }
  });

  it('FR-ACC-10 (F12): a member who joined twice is marked by the latest join, not by whichever row is read last', async () => {
    const { listMembers } = await import('@/lib/data/members');
    const email = `rejoin-${randomUUID().slice(0, 6)}@fixture.test`;
    const user = await testDb.user.create({ data: { email, name: 'Rejoiner', passwordHash: 'x', createdAt: new Date(Date.now() - 3 * 3_600_000) } });
    await testDb.membership.create({ data: { orgId: fx.org.id, userId: user.id, role: 'viewer' } });
    const invitation = (shown: boolean, tag: string) => testDb.invitation.create({ data: {
      orgId: fx.org.id, email, role: 'viewer', invitedById: fx.members.owner.userId, tokenHash: hash(tag),
      createdAt: new Date(Date.now() - 4 * 3_600_000), expiresAt: new Date(Date.now() + DAY), linkShownAt: shown ? new Date() : null,
    } });
    const [latest, earlier] = [await invitation(false, 'latest'), await invitation(true, 'earlier')];
    // `at` is set by the database, so the join order is the insert order: the earlier join first, the later one last.
    const joined = (invitationId: string) => testDb.$executeRaw`
      INSERT INTO organisation_events (id, "orgId", "actorId", "actorRole", action, "targetUserId", "targetInvitationId")
      VALUES (${randomUUID()}, ${fx.org.id}, ${user.id}, 'viewer', 'member_joined', ${user.id}, ${invitationId})`;
    await joined(earlier.id);
    await new Promise((r) => setTimeout(r, 20));
    await joined(latest.id);
    const mark = (await listMembers(ctxFor(fx, 'owner'))).find((m) => m.userId === user.id)?.createdFromShownLink;
    expect(mark).toBe(false);
  });
});
