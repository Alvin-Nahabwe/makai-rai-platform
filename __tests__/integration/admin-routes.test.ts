import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
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
import type { CreateOrganisationResponse, AgreementInput } from '../../types/api';

/**
 * Routes 41 to 46, the MAK-AI administrator's organisation actions (FR-ORG-01, 02, 03, 05, 06, 09, 10; contract
 * "Routes" rows 41 to 46). Driven through the real handlers with AUTHZ's route driver; only the session is mocked.
 * Every write goes through a definer function, which writes its FR-ORG-09 row in the same transaction.
 */

const R41 = 'app/api/admin/organisations/route.ts';
const R42 = 'app/api/admin/organisations/[orgId]/route.ts';
const R43 = 'app/api/admin/organisations/[orgId]/agreements/route.ts';
const R44 = 'app/api/admin/organisations/[orgId]/owner-invitations/route.ts';
const R45 = 'app/api/admin/organisations/[orgId]/owner-invitations/[invitationId]/resend/route.ts';
const R46 = 'app/api/admin/organisations/[orgId]/owner-invitations/[invitationId]/revoke/route.ts';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
/** The stub organisation agreement every test file's registry serves (__tests__/setup/legal.ts). */
const AGREEMENT_INPUT: AgreementInput = {
  agreementVersion: '1', textHash: sha256('Stub organisation-agreement v1 for tests only.'), acceptedOn: '2026-10-30',
  controllerLegalName: 'Makerere University', dpContactEmail: 'dpo@fixture.test',
};

let admin: FixtureAccount;
let fx: OrgFixture;

const post41 = (body: unknown) => { sessionAs(admin.userId); return callRoute(R41, 'POST', { slug: '', body }); };
const patch42 = (orgId: string, body: unknown) => { sessionAs(admin.userId); return callRoute(R42, 'PATCH', { slug: '', params: { orgId }, body }); };
const post43 = (orgId: string, body: object) => {
  sessionAs(admin.userId);
  return callRoute(R43, 'POST', { slug: '', params: { orgId }, body: { requestId: randomUUID(), ...body } });
};
const post44 = (orgId: string, body: unknown) => { sessionAs(admin.userId); return callRoute(R44, 'POST', { slug: '', params: { orgId }, body }); };
const post45 = (orgId: string, invitationId: string, body: Record<string, unknown>) => {
  sessionAs(admin.userId);
  return callRoute(R45, 'POST', { slug: '', params: { orgId, invitationId }, body: { requestId: randomUUID(), ...body } });
};
const post46 = (orgId: string, invitationId: string) => { sessionAs(admin.userId); return callRoute(R46, 'POST', { slug: '', params: { orgId, invitationId } }); };

