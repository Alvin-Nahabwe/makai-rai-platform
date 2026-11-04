import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { RETRY_KEYED_WRITES, ROUTE_ACTIONS, UNKEYED_WRITES } from '@/lib/authz/routeActions';
import { requestDigest } from '@/lib/data/idempotency';
import { removeMember } from '@/lib/data/members';
import { resetDb, testDb } from '../helpers/db';
import { buildOrg, ctxFor, type FixtureMember, type OrgFixture } from '../helpers/recordFixture';
import { callRoute, idsOf, rowCounts, sessionAs, type Method } from '../helpers/routeDriver';

/**
 * MEM Task 5: role change, removal and leave (routes 26 and 27), the active-owner guard (FR-MEM-04), the event rows
 * (FR-ORG-09) and the retry safety of all three (NFR-INT-02). The real handlers run behind AUTHZ's route driver.
 */
// Concurrent handlers: overlapping dynamic imports of the mocked lib/auth load the real one (helpers/authSession.ts).
vi.mock('@/lib/auth/identity', async (importOriginal) =>
  (await import('../helpers/authSession')).queuedIdentity(await importOriginal<typeof import('@/lib/auth/identity')>()));

const ROUTE26 = 'app/api/v1/orgs/[slug]/members/[userId]/route.ts';
const ROUTE27 = 'app/api/v1/orgs/[slug]/members/leave/route.ts';
const REQ = '8a3e5b2c-1f4d-4c6a-9b7e-0d2c4a6e8f10';
let fx: OrgFixture;
let fxB: OrgFixture;

type Body = Record<string, unknown>;
const send = (method: Method, file: string, userId: string | null, body?: Body) =>
  callRoute(file, method, { slug: fx.org.slug, params: userId === null ? undefined : { userId }, body: { requestId: randomUUID(), ...body } });
const patch = (userId: string, body: Body) => send('PATCH', ROUTE26, userId, body);
const del = (userId: string, body?: Body) => send('DELETE', ROUTE26, userId, body);
const as = (m: FixtureMember) => sessionAs(m.userId);
const patchAs = (m: FixtureMember, userId: string, body: Body) => { as(m); return patch(userId, body); };
const delAs = (m: FixtureMember, userId: string, body?: Body) => { as(m); return del(userId, body); };
const leaveAs = (m: FixtureMember, body?: Body) => { as(m); return send('POST', ROUTE27, null, body); };
const receiptsOf = (orgId: string) => testDb.requestReceipt.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
const eventActions = async (orgId: string) =>
  (await testDb.organisationEvent.findMany({ where: { orgId }, orderBy: { at: 'asc' } })).map((e) => e.action);
const codeOf = async (r: Response) => ({ status: r.status, code: (await r.json()).code });
const makeOwner = (m: FixtureMember) => testDb.membership.updateMany({ where: { orgId: fx.org.id, userId: m.userId }, data: { role: 'owner' } });
const removeVia = (userId: string, actor: { userId: string; role: OrgRole }, target: string) => {
  const body = { requestId: randomUUID() };
  return removeMember(ctxFor(fx, actor.role), actor, { ...body, userId: target }, requestDigest({ path: { userId: target }, body }));
};

beforeEach(async () => {
  await resetDb();
  fx = await buildOrg();
  fxB = await buildOrg({ label: 'b' });
  sessionAs(fx.members.owner.userId);
});

