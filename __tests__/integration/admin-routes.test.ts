import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Client } from 'pg';
import { testDb, resetDb } from '../helpers/db';
import { addIssuedDocument, addProject, addSealRow, addStageReview, buildOrg, buildPlatformAdmin, type FixtureAccount, type OrgFixture } from '../helpers/recordFixture';
import { callRoute, idsOf, rowCounts, sessionAs, validRequestFor, type Method } from '../helpers/routeDriver';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { markerFor } from '../helpers/markers';
import { acceptInvitationViaDefiner } from '../../lib/data/definer';
import { hashInvitationToken } from '../../lib/data/invitationToken';
import { listOrganisationsForAdmin } from '../../lib/data/admin';
import { listOrganisationEvents } from '../../lib/data/orgEvents';
import { createOrgContext } from '../../lib/data/tenant';
import { ROUTE_ACTIONS } from '../../lib/authz/routeActions';
import { requestDigest } from '../../lib/data/idempotency';
import { organisationIdFor } from '../../lib/data/definer';
import type { CreateOrganisationResponse } from '../../types/api';

/**
 * Routes 41 to 46, the MAK-AI administrator's organisation actions (FR-ORG-01, 02, 03, 05, 06, 09, 10; contract
 * "Routes" rows 41 to 46). Driven through the real handlers with AUTHZ's route driver; only the session is mocked.
 * Every write goes through a definer function, which writes its FR-ORG-09 row in the same transaction.
 */

const R41 = 'app/api/admin/organisations/route.ts';
const R42 = 'app/api/admin/organisations/[orgId]/route.ts';
const R43_GONE = 'app/api/admin/organisations/[orgId]/agreements/route.ts';   // route 43 is retired: nothing serves it
const R44 = 'app/api/admin/organisations/[orgId]/owner-invitations/route.ts';
const R45 = 'app/api/admin/organisations/[orgId]/owner-invitations/[invitationId]/resend/route.ts';
const R46 = 'app/api/admin/organisations/[orgId]/owner-invitations/[invitationId]/revoke/route.ts';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let admin: FixtureAccount;
let fx: OrgFixture;

const post41 = (body: object) => {
  sessionAs(admin.userId);
  return callRoute(R41, 'POST', { slug: '', body: { requestId: randomUUID(), ...body } });
};
const patch42 = (orgId: string, body: unknown) => { sessionAs(admin.userId); return callRoute(R42, 'PATCH', { slug: '', params: { orgId }, body }); };
const post44 = (orgId: string, body: unknown) => { sessionAs(admin.userId); return callRoute(R44, 'POST', { slug: '', params: { orgId }, body }); };
const post45 = (orgId: string, invitationId: string, body: Record<string, unknown>) => {
  sessionAs(admin.userId);
  return callRoute(R45, 'POST', { slug: '', params: { orgId, invitationId }, body: { requestId: randomUUID(), ...body } });
};
const post46 = (orgId: string, invitationId: string) => { sessionAs(admin.userId); return callRoute(R46, 'POST', { slug: '', params: { orgId, invitationId } }); };

const valid = (over: Record<string, unknown> = {}) => ({
  name: `Makerere CAI Lab ${randomUUID().slice(0, 6)}`, legalName: 'Makerere University', ownerEmail: `head-${randomUUID().slice(0, 6)}@fixture.test`, showLink: false, ...over,
});
/** The raw token at the end of an accept link. */
const tokenOf = (acceptUrl: string | null) => {
  if (acceptUrl === null) throw new Error('no accept link: the request did not ask for one');
  return decodeURIComponent(acceptUrl.split('/').at(-1)!);
};
const account = async (email: string) => (await testDb.user.create({ data: { email, name: email, passwordHash: 'x' } })).id;
const lastEvent = (orgId: string) => testDb.organisationEvent.findFirstOrThrow({ where: { orgId }, orderBy: [{ at: 'desc' }, { id: 'desc' }] });
const counts = async (orgId: string) => ({
  organizations: await testDb.organization.count({ where: { id: orgId } }),
  organization_agreements: await testDb.organisationAgreement.count({ where: { orgId } }),
  invitations: await testDb.invitation.count({ where: { orgId } }),
});
/** A created organisation with no owner and its pending first-owner invitation, and the link's token. */
async function created(over: Record<string, unknown> = {}) {
  const r = await post41(valid({ showLink: true, ...over }));
  expect(r.status).toBe(201);
  const b = await r.json() as CreateOrganisationResponse;
  return { ...b, token: tokenOf(b.acceptUrl) };
}

