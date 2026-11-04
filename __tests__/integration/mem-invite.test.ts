import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InviteMemberResponse } from '@/types/api';
import { RETRY_KEYED_WRITES, UNKEYED_WRITES } from '@/lib/authz/routeActions';
import { resetDb, testDb } from '../helpers/db';
import { buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { callRoute, rowCounts, sessionAs } from '../helpers/routeDriver';
import { captureLogs } from '../helpers/logCapture';
import { currentAcceptances } from '../helpers/legalStub';
import { hashInvitationToken } from '../../lib/data/invitationToken';

/**
 * MEM Task 3: invitations through route 25 (FR-MEM-01, NFR-INT-02). The real handler runs behind AUTHZ's route
 * driver; only the email transport is mocked (it would otherwise call Resend).
 */
const sendEmailMock = vi.hoisted(() => vi.fn(async (_m: { to: string }) => ({ id: 'msg_1' })));
vi.mock('@/lib/email/send', () => ({ sendEmail: sendEmailMock }));
// Route 31's invitation lookup, wrapped so one case can make the database unreachable (as ACC-a's route test does).
vi.mock('@/lib/data/preauth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/data/preauth')>();
  return { ...real, invitationByToken: vi.fn(real.invitationByToken) };
});
const { invitationByToken } = await import('@/lib/data/preauth');
// Concurrent handlers: overlapping dynamic imports of the mocked lib/auth load the real one (helpers/authSession.ts).
vi.mock('@/lib/auth/identity', async (importOriginal) =>
  (await import('../helpers/authSession')).queuedIdentity(await importOriginal<typeof import('@/lib/auth/identity')>()));

const route25 = 'app/api/v1/orgs/[slug]/members/route.ts';
const REQ = '3f6b1c1e-6a52-4d57-9f6a-0b7a3c1d2e45';
let fx: OrgFixture;

const post = (file: string, body: Record<string, unknown> | undefined, params?: Record<string, string>) =>
  callRoute(file, 'POST', { slug: fx.org.slug, params, body: { requestId: randomUUID(), ...body } });
const invite = (i: number) => ({ email: `bulk-${i}@fixture.test`, role: 'viewer', showLink: false });
const receiptsOf = (orgId: string) =>
  testDb.requestReceipt.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
const row = (id: string) => testDb.invitation.findUniqueOrThrow({ where: { id } });
async function inviteVia(file: string, body: Record<string, unknown>): Promise<InviteMemberResponse> {
  const r = await post(file, body);
  expect(r.status).toBe(201);
  return (await r.json()) as InviteMemberResponse;
}

beforeEach(async () => {
  await resetDb();
  vi.stubEnv('EMAIL_FROM_ADDRESS', 'onboarding@resend.dev');
  sendEmailMock.mockClear();
  sendEmailMock.mockImplementation(async () => ({ id: 'msg_1' }));
  fx = await buildOrg();
  sessionAs(fx.members.owner.userId);
});