describe('role change', () => {
  it('FR-MEM-03: an assessor changed to viewer is refused a decision save on the next request', async () => {
    expect((await patchAs(fx.members.owner, fx.members.assessor.userId, { role: 'viewer' })).status).toBe(204);
    as(fx.members.assessor);
    const decisions = 'app/api/v1/orgs/[slug]/projects/[id]/decisions/route.ts';
    const r = await callRoute(decisions, 'POST', { slug: fx.org.slug, params: await idsOf(fx, decisions), body: {} });
    expect(await codeOf(r)).toEqual({ status: 403, code: 'forbidden' });
  });

  it('FR-MEM-03 FR-MEM-04: an admin cannot change or remove an owner, nor grant owner', async () => {
    as(fx.members.admin);
    expect((await patch(fx.members.owner.userId, { role: 'viewer' })).status).toBe(403);
    expect((await del(fx.members.owner.userId)).status).toBe(403);
    expect((await patch(fx.members.viewer.userId, { role: 'owner' })).status).toBe(403);
    expect((await patch(fx.members.viewer.userId, { role: 'assessor' })).status).toBe(204);
  });

  it('FR-MEM-03 NFR-SEC-02: a missing member or a member of another organisation answers the coded 404', async () => {
    for (const userId of ['00000000-0000-4000-8000-000000000000', fxB.members.viewer.userId]) {
      expect(await codeOf(await patch(userId, { role: 'viewer' }))).toEqual({ status: 404, code: 'not_found' });
      expect((await del(userId)).status).toBe(404);
    }
    expect(await testDb.membership.count({ where: { orgId: fxB.org.id } })).toBe(5);
  });

  it('FR-MEM-03: the route table and the v0.5.0 matrix cell follow the role change', () => {
    expect(ROUTE_ACTIONS[ROUTE26]).toEqual({ PATCH: 'member:role', DELETE: 'member:remove' });
  });

  it('FR-MEM-04: demoting the last owner answers 409', async () => {
    const r = await patchAs(fx.members.owner, fx.members.owner.userId, { role: 'admin' });
    expect(await codeOf(r)).toEqual({ status: 409, code: 'last_active_owner' });
  });

  it('FR-MEM-04: two owners, one deactivated: removing the active one answers 409', async () => {
    await makeOwner(fx.members.admin);
    await testDb.user.update({ where: { id: fx.members.admin.userId }, data: { isActive: false } });
    expect((await delAs(fx.members.owner, fx.members.owner.userId)).status).toBe(409);
    expect(await testDb.membership.count({ where: { orgId: fx.org.id, userId: fx.members.owner.userId } })).toBe(1);
  });

  it('FR-MEM-04: two concurrent removals of two owners leave one', async () => {
    await makeOwner(fx.members.admin);
    const a = { userId: fx.members.owner.userId, role: 'owner' as const };
    const b = { userId: fx.members.admin.userId, role: 'owner' as const };
    const rs = await Promise.all([removeVia(a.userId, a, b.userId), removeVia(b.userId, b, a.userId)].map((p) => p.then(() => 'ok', (e) => e.code)));
    expect(rs.sort()).toEqual(['last_active_owner', 'ok']);
    expect(await testDb.membership.count({ where: { orgId: fx.org.id, role: 'owner' } })).toBe(1);
  });
});

describe('leave', () => {
  it("FR-MEM-05: any member may leave; the last active owner's leave answers 409", async () => {
    expect((await leaveAs(fx.members.viewer)).status).toBe(204);
    expect(await codeOf(await leaveAs(fx.members.owner))).toEqual({ status: 409, code: 'last_active_owner' });
  });
});