// Routes 43 and 45 are called twice at once below: requireIdentityForApi one call at a time, the writes still overlap
// in the database (authSession.ts, queuedIdentity).
vi.mock('@/lib/auth/identity', async (importOriginal) =>
  (await import('../helpers/authSession')).queuedIdentity(await importOriginal<typeof import('@/lib/auth/identity')>()));

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  await resetDb();
  admin = await buildPlatformAdmin();
  fx = await buildOrg({ label: 'admin-routes' });
});

describe('route 41: create an organisation', () => {
  it('FR-ORG-01: S-24 with all fields creates one organisation with its legal name, no agreement and one pending owner invitation', async () => {
    const body = valid({ name: 'Makerere CAI Lab', showLink: true });
    const r = await post41(body);
    expect(r.status).toBe(201);
    const b = await r.json() as CreateOrganisationResponse;
    expect(await counts(b.orgId)).toEqual({ organizations: 1, organization_agreements: 0, invitations: 1 });
    expect(b.slug).toBe('makerere-cai-lab');
    expect(b.invitation).toMatchObject({ kind: 'first_owner', state: 'pending', role: 'owner', linkShown: true, email: body.ownerEmail });
    expect(Object.keys(b).sort()).toEqual(['acceptUrl', 'emailSent', 'invitation', 'orgId', 'slug']);
    expect(b.emailSent).toBe(false);   // no sender configured in the test environment: still 201, with the link
    expect(b.acceptUrl).toMatch(/^https:\/\/vitest\.example\.invalid\/invitations\/[0-9a-f]{64}$/);
    const inv = await testDb.invitation.findUniqueOrThrow({ where: { id: b.invitation.id } });
    expect(inv.tokenHash).toBe(hashInvitationToken(tokenOf(b.acceptUrl)));
    const days = (inv.expiresAt.getTime() - inv.createdAt.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99); expect(days).toBeLessThan(7.01);
    expect(await testDb.organization.findUniqueOrThrow({ where: { id: b.orgId } })).toMatchObject({ legalName: 'Makerere University' });
  });

  it('FR-ORG-01: when the invitation insert is forced to fail, no organisation exists', async () => {
    const fn = `org_test_fail_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    await testDb.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced'; END $$`);
    await testDb.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON invitations FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    const body = valid();
    try {
      expect((await post41(body)).status).toBe(500);
    } finally {
      await testDb.$executeRawUnsafe(`DROP TRIGGER ${fn} ON invitations`);
      await testDb.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    }
    expect(await testDb.organization.count({ where: { name: body.name } })).toBe(0);
  });

  it('FR-ORG-01 FR-ORG-02: with no public origin configured, routes 41, 44 and 45 fail before anything is written, so no link is lost', async () => {
    const org = await created();
    const lapsed = await created();
    await testDb.invitation.update({ where: { id: lapsed.invitation.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const before = await rowCounts();
    vi.stubEnv('NEXTAUTH_URL', '');
    vi.stubEnv('AUTH_URL', '');
    for (const r of [await post41(valid()), await post44(lapsed.orgId, { email: 'z@fixture.test', requestReference: 'R-9', showLink: true }),
      await post45(org.orgId, org.invitation.id, { showLink: true })]) expect(r.status).toBe(500);
    expect(await rowCounts()).toEqual(before);
    expect((await testDb.invitation.findUniqueOrThrow({ where: { id: org.invitation.id } })).status).toBe('pending');   // the old link still works
  });

  it('FR-ORG-01: an account without the platform role gets 403 and nothing is created', async () => {
    const before = await rowCounts();
    sessionAs(fx.members.owner.userId);
    const r = await callRoute(R41, 'POST', { slug: '', body: valid() });
    expect({ status: r.status, code: (await r.json()).code }).toEqual({ status: 403, code: 'not_platform_admin' });
    for (const [file, method, params] of [[R42, 'PATCH', { orgId: fx.org.id }], [R44, 'POST', { orgId: fx.org.id }],
      [R45, 'POST', { orgId: fx.org.id, invitationId: randomUUID() }], [R46, 'POST', { orgId: fx.org.id, invitationId: randomUUID() }]] as const) {
      expect((await callRoute(file, method as Method, { slug: '', params, body: {} })).status, file).toBe(403);
    }
    sessionAs(null);
    expect((await callRoute(R41, 'POST', { slug: '', body: valid() })).status).toBe(401);
    expect(await rowCounts()).toEqual(before);
  });

  it('FR-ORG-01: the create form validates every field (422, nothing written)', async () => {
    const before = await rowCounts();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ name: '' }, 'name'],
      [{ name: 'x'.repeat(101) }, 'name'],
      [{ ownerEmail: 'not-an-address' }, 'ownerEmail'],
      [{ showLink: 'yes' }, 'showLink'],
      [{ legalName: ' ' }, 'legalName'],
      [{ legalName: 'x'.repeat(201) }, 'legalName'],
    ];
    for (const [over, field] of cases) {
      const r = await post41(valid(over));
      const b = await r.json();
      expect({ status: r.status, code: b.code, field: b.fields?.some((f: { field: string }) => f.field === field) }, JSON.stringify(over)).toEqual({ status: 422, code: 'validation', field: true });
    }
    expect(await rowCounts()).toEqual(before);
  });

  it('FR-ORG-02 FR-ACC-10 (helper): the first-owner link is returned only with Show link', async () => {
    const r = await post41(valid({ showLink: false }));
    const b = await r.json() as CreateOrganisationResponse;
    expect(b.acceptUrl).toBeNull();
    expect(b.invitation.linkShown).toBe(false);
    expect((await testDb.invitation.findUniqueOrThrow({ where: { id: b.invitation.id } })).linkShownAt).toBeNull();
    const shown = await created();
    expect((await testDb.invitation.findUniqueOrThrow({ where: { id: shown.invitation.id } })).linkShownAt).not.toBeNull();
  });
});