describe('route 25 POST: invite', () => {
  it('FR-MEM-01: an admin inviting an owner gets 403, a reviewer 201', async () => {
    sessionAs(fx.members.admin.userId);
    expect((await post(route25, { email: 'o@fixture.test', role: 'owner', showLink: false })).status).toBe(403);
    const r = await post(route25, { email: 'r@fixture.test', role: 'reviewer', showLink: true });
    expect(r.status).toBe(201);
    const body = (await r.json()) as InviteMemberResponse;
    expect(body.acceptUrl).toMatch(/\/invitations\/[0-9a-f]{64}$/);
    expect(await testDb.invitation.count({ where: { orgId: fx.org.id, email: 'r@fixture.test', status: 'pending' } })).toBe(1);
  });

  it('FR-MEM-01 FR-ACC-10 (helper): the link is returned only with Show link, which writes linkShownAt', async () => {
    const shown = await inviteVia(route25, { email: 's@fixture.test', role: 'viewer', showLink: true });
    const hidden = await inviteVia(route25, { email: 'h@fixture.test', role: 'viewer', showLink: false });
    expect(hidden.acceptUrl).toBeNull();
    expect((await row(shown.invitation.id)).linkShownAt).not.toBeNull();
    expect((await row(hidden.invitation.id)).linkShownAt).toBeNull();
    expect(shown.invitation).toMatchObject({ email: 's@fixture.test', kind: 'member', state: 'pending', linkShown: true });
  });

  it('FR-MEM-01: the 21st invitation in an hour answers 429 and sends nothing', async () => {
    for (let i = 0; i < 20; i++) expect((await post(route25, invite(i))).status).toBe(201);
    const sends = sendEmailMock.mock.calls.length;
    const before = await rowCounts();
    const r = await post(route25, invite(20));
    const b = await r.json();
    expect({ status: r.status, code: b.code }).toEqual({ status: 429, code: 'rate_limited' });
    expect(b.retryAfterSeconds).toBeGreaterThan(0);
    expect(sendEmailMock.mock.calls.length).toBe(sends);
    expect(await rowCounts()).toEqual(before);
    expect(await testDb.invitation.count({ where: { invitedById: fx.members.owner.userId } })).toBe(20);
  });

  it('FR-MEM-01: resends count toward the limit, and the organisation stops at 100 a day', async () => {
    const stamp = (i: number, by: string, ageMs: number, status: 'pending' | 'revoked' = 'pending') => ({
      orgId: fx.org.id, email: `old-${i}@fixture.test`, role: 'viewer' as const, status, invitedById: by,
      tokenHash: createHash('sha256').update(`seed-${i}-${by}`).digest('hex'),
      createdAt: new Date(Date.now() - ageMs), expiresAt: new Date(Date.now() + 86_400_000),
    });
    // 19 invitations and 1 resend (a revoked old row plus its replacement) by the owner within the hour: 20 rows in all
    const owner = fx.members.owner.userId;
    await testDb.invitation.createMany({ data: [...Array.from({ length: 19 }, (_, i) => stamp(i, owner, 60_000)), stamp(19, owner, 30_000, 'revoked')] });
    const r = await post(route25, invite(100));
    expect({ status: r.status, code: (await r.json()).code }).toEqual({ status: 429, code: 'rate_limited' });

    // 100 rows of the organisation in the last 24 hours, written by five inviters at 2 hours old: the next one answers 429 too
    await resetDb();
    fx = await buildOrg();
    sessionAs(fx.members.owner.userId);
    const five = [fx.members.owner, fx.members.admin, fx.members.assessor, fx.members.reviewer, fx.members.viewer].map((m) => m.userId);
    await testDb.invitation.createMany({ data: five.flatMap((by, k) => Array.from({ length: 20 }, (_, i) => stamp(k * 20 + i, by, 2 * 3_600_000))) });
    const day = await post(route25, invite(101));
    expect({ status: day.status, code: (await day.json()).code }).toEqual({ status: 429, code: 'rate_limited' });
    expect(await testDb.invitation.count({ where: { orgId: fx.org.id } })).toBe(100);
  });

  it('FR-MEM-01: 25 concurrent invitations by one inviter create exactly 20', async () => {
    const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => post(route25, invite(i))));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(20);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(5);
    expect(await testDb.invitation.count({ where: { invitedById: fx.members.owner.userId } })).toBe(20);
  });

  it('NFR-INT-02: a replay of an invitation answers 200 with the invitation view and no link, creates nothing new, and sends nothing', async () => {
    const body = { requestId: REQ, email: 'r@fixture.test', role: 'reviewer', showLink: true };
    const first = await post(route25, body);
    const firstBody = (await first.clone().json()) as InviteMemberResponse;
    expect(firstBody.acceptUrl).toMatch(/\/invitations\/[0-9a-f]{64}$/);
    const sends = sendEmailMock.mock.calls.length;
    const before = await rowCounts();
    const again = await post(route25, body);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(((await first.clone().json()) as InviteMemberResponse).emailSent).toBe(true);
    expect(await again.json()).toEqual({ invitation: firstBody.invitation, acceptUrl: null, emailSent: false });
    expect(sendEmailMock.mock.calls.length).toBe(sends);
    expect(await rowCounts()).toEqual(before);
    expect(await receiptsOf(fx.org.id)).toEqual([
      expect.objectContaining({ requestId: REQ, route: 'app/api/v1/orgs/[slug]/members/route.ts::POST', rowId: firstBody.invitation.id, result: null }),
    ]);
  });

  it('NFR-INT-02: E-01 is sent once, after the commit: when the send is made the invitation and its receipt are already visible on another connection', async () => {
    let seen: { invitations: number; receipts: number } | null = null;
    sendEmailMock.mockImplementationOnce(async () => {
      seen = {
        invitations: await testDb.invitation.count({ where: { orgId: fx.org.id, email: 'c@fixture.test' } }),
        receipts: (await receiptsOf(fx.org.id)).length,
      };
      return { id: 'msg_1' };
    });
    const body = { requestId: REQ, email: 'c@fixture.test', role: 'viewer', showLink: false };
    expect((await post(route25, body)).status).toBe(201);
    expect(seen).toEqual({ invitations: 1, receipts: 1 });
    expect((await post(route25, body)).status).toBe(200);
    expect(sendEmailMock.mock.calls.filter(([m]) => m.to === 'c@fixture.test')).toHaveLength(1);
  });

  it('NFR-INT-02: an invitation whose email failed answers 201 with emailSent false and keeps the invitation and the receipt; its replay answers 200 with emailSent false and sends nothing more', async () => {
    sendEmailMock.mockRejectedValueOnce(new Error('smtp down'));
    const body = { requestId: REQ, email: 'f@fixture.test', role: 'viewer', showLink: false };
    const first = await post(route25, body);
    expect([first.status, ((await first.json()) as InviteMemberResponse).emailSent]).toEqual([201, false]);
    expect(await testDb.invitation.count({ where: { orgId: fx.org.id, email: 'f@fixture.test', status: 'pending' } })).toBe(1);
    const sends = sendEmailMock.mock.calls.length;
    const again = await post(route25, body);
    expect([again.status, ((await again.json()) as InviteMemberResponse).emailSent]).toEqual([200, false]);
    expect(sendEmailMock.mock.calls.length).toBe(sends);
    expect((await receiptsOf(fx.org.id))[0]).toMatchObject({ result: null });
  });

  it('NFR-INT-02: a replay is not counted toward the limit, and a replay at the limit answers the first result', async () => {
    const bodies = Array.from({ length: 20 }, (_, i) => ({ ...invite(i), requestId: randomUUID() }));
    for (const b of bodies) expect((await post(route25, b)).status).toBe(201);
    expect((await post(route25, bodies[19])).status).toBe(200);
    expect((await post(route25, invite(20))).status).toBe(429);
  });

  it('NFR-INT-02: the same request id with another email, role or inviter answers 409 request_id_reused and creates nothing', async () => {
    const body = { requestId: REQ, email: 'r@fixture.test', role: 'reviewer', showLink: false };
    await post(route25, body);
    const before = await rowCounts();
    for (const changed of [{ ...body, email: 'other@fixture.test' }, { ...body, role: 'viewer' }]) {
      const r = await post(route25, changed);
      expect({ status: r.status, code: (await r.json()).code }).toEqual({ status: 409, code: 'request_id_reused' });
    }
    sessionAs(fx.members.admin.userId);
    expect((await post(route25, body)).status).toBe(409);
    expect(await rowCounts()).toEqual(before);
  });

  it('NFR-INT-02: a body without a request id, or with a malformed one, answers 422 on requestId', async () => {
    for (const requestId of [undefined, 'not-a-uuid']) {
      const r = await callRoute(route25, 'POST', { slug: fx.org.slug, body: { requestId, email: 'x@fixture.test', role: 'viewer', showLink: false } });
      expect(r.status).toBe(422);
      expect((await r.json()).fields).toEqual([expect.objectContaining({ field: 'requestId' })]);
    }
  });

  it('NFR-INT-02: route 25 POST is listed in RETRY_KEYED_WRITES and in no UNKEYED_WRITES entry', () => {
    expect(RETRY_KEYED_WRITES[route25]).toContain('POST');
    expect(UNKEYED_WRITES[route25]?.methods ?? []).not.toContain('POST');
  });
});