const valid = (over: Record<string, unknown> = {}) => ({
  name: `Makerere CAI Lab ${randomUUID().slice(0, 6)}`, agreement: AGREEMENT_INPUT, ownerEmail: `head-${randomUUID().slice(0, 6)}@fixture.test`, showLink: false, ...over,
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
  it('FR-ORG-01: S-24 with all fields creates one organisation, one agreement and one pending owner invitation', async () => {
    const body = valid({ name: 'Makerere CAI Lab', showLink: true });
    const r = await post41(body);
    expect(r.status).toBe(201);
    const b = await r.json() as CreateOrganisationResponse;
    expect(await counts(b.orgId)).toEqual({ organizations: 1, organization_agreements: 1, invitations: 1 });
    expect(b.slug).toBe('makerere-cai-lab');
    expect(b.invitation).toMatchObject({ kind: 'first_owner', state: 'pending', role: 'owner', linkShown: true, email: body.ownerEmail });
    expect(Object.keys(b).sort()).toEqual(['acceptUrl', 'emailSent', 'invitation', 'orgId', 'slug']);
    expect(b.emailSent).toBe(false);   // no sender configured in the test environment: still 201, with the link
    expect(b.acceptUrl).toMatch(/^https:\/\/vitest\.example\.invalid\/invitations\/[0-9a-f]{64}$/);
    const inv = await testDb.invitation.findUniqueOrThrow({ where: { id: b.invitation.id } });
    expect(inv.tokenHash).toBe(hashInvitationToken(tokenOf(b.acceptUrl)));
    const days = (inv.expiresAt.getTime() - inv.createdAt.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99); expect(days).toBeLessThan(7.01);
    const agreement = await testDb.organisationAgreement.findFirstOrThrow({ where: { orgId: b.orgId } });
    expect(agreement).toMatchObject({ agreementVersion: '1', textHash: AGREEMENT_INPUT.textHash, controllerLegalName: 'Makerere University', recordedById: admin.userId });
  });

  it('FR-ORG-01: when the invitation insert is forced to fail, no organisation and no agreement exist', async () => {
    const fn = `org_test_fail_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const agreements = await testDb.organisationAgreement.count();
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
    expect(await testDb.organisationAgreement.count()).toBe(agreements);
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
    for (const [file, method, params] of [[R42, 'PATCH', { orgId: fx.org.id }], [R43, 'POST', { orgId: fx.org.id }], [R44, 'POST', { orgId: fx.org.id }],
      [R45, 'POST', { orgId: fx.org.id, invitationId: randomUUID() }], [R46, 'POST', { orgId: fx.org.id, invitationId: randomUUID() }]] as const) {
      expect((await callRoute(file, method as Method, { slug: '', params, body: {} })).status, file).toBe(403);
    }
    sessionAs(null);
    expect((await callRoute(R41, 'POST', { slug: '', body: valid() })).status).toBe(401);
    expect(await rowCounts()).toEqual(before);
  });

  it('FR-ORG-01: the create form validates every field and refuses an accepted date in the future (422, nothing written)', async () => {
    const before = await rowCounts();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ name: '' }, 'name'],
      [{ name: 'x'.repeat(101) }, 'name'],
      [{ ownerEmail: 'not-an-address' }, 'ownerEmail'],
      [{ showLink: 'yes' }, 'showLink'],
      [{ agreement: { ...AGREEMENT_INPUT, acceptedOn: '2999-01-01' } }, 'agreement.acceptedOn'],
      [{ agreement: { ...AGREEMENT_INPUT, acceptedOn: '2026-02-30' } }, 'agreement.acceptedOn'],
      [{ agreement: { ...AGREEMENT_INPUT, agreementVersion: '9' } }, 'agreement.agreementVersion'],
      [{ agreement: { ...AGREEMENT_INPUT, textHash: sha256('another text') } }, 'agreement.textHash'],
      [{ agreement: { ...AGREEMENT_INPUT, controllerLegalName: ' ' } }, 'agreement.controllerLegalName'],
      [{ agreement: { ...AGREEMENT_INPUT, dpContactEmail: 'nope' } }, 'agreement.dpContactEmail'],
      [{ agreement: null }, 'agreement'],
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

describe('routes 42 and 43: name correction and agreements', () => {
  it('FR-ORG-06: an organisation with no agreement keeps working until one is recorded', async () => {
    const fx2 = await buildOrg({ label: 'no-agreement', withAgreement: false });
    expect((await listOrganisationsForAdmin()).find((r) => r.orgId === fx2.org.id)!.currentAgreementVersion).toBeNull();
    const file = 'app/api/v1/orgs/[slug]/projects/[id]/decisions/route.ts';
    sessionAs(fx2.members.assessor.userId);
    const ids = await idsOf(fx2, file);
    const saved = await callRoute(file, 'POST', { slug: fx2.org.slug, params: ids, ...validRequestFor(file, 'POST', ids) });
    expect([200, 201]).toContain(saved.status);
    const r = await post43(fx2.org.id, AGREEMENT_INPUT);
    expect(r.status).toBe(201);
    const view = await r.json();
    expect(view).toMatchObject({ agreementVersion: '1', acceptedOn: '2026-10-30', controllerLegalName: 'Makerere University', dpContactEmail: 'dpo@fixture.test', textHash: AGREEMENT_INPUT.textHash });
    expect(Object.keys(view).sort()).toEqual(['acceptedOn', 'agreementVersion', 'controllerLegalName', 'dpContactEmail', 'id', 'recordedAt', 'textHash']);
    expect((await listOrganisationsForAdmin()).find((r) => r.orgId === fx2.org.id)!.currentAgreementVersion).toBe('1');
    const bad = await post43(fx2.org.id, { ...AGREEMENT_INPUT, agreementVersion: '7' });
    expect(bad.status).toBe(422);
    expect((await post43(randomUUID(), AGREEMENT_INPUT)).status).toBe(404);
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

describe('routes 43 and 45: retry-safe by request id (NFR-INT-02, owner answer A1)', () => {
  const agreementCount = (orgId: string) => testDb.organisationAgreement.count({ where: { orgId } });
  const receipts = (orgId: string) => testDb.requestReceipt.count({ where: { orgId } });
  const events = (orgId: string, action: string) => testDb.organisationEvent.count({ where: { orgId, action } });

  it('NFR-INT-02 FR-ORG-05: a replay of route 43 answers the first agreement and writes one row', async () => {
    const body = { ...AGREEMENT_INPUT, requestId: randomUUID() };
    const before = await agreementCount(fx.org.id);
    const first = await post43(fx.org.id, body);
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const again = await post43(fx.org.id, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(firstBody);
    expect(await agreementCount(fx.org.id)).toBe(before + 1);
    expect(await events(fx.org.id, 'agreement_recorded')).toBe(1);
    expect(await receipts(fx.org.id)).toBe(1);
  });

  it('NFR-INT-02: route 43 with a used request id and a changed body answers 409 request_id_reused and writes nothing', async () => {
    const requestId = randomUUID();
    expect((await post43(fx.org.id, { ...AGREEMENT_INPUT, requestId })).status).toBe(201);
    const before = await rowCounts();
    const r = await post43(fx.org.id, { ...AGREEMENT_INPUT, controllerLegalName: 'Another Controller', requestId });
    expect({ status: r.status, code: (await r.json()).code }).toEqual({ status: 409, code: 'request_id_reused' });
    expect(await rowCounts()).toEqual(before);
  });

  it('NFR-INT-02: a double submit of route 43 at the same moment writes one agreement', async () => {
    const body = { ...AGREEMENT_INPUT, requestId: randomUUID() };
    const before = await agreementCount(fx.org.id);
    const [a, b] = await Promise.all([post43(fx.org.id, body), post43(fx.org.id, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((await a.json()).id).toBe((await b.json()).id);
    expect(await agreementCount(fx.org.id)).toBe(before + 1);
    expect(await receipts(fx.org.id)).toBe(1);
  });

  it('NFR-INT-02: route 43 without a request id answers 422 on that field', async () => {
    sessionAs(admin.userId);
    const r = await callRoute(R43, 'POST', { slug: '', params: { orgId: fx.org.id }, body: AGREEMENT_INPUT });
    const b = await r.json();
    expect({ status: r.status, field: b.fields?.some((f: { field: string }) => f.field === 'requestId') }).toEqual({ status: 422, field: true });
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

  it('NFR-INT-02: a double submit of route 45 at the same moment writes one new invitation', async () => {
    const org = await created();
    const body = { requestId: randomUUID(), showLink: false };
    const [a, b] = await Promise.all([post45(org.orgId, org.invitation.id, body), post45(org.orgId, org.invitation.id, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((await a.json()).invitation.id).toBe((await b.json()).invitation.id);
    expect(await testDb.invitation.count({ where: { orgId: org.orgId } })).toBe(2);
    expect(await events(org.orgId, 'owner_invitation_resent')).toBe(1);
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
    expect((await post43(org.orgId, AGREEMENT_INPUT)).status).toBe(201);          // agreement_recorded
    const resent = await (await post45(org.orgId, org.invitation.id, { showLink: false })).json();   // owner_invitation_resent
    expect((await post46(org.orgId, resent.invitation.id)).status).toBe(204);     // owner_invitation_revoked
    expect((await post44(org.orgId, { email: 'next@fixture.test', requestReference: 'CTRL-9', showLink: false })).status).toBe(201);   // owner_invitation_issued
    expect((await patch42(org.orgId, { name: 'Renamed Lab' })).status).toBe(200); // organisation_name_corrected
    const rows = await testDb.organisationEvent.findMany({ where: { orgId: org.orgId }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    expect(rows.map((e) => e.action)).toEqual(['organisation_created', 'agreement_recorded', 'owner_invitation_resent', 'owner_invitation_revoked', 'owner_invitation_issued', 'organisation_name_corrected']);
    expect(rows.every((e) => e.actorRole === 'platform_admin' && e.actorId === admin.userId)).toBe(true);
    expect(await testDb.organisationEvent.count()).toBe(before + 6);
  });

  it('NFR-OBS-01: administrator actions log ids only', async () => {
    const ownerEmail = `${markerFor('ownerEmail', 1)}@fixture.test`;
    const name = `Lab ${markerFor('orgName', 1)}`;
    const { lines } = await captureLogs(async () => {
      const r = await post41(valid({ name, ownerEmail, showLink: true }));
      const org = await r.json() as CreateOrganisationResponse;
      await post43(org.orgId, AGREEMENT_INPUT);
      const resent = await (await post45(org.orgId, org.invitation.id, { showLink: true })).json();
      await post46(org.orgId, resent.invitation.id);
      await post44(org.orgId, { email: `${markerFor('issueEmail', 2)}@fixture.test`, requestReference: markerFor('reference', 3), showLink: true });
      await patch42(org.orgId, { name: `Renamed ${markerFor('orgName', 4)}` });
    });
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
    expect(lines.filter((l) => l.includes('ADMIN_ACTION')).length).toBeGreaterThanOrEqual(6);
  });
});