describe('routes 44 to 46: first-owner invitations', () => {
  it('FR-ORG-02: a resend refuses the old link and the new one works; a revoked link is refused', async () => {
    const org = await created();
    const invitee = await account(org.invitation.email);
    const r = await post45(org.orgId, org.invitation.id, { showLink: true });
    expect(r.status).toBe(201);
    const resent = await r.json() as { invitation: { id: string; state: string }; acceptUrl: string | null; emailSent: boolean };
    expect(resent.invitation.state).toBe('pending');
    expect((await testDb.invitation.findUniqueOrThrow({ where: { id: org.invitation.id } })).status).toBe('revoked');
    await expect(acceptInvitationViaDefiner({ tokenHash: hashInvitationToken(org.token), userId: invitee })).rejects.toMatchObject({ code: 'invitation_unusable' });
    expect((await post46(org.orgId, resent.invitation.id)).status).toBe(204);
    await expect(acceptInvitationViaDefiner({ tokenHash: hashInvitationToken(tokenOf(resent.acceptUrl)), userId: invitee })).rejects.toMatchObject({ code: 'invitation_unusable' });
    const again = await post46(org.orgId, resent.invitation.id);
    expect({ status: again.status, code: (await again.json()).code }).toEqual({ status: 409, code: 'invitation_not_pending' });
  });

  it('FR-ORG-02: a resend or revoke of an expired first-owner invitation answers 409 invitation_not_pending', async () => {
    const org = await created();
    await testDb.invitation.update({ where: { id: org.invitation.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    for (const r of [await post45(org.orgId, org.invitation.id, { showLink: false }), await post46(org.orgId, org.invitation.id)])
      expect({ status: r.status, code: (await r.json()).code }).toEqual({ status: 409, code: 'invitation_not_pending' });
  });

  it('FR-ORG-02: after an expired first-owner invitation, a new one with a request reference works and S-30 lists it', async () => {
    const org = await created();
    await testDb.invitation.update({ where: { id: org.invitation.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const r = await post44(org.orgId, { email: 'new-owner@fixture.test', requestReference: 'CTRL-2026-11', showLink: true });
    expect(r.status).toBe(201);
    const issued = await r.json() as { invitation: { email: string; kind: string; state: string }; acceptUrl: string | null };
    expect(issued.invitation).toMatchObject({ email: 'new-owner@fixture.test', kind: 'first_owner', state: 'pending' });
    const owner = await account('new-owner@fixture.test');
    await expect(acceptInvitationViaDefiner({ tokenHash: hashInvitationToken(tokenOf(issued.acceptUrl)), userId: owner })).resolves.toMatchObject({ orgId: org.orgId, role: 'owner' });
    const page = await listOrganisationEvents(createOrgContext(org.orgId, 'owner'), { limit: 50 });
    expect(page.events.some((e) => e.action === 'owner_invitation_issued' && e.requestReference === 'CTRL-2026-11')).toBe(true);
  });

  it('FR-ORG-02: an organisation with an active owner refuses a new first-owner invitation with 409, and a pending one too', async () => {
    const r = await post44(fx.org.id, { email: 'x@fixture.test', requestReference: 'R-1', showLink: false });
    expect({ status: r.status, code: (await r.json()).code }).toEqual({ status: 409, code: 'active_owner_exists' });
    const org = await created();
    const p = await post44(org.orgId, { email: 'y@fixture.test', requestReference: 'R-2', showLink: false });
    expect({ status: p.status, code: (await p.json()).code }).toEqual({ status: 409, code: 'pending_owner_invitation_exists' });
  });

  it('FR-ORG-02 FR-ORG-03: an invitation of another organisation, a member invitation or an unknown id answers 404 and changes nothing', async () => {
    const a = await created();
    const b = await created();
    const member = await testDb.invitation.create({ data: {
      orgId: fx.org.id, email: 'member@fixture.test', role: 'viewer', kind: 'member', tokenHash: sha256(randomUUID()), invitedById: fx.members.owner.userId,
      expiresAt: new Date(Date.now() + 86_400_000),
    } });
    const before = await rowCounts();
    for (const [orgId, invitationId] of [[a.orgId, b.invitation.id], [fx.org.id, member.id], [a.orgId, randomUUID()], [randomUUID(), a.invitation.id]]) {
      const resend = await post45(orgId, invitationId, { showLink: false });
      expect({ status: resend.status, code: (await resend.json()).code }).toEqual({ status: 404, code: 'not_found' });
      const revoke = await post46(orgId, invitationId);
      expect({ status: revoke.status, code: (await revoke.json()).code }).toEqual({ status: 404, code: 'not_found' });
    }
    expect(await rowCounts()).toEqual(before);
  });

  it('FR-ORG-02 FR-ORG-04 (C4 ORG-SF-5): routes 44 and 45 refuse an archived organisation with 409 organisation_archived and write nothing', async () => {
    const org = await created();
    await testDb.organization.update({ where: { id: org.orgId }, data: { deletedAt: new Date() } });
    const before = await rowCounts();
    const resend = await post45(org.orgId, org.invitation.id, { showLink: false });
    expect({ status: resend.status, code: (await resend.json()).code }).toEqual({ status: 409, code: 'organisation_archived' });
    await testDb.invitation.update({ where: { id: org.invitation.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const issue = await post44(org.orgId, { email: 'z@fixture.test', requestReference: 'R-9', showLink: false });
    expect({ status: issue.status, code: (await issue.json()).code }).toEqual({ status: 409, code: 'organisation_archived' });
    expect(await rowCounts()).toEqual(before);
  });

  it('FR-ORG-02: route 44 and 45 validate their bodies (422)', async () => {
    const org = await created();
    await testDb.invitation.update({ where: { id: org.invitation.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    for (const [body, field] of [[{ email: 'bad', requestReference: 'R', showLink: false }, 'email'], [{ email: 'a@fixture.test', requestReference: '', showLink: false }, 'requestReference'],
      [{ email: 'a@fixture.test', requestReference: 'R'.repeat(201), showLink: false }, 'requestReference'], [{ email: 'a@fixture.test', requestReference: 'R' }, 'showLink']] as const) {
      const r = await post44(org.orgId, body);
      const b = await r.json();
      expect({ status: r.status, field: b.fields?.some((f: { field: string }) => f.field === field) }, JSON.stringify(body)).toEqual({ status: 422, field: true });
    }
    sessionAs(admin.userId);
    const noId = await callRoute(R45, 'POST', { slug: '', params: { orgId: org.orgId, invitationId: org.invitation.id }, body: { showLink: true } });
    expect(noId.status).toBe(422);
  });
});

describe('route 42 and the retired route 43: name correction', () => {
  it('FR-ORG-06: an organisation with no agreement keeps working, and nothing serves route 43 any more', async () => {
    const fx2 = await buildOrg({ label: 'no-agreement', withAgreement: false });
    expect((await listOrganisationsForAdmin()).find((r) => r.orgId === fx2.org.id)!.legalName).toBeNull();
    const file = 'app/api/v1/orgs/[slug]/projects/[id]/decisions/route.ts';
    sessionAs(fx2.members.assessor.userId);
    const ids = await idsOf(fx2, file);
    const saved = await callRoute(file, 'POST', { slug: fx2.org.slug, params: ids, ...validRequestFor(file, 'POST', ids) });
    expect([200, 201]).toContain(saved.status);
    // Route 43 (POST .../agreements) is gone: no module to serve it and no authorisation entry, so Next answers 404.
    expect(existsSync(R43_GONE)).toBe(false);
    expect(Object.keys(ROUTE_ACTIONS)).not.toContain(R43_GONE);
  });

  it('FR-ORG-10 (C4 ORG-SF-4): correcting a name to the name it already has answers 200 and writes nothing', async () => {
    const before = await rowCounts();
    const r = await patch42(fx.org.id, { name: fx.org.name });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ previousName: fx.org.name });
    expect(await rowCounts()).toEqual(before);
  });

  it('FR-ORG-10: a name correction keeps the earlier name in a row and leaves issued bytes unchanged', async () => {
    const project = await addProject(fx);
    const review = await addStageReview(fx, project.id, { stage: 'pre-processing' });
    const seal = await addSealRow(fx, review.id);
    const doc = await addIssuedDocument(fx, review.id, { documentType: 'data_card', sealIds: [seal.id], pdf: Buffer.from(`%PDF ${fx.org.name} %EOF`) });
    const r = await patch42(fx.org.id, { name: 'Corrected Lab' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ previousName: fx.org.name });
    expect((await testDb.organization.findUniqueOrThrow({ where: { id: fx.org.id } })).name).toBe('Corrected Lab');
    const stored = await testDb.issuedDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(sha256(Buffer.from(stored.pdf!))).toBe(doc.sha256);
    expect(Buffer.from(stored.pdf!).toString()).toContain(fx.org.name);
    expect(await lastEvent(fx.org.id)).toMatchObject({ action: 'organisation_name_corrected', previousValue: fx.org.name, actorRole: 'platform_admin' });
    expect((await patch42(fx.org.id, { name: '' })).status).toBe(422);
    expect((await patch42(randomUUID(), { name: 'Nowhere' })).status).toBe(404);
  });
});

describe('routes 41 and 45: retry-safe by request id (NFR-INT-02, owner answer A1)', () => {
  const receipts = (orgId: string) => testDb.requestReceipt.count({ where: { orgId } });
  const events = (orgId: string, action: string) => testDb.organisationEvent.count({ where: { orgId, action } });
  /** A receipt as another writer would have left it, written as the table owner (RLS does not bind it). */
  const seedReceipt = (orgId: string, requestId: string, digest: string, actorUserId: string, route: string) => testDb.requestReceipt.create({
    data: { orgId, requestId, requestDigest: digest, actorUserId, route },
  });
  /**
   * Holds the receipt's advisory lock (idempotentWrite's key) on a connection of its own, starts the requests, waits
   * until each of them is blocked on that lock in the database, then lets them go: the two calls overlap for certain.
   */
  async function whileLockHeld(orgId: string, requestId: string, start: () => Promise<Response>[]): Promise<Response[]> {
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    const key = `${orgId}:${requestId.toLowerCase()}`;
    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
      const pending = start();
      const deadline = Date.now() + 4_000;   // under the 5 s test timeout, so a missing lock fails with this message
      for (;;) {
        const { rows } = await holder.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
             AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`, [key]);
        if (rows[0].n >= pending.length) break;
        if (Date.now() > deadline) throw new Error(`whileLockHeld: only ${rows[0].n} of ${pending.length} requests reached the lock`);
        await new Promise((r) => setTimeout(r, 50));
      }
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
      return await Promise.all(pending);
    } finally {
      await holder.end();
    }
  }

  const orgsNamed = (name: string) => testDb.organization.count({ where: { name } });
  const R41_KEY = 'app/api/admin/organisations/route.ts::POST';

  it('NFR-INT-02 FR-ORG-01: a replay of route 41 answers the first organisation and invitation, with no link, and writes one organisation', async () => {
    const requestId = randomUUID();
    const body = valid({ requestId, showLink: true });
    const first = await post41(body);
    expect(first.status).toBe(201);
    const a = await first.json() as CreateOrganisationResponse;
    expect(a.orgId).toBe(organisationIdFor(admin.userId, requestId));
    const again = await post41(body);
    expect(again.status).toBe(200);
    const b = await again.json() as CreateOrganisationResponse;
    expect(b).toMatchObject({ orgId: a.orgId, slug: a.slug, invitation: { id: a.invitation.id, state: 'pending' }, acceptUrl: null, emailSent: false });
    expect(await orgsNamed(body.name)).toBe(1);
    expect(await receipts(a.orgId)).toBe(1);
    expect(await events(a.orgId, 'organisation_created')).toBe(1);
  });

  it('NFR-INT-02: route 41 with a used request id and a changed body answers 409 request_id_reused and writes nothing', async () => {
    const requestId = randomUUID();
    expect((await post41(valid({ requestId }))).status).toBe(201);
    const before = await rowCounts();
    const r = await post41(valid({ requestId }));   // another name and owner under the same id
    expect({ status: r.status, code: (await r.json()).code }).toEqual({ status: 409, code: 'request_id_reused' });
    expect(await rowCounts()).toEqual(before);
  });

  it('NFR-INT-02: a double submit of route 41 held at the receipt lock writes one organisation', async () => {
    const requestId = randomUUID();
    const body = valid({ requestId });
    const orgId = organisationIdFor(admin.userId, requestId);
    const [a, b] = await whileLockHeld(orgId, requestId, () => [post41(body), post41(body)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((await a.json()).orgId).toBe((await b.json()).orgId);
    expect(await orgsNamed(body.name)).toBe(1);
    expect(await receipts(orgId)).toBe(1);
  });

  it('NFR-INT-02: route 41 answers 409 request_id_reused when its derived organisation id already exists, and writes nothing', async () => {
    const taken = randomUUID();
    await testDb.organization.create({ data: { id: organisationIdFor(admin.userId, taken), name: `Taken ${taken.slice(0, 6)}`, slug: `taken-${taken.slice(0, 8)}` } });
    const before = await rowCounts();
    const r = await post41(valid({ requestId: taken }));
    expect({ status: r.status, code: (await r.json()).code }).toEqual({ status: 409, code: 'request_id_reused' });
    expect(await rowCounts()).toEqual(before);
  });

  it('NFR-INT-02 (C4 SEC-1, ORG-SF-3, re-review F1): a route 41 receipt of another actor or another route, under the same request id and the same digest, answers 409 and nothing is written', async () => {
    /** An organisation at the derived id with a receipt carrying the digest of exactly the body the test posts. */
    const plant = async (actor: string, route: string) => {
      const requestId = randomUUID();
      const orgId = organisationIdFor(admin.userId, requestId);
      const body = valid({ requestId });
      await testDb.organization.create({ data: { id: orgId, name: `Seeded ${requestId.slice(0, 6)}`, slug: `seeded-${requestId.slice(0, 8)}` } });
      const invitation = await testDb.invitation.create({ data: {
        orgId, email: body.ownerEmail, role: 'owner', kind: 'first_owner', tokenHash: sha256(randomUUID()), invitedById: admin.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      } });
      const parsed = { requestId, name: body.name, legalName: body.legalName, ownerEmail: body.ownerEmail, showLink: body.showLink };
      await testDb.requestReceipt.create({ data: { orgId, requestId, requestDigest: requestDigest({ path: {}, body: parsed }), actorUserId: actor, route, rowId: invitation.id } });
      return { body, orgId, invitationId: invitation.id };
    };
    // Positive control: the same actor, route and digest replays, so the digest planted is the one the route computes.
    const control = await plant(admin.userId, R41_KEY);
    const replay = await post41(control.body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ orgId: control.orgId, invitation: { id: control.invitationId }, acceptUrl: null, emailSent: false });
    const cases = [
      { name: 'another actor', ...(await plant(fx.members.owner.userId, R41_KEY)) },
      { name: 'another route', ...(await plant(admin.userId, 'app/api/v1/orgs/[slug]/members/route.ts::POST')) },
    ];
    const before = await rowCounts();
    for (const c of cases) {
      const r = await post41(c.body);
      expect({ case: c.name, status: r.status, code: (await r.json()).code }).toEqual({ case: c.name, status: 409, code: 'request_id_reused' });
    }
    expect(await rowCounts()).toEqual(before);
  });

  it('NFR-INT-02 (re-review N1): route 41 without a request id, or with one that is not a UUID, answers 422 on that field and writes nothing', async () => {
    const before = await rowCounts();
    sessionAs(admin.userId);
    for (const body of [valid(), valid({ requestId: 'not-a-uuid' })]) {
      const r = await callRoute(R41, 'POST', { slug: '', body });
      const b = await r.json();
      expect({ status: r.status, field: b.fields?.some((f: { field: string }) => f.field === 'requestId') }).toEqual({ status: 422, field: true });
    }
    expect(await rowCounts()).toEqual(before);
  });

  it('NFR-INT-02: the organisation id is derived from the actor and the request id, so two actors never collide on one request id', async () => {
    const requestId = randomUUID();
    const other = randomUUID();
    expect(organisationIdFor(admin.userId, requestId)).toBe(organisationIdFor(admin.userId, requestId));
    expect(organisationIdFor(admin.userId, requestId)).not.toBe(organisationIdFor(other, requestId));
    expect(organisationIdFor(admin.userId, requestId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const first = await post41(valid({ requestId }));
    expect(first.status).toBe(201);
    // The one administrator hands over (NFR-SEC-19): demoted, and a membership-free account takes the role.
    await testDb.user.update({ where: { id: admin.userId }, data: { role: 'assessor' } });
    const next = await buildPlatformAdmin();
    sessionAs(next.userId);
    const second = await callRoute(R41, 'POST', { slug: '', body: valid({ requestId }) });
    expect(second.status).toBe(201);
    expect((await second.json()).orgId).toBe(organisationIdFor(next.userId, requestId));
    expect((await first.json()).orgId).not.toBe(organisationIdFor(next.userId, requestId));
  });

  it('NFR-INT-02 FR-ORG-02: a replay of route 45 answers the first invitation, with no link, and writes one new invitation', async () => {
    const org = await created();
    const requestId = randomUUID();
    const first = await post45(org.orgId, org.invitation.id, { requestId, showLink: true });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { invitation: { id: string }; acceptUrl: string | null };
    expect(firstBody.acceptUrl).not.toBeNull();
    const again = await post45(org.orgId, org.invitation.id, { requestId, showLink: true });
    expect(again.status).toBe(200);
    const againBody = await again.json() as { invitation: { id: string; state: string }; acceptUrl: string | null; emailSent: boolean };
    expect(againBody).toMatchObject({ invitation: { id: firstBody.invitation.id, state: 'pending' }, acceptUrl: null, emailSent: false });
    expect(await testDb.invitation.count({ where: { orgId: org.orgId } })).toBe(2);
    expect(await events(org.orgId, 'owner_invitation_resent')).toBe(1);
  });

  it('NFR-INT-02: route 45 with a used request id and a changed body answers 409 request_id_reused and writes nothing', async () => {
    const org = await created();
    const requestId = randomUUID();
    expect((await post45(org.orgId, org.invitation.id, { requestId, showLink: true })).status).toBe(201);
    const before = await rowCounts();
    const r = await post45(org.orgId, org.invitation.id, { requestId, showLink: false });
    expect({ status: r.status, code: (await r.json()).code }).toEqual({ status: 409, code: 'request_id_reused' });
    expect(await rowCounts()).toEqual(before);
  });

  it('NFR-INT-02: a double submit of route 45 held at the receipt lock writes one new invitation', async () => {
    const org = await created();
    const body = { requestId: randomUUID(), showLink: false };
    const [a, b] = await whileLockHeld(org.orgId, body.requestId, () => [post45(org.orgId, org.invitation.id, body), post45(org.orgId, org.invitation.id, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((await a.json()).invitation.id).toBe((await b.json()).invitation.id);
    expect(await testDb.invitation.count({ where: { orgId: org.orgId } })).toBe(2);
    expect(await events(org.orgId, 'owner_invitation_resent')).toBe(1);
    // The organisation's own route 41 receipt is the other one.
    expect(await testDb.requestReceipt.count({ where: { orgId: org.orgId, route: { not: R41_KEY } } })).toBe(1);
  });

  it('NFR-INT-02 (C4 SEC-1, ORG-SF-3): a receipt of another actor or another route under the same request id and digest answers 409 on route 45, and nothing is written', async () => {
    const org = await created();
    const MEMBER_ROUTE = 'app/api/v1/orgs/[slug]/members/route.ts::POST';
    const R45_KEY = 'app/api/admin/organisations/[orgId]/owner-invitations/[invitationId]/resend/route.ts::POST';
    const cases: Array<{ name: string; actor: string; route45: string }> = [
      { name: 'another actor', actor: fx.members.owner.userId, route45: R45_KEY },
      { name: 'another route', actor: admin.userId, route45: MEMBER_ROUTE },
    ];
    for (const c of cases) {
      const id45 = randomUUID();
      const body45 = { requestId: id45, showLink: false };
      await seedReceipt(org.orgId, id45, requestDigest({ path: { orgId: org.orgId, invitationId: org.invitation.id }, body: body45 }), c.actor, c.route45);
      const before = await rowCounts();
      const r45 = await post45(org.orgId, org.invitation.id, body45);
      expect({ case: c.name, status: r45.status, code: (await r45.json()).code }).toEqual({ case: c.name, status: 409, code: 'request_id_reused' });
      expect(await rowCounts(), c.name).toEqual(before);
    }
  });
});

describe('the administrator and the organisations', () => {
  it('FR-ORG-03: the administrator gets 404 on every organisation route', async () => {
    sessionAs(admin.userId);
    for (const [file, methods] of Object.entries(ROUTE_ACTIONS)) {
      for (const m of Object.keys(methods)) {
        const r = await callRoute(file, m as Method, { slug: fx.org.slug, params: await idsOf(fx, file), body: m === 'GET' ? undefined : {} });
        expect({ file, m, status: r.status }).toEqual({ file, m, status: 404 });
      }
    }
  });

  it('FR-ORG-09: each administrator route writes one row per affected organisation', async () => {
    const before = await testDb.organisationEvent.count();
    const org = await created();                                                   // organisation_created
    const resent = await (await post45(org.orgId, org.invitation.id, { showLink: false })).json();   // owner_invitation_resent
    expect((await post46(org.orgId, resent.invitation.id)).status).toBe(204);     // owner_invitation_revoked
    expect((await post44(org.orgId, { email: 'next@fixture.test', requestReference: 'CTRL-9', showLink: false })).status).toBe(201);   // owner_invitation_issued
    expect((await patch42(org.orgId, { name: 'Renamed Lab' })).status).toBe(200); // organisation_name_corrected
    expect((await patch42(org.orgId, { legalName: 'Renamed University' })).status).toBe(200); // organisation_legal_name_corrected
    // `at` is the database clock to the millisecond, so two routes answered in one millisecond tie and the order is not
    // the property here (one row per route is): compare the actions as a sorted multiset.
    const rows = await testDb.organisationEvent.findMany({ where: { orgId: org.orgId } });
    expect(rows.map((e) => e.action).sort()).toEqual(['organisation_created', 'owner_invitation_resent', 'owner_invitation_revoked', 'owner_invitation_issued', 'organisation_name_corrected', 'organisation_legal_name_corrected'].sort());
    expect(rows.every((e) => e.actorRole === 'platform_admin' && e.actorId === admin.userId)).toBe(true);
    expect(await testDb.organisationEvent.count()).toBe(before + 6);
  });

  it('NFR-OBS-01: administrator actions log ids only', async () => {
    const ownerEmail = `${markerFor('ownerEmail', 1)}@fixture.test`;
    const name = `Lab ${markerFor('orgName', 1)}`;
    const { lines } = await captureLogs(async () => {
      const r = await post41(valid({ name, ownerEmail, showLink: true }));
      const org = await r.json() as CreateOrganisationResponse;
      const resent = await (await post45(org.orgId, org.invitation.id, { showLink: true })).json();
      await post46(org.orgId, resent.invitation.id);
      await post44(org.orgId, { email: `${markerFor('issueEmail', 2)}@fixture.test`, requestReference: markerFor('reference', 3), showLink: true });
      await patch42(org.orgId, { name: `Renamed ${markerFor('orgName', 4)}` });
      await patch42(org.orgId, { legalName: `Legal ${markerFor('orgName', 5)}` });
    });
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
    expect(lines.filter((l) => l.includes('ADMIN_ACTION')).length).toBeGreaterThanOrEqual(6);
  });
});