describe('retry safety', () => {
  it('NFR-INT-02: a replay of a role change answers 204 again and writes no further event row; the same id with another role or member answers 409 request_id_reused', async () => {
    const body = { requestId: REQ, role: 'reviewer' };
    const first = await patch(fx.members.assessor.userId, body);
    const before = await rowCounts();
    const again = await patch(fx.members.assessor.userId, body);
    expect([first.status, again.status]).toEqual([204, 204]);
    expect(await rowCounts()).toEqual(before);
    expect(await receiptsOf(fx.org.id)).toEqual([
      expect.objectContaining({ requestId: REQ, route: `${ROUTE26}::PATCH`, rowId: null, result: null }),
    ]);
    for (const [userId, changed] of [[fx.members.assessor.userId, { requestId: REQ, role: 'viewer' }], [fx.members.viewer.userId, body]] as const) {
      expect(await codeOf(await patch(userId, changed))).toEqual({ status: 409, code: 'request_id_reused' });
    }
    expect(await rowCounts()).toEqual(before);
  });

  it('NFR-INT-02: a replay of a removal answers 204, not 404, and writes nothing; the same id for another member answers 409 request_id_reused', async () => {
    const body = { requestId: REQ };
    expect((await del(fx.members.viewer.userId, body)).status).toBe(204);
    const before = await rowCounts();
    expect((await del(fx.members.viewer.userId, body)).status).toBe(204);
    expect(await rowCounts()).toEqual(before);
    expect((await receiptsOf(fx.org.id))[0]).toMatchObject({ route: `${ROUTE26}::DELETE`, rowId: null, result: null });
    expect(await codeOf(await del(fx.members.reviewer.userId, body))).toEqual({ status: 409, code: 'request_id_reused' });
    expect(await testDb.membership.count({ where: { orgId: fx.org.id, userId: fx.members.reviewer.userId } })).toBe(1);
  });

  it('NFR-INT-02: leave writes one receipt; the member who left, replaying, is refused at the gate with 404 and nothing changes; another member using the same request id answers 409 request_id_reused and stays a member', async () => {
    const body = { requestId: REQ };
    expect((await leaveAs(fx.members.viewer, body)).status).toBe(204);
    expect((await receiptsOf(fx.org.id))[0]).toMatchObject({
      requestId: REQ, route: `${ROUTE27}::POST`, rowId: null, result: null, actorUserId: fx.members.viewer.userId,
    });
    const before = await rowCounts();
    expect(await codeOf(await leaveAs(fx.members.viewer, body))).toEqual({ status: 404, code: 'not_found' });
    expect(await rowCounts()).toEqual(before);
    expect(await codeOf(await leaveAs(fx.members.reviewer, body))).toEqual({ status: 409, code: 'request_id_reused' });
    expect(await testDb.membership.count({ where: { orgId: fx.org.id, userId: fx.members.reviewer.userId } })).toBe(1);
  });

  it('NFR-INT-02: an owner who removes themself (a second owner exists) gets 204, and the replay is refused at the gate with 404 and changes nothing', async () => {
    await makeOwner(fx.members.admin);
    const body = { requestId: REQ };
    expect((await delAs(fx.members.owner, fx.members.owner.userId, body)).status).toBe(204);
    const before = await rowCounts();
    expect(await codeOf(await delAs(fx.members.owner, fx.members.owner.userId, body))).toEqual({ status: 404, code: 'not_found' });
    expect(await rowCounts()).toEqual(before);
  });

  it('NFR-INT-02: routes 26 PATCH and DELETE and 27 POST are listed in RETRY_KEYED_WRITES, and none of the five member and invitation route files is left in UNKEYED_WRITES', () => {
    const memberFiles = ['members/route.ts', 'members/[userId]/route.ts', 'members/leave/route.ts', 'invitations/[invitationId]/resend/route.ts', 'invitations/[invitationId]/revoke/route.ts']
      .map((s) => `app/api/v1/orgs/[slug]/${s}`);
    expect(RETRY_KEYED_WRITES[ROUTE26]).toEqual(expect.arrayContaining(['PATCH', 'DELETE']));
    expect(RETRY_KEYED_WRITES[ROUTE27]).toContain('POST');
    for (const f of memberFiles) expect({ f, left: UNKEYED_WRITES[f] }).toEqual({ f, left: undefined });
  });

  it('NFR-INT-02: a body without a request id answers 422 on requestId for each of the three routes', async () => {
    for (const [method, file, userId] of [['PATCH', ROUTE26, fx.members.viewer.userId], ['DELETE', ROUTE26, fx.members.viewer.userId], ['POST', ROUTE27, null]] as const) {
      const r = await callRoute(file, method, { slug: fx.org.slug, params: userId === null ? undefined : { userId }, body: { role: 'viewer' } });
      expect(r.status).toBe(422);
      expect((await r.json()).fields).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'requestId' })]));
    }
  });
});

describe('event rows', () => {
  it('FR-MEM-03 FR-ORG-09 (helper): each membership change writes one event row in its own transaction', async () => {
    const invite = await callRoute('app/api/v1/orgs/[slug]/members/route.ts', 'POST', {
      slug: fx.org.slug, body: { requestId: randomUUID(), email: 'ev@fixture.test', role: 'viewer', showLink: false },
    });
    expect(invite.status).toBe(201);
    expect((await patch(fx.members.assessor.userId, { role: 'reviewer' })).status).toBe(204);
    expect((await del(fx.members.reviewer.userId)).status).toBe(204);
    expect((await leaveAs(fx.members.viewer)).status).toBe(204);
    expect(await eventActions(fx.org.id)).toEqual(['member_invited', 'member_role_changed', 'member_removed', 'member_left']);
    const rows = await testDb.organisationEvent.findMany({ where: { orgId: fx.org.id }, orderBy: { at: 'asc' } });
    expect(rows.map((r) => [r.actorId, r.actorRole, r.targetUserId])).toEqual([
      [fx.members.owner.userId, 'owner', null],
      [fx.members.owner.userId, 'owner', fx.members.assessor.userId],
      [fx.members.owner.userId, 'owner', fx.members.reviewer.userId],
      [fx.members.viewer.userId, 'viewer', fx.members.viewer.userId],
    ]);
    expect(rows.some((r) => r.actorRole === 'platform_admin')).toBe(false);
    // a change whose transaction fails writes no row
    const n = rows.length;
    expect((await patch('00000000-0000-4000-8000-000000000000', { role: 'viewer' })).status).toBe(404);
    expect(await testDb.organisationEvent.count({ where: { orgId: fx.org.id } })).toBe(n);
  });
});