describe('route 31 POST: the account-name rule', () => {
  const ROUTE31 = 'app/api/v1/invitations/[token]/register/route.ts';
  const GOOD = 'a'.repeat(12);
  const invitedEmail = 'invited-person@fixture.test';
  let token: string;
  const register = (body: Record<string, unknown>) => {
    sessionAs(null);
    return callRoute(ROUTE31, 'POST', { slug: '', params: { token }, body });
  };
  const withNameBody = (name: string) => ({ name, password: GOOD, acceptances: currentAcceptances() });

  beforeEach(async () => {
    vi.stubEnv('RESEND_API_KEY', 'fixture-key-not-real');   // sendEmail is mocked: this only satisfies the route's check
    token = randomBytes(32).toString('hex');
    await testDb.invitation.create({ data: {
      orgId: fx.org.id, email: invitedEmail, role: 'viewer', tokenHash: hashInvitationToken(token),
      invitedById: fx.members.owner.userId, expiresAt: new Date(Date.now() + 7 * 86_400_000),
    } });
  });

  it('FR-MEM-01: a name containing :// or www. is refused at sign-up', async () => {
    for (const name of ['Visit https://x.example', 'www.example.org', 'WWW.Example', 'see HTTP://X']) {
      const r = await register(withNameBody(name));
      const b = await r.json();
      expect({ status: r.status, code: b.code, field: b.fields?.[0]?.field }).toEqual({ status: 422, code: 'validation', field: 'name' });
    }
    expect(await testDb.user.count({ where: { email: invitedEmail } })).toBe(0);
    expect((await register(withNameBody('Nakato Sarah'))).status).toBe(201);
  });

  it('NFR-AVL-04 NFR-OBS-05: with the database unreachable, route 31 answers 503 database_unavailable with a reference and writes one REQUEST_FAILED line', async () => {
    vi.mocked(invitationByToken).mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const { result, lines } = await captureLogs(() => register(withNameBody('Nakato Sarah')));
    const body = await result.json();
    expect([result.status, body]).toEqual([503, { error: 'Service unavailable', code: 'database_unavailable', reference: expect.stringMatching(/^[0-9a-f]{8}$/) }]);
    expect(lines.filter((l) => l.includes('REQUEST_FAILED') && l.includes(body.reference))).toHaveLength(1);
    expect(await testDb.user.count({ where: { email: invitedEmail } })).toBe(0);
  });
});
