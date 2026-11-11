import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { testDb, resetDb } from '../helpers/db';
import { addProject, buildOrg, buildPlatformAdmin, type FixtureAccount, type OrgFixture } from '../helpers/recordFixture';
import { callRoute, idsOf, rowCounts, sessionAs, validRequestFor } from '../helpers/routeDriver';
import { acceptInvitationViaDefiner, adminCorrectOrgLegalName, adminCreateOrganisation } from '../../lib/data/definer';
import { hashInvitationToken } from '../../lib/data/invitationToken';
import { listOrganisationsForAdmin, organisationForAdmin } from '../../lib/data/admin';
import type { CreateOrganisationResponse } from '../../types/api';

/**
 * v0.6.1, Task 1: the institution's legal name is a column of `organizations`, not a field of an agreement record.
 * Route 41 creates an organisation with it and no agreement; route 42 corrects the name or the legal name through a
 * definer function that keeps the earlier value in an `organisation_events` row. The migration is expand-only: the
 * old 15-argument create function still runs, and nothing is revoked.
 *
 * Obligations (ecc:security-review): S1 only the platform administrator creates or corrects; S2 a correction
 * touches one organisation; S3 no application role updates "legalName"; S4 the earlier value is never lost; S5 the
 * 401 and same-origin paths are unchanged (authz-same-origin.test.ts); S6 input is an allow-list with length limits.
 */

const R41 = 'app/api/admin/organisations/route.ts';
const R42 = 'app/api/admin/organisations/[orgId]/route.ts';
const MIGRATION = path.join(process.cwd(), 'prisma/migrations/20261112000000_v061_organisation_legal_name/migration.sql');

let admin: FixtureAccount;
let fx: OrgFixture;
let su: Client;

const hex = (seed: string) => createHash('sha256').update(seed).digest('hex');
const q = async (sql: string, params: unknown[] = []) => (await su.query(sql, params)).rows;
const post41 = (body: object) => { sessionAs(admin.userId); return callRoute(R41, 'POST', { slug: '', body: { requestId: randomUUID(), ...body } }); };
const patch42 = (orgId: string, body: unknown) => { sessionAs(admin.userId); return callRoute(R42, 'PATCH', { slug: '', params: { orgId }, body }); };
const valid = (over: Record<string, unknown> = {}) => ({
  name: `Legal Lab ${randomUUID().slice(0, 6)}`, legalName: 'Makerere University', ownerEmail: `head-${randomUUID().slice(0, 6)}@fixture.test`, showLink: false, ...over,
});
const lastEvent = (orgId: string) => testDb.organisationEvent.findFirstOrThrow({ where: { orgId }, orderBy: [{ at: 'desc' }, { id: 'desc' }] });
const in7days = () => new Date(Date.now() + 7 * 86_400_000);
const keyed = () => ({ requestId: randomUUID(), digest: randomUUID() });
const fieldsOf = async (r: Response) => ((await r.json()).fields ?? []) as Array<{ field: string; message: string }>;

/** A client of one lane (`makrai_app` or `makrai_identity`), with the organisation context a request would set. */
async function asLane<T>(url: string | undefined, orgId: string | null, run: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    if (orgId !== null) await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
    try { return await run(c); } finally { await c.query('ROLLBACK'); }
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  su = new Client({ connectionString: process.env.DATABASE_URL });
  await su.connect();
});
afterAll(async () => { await su.end(); });
beforeEach(async () => {
  await resetDb();
  admin = await buildPlatformAdmin();
  fx = await buildOrg({ label: 'legal-name' });
});

describe('route 41: create with a legal name and no agreement', () => {
  it('FR-ORG-01: creating an organisation writes its name and legal name, its first-owner invitation and organisation_created, and no agreement record', async () => {
    const body = valid({ name: 'Legal Name Lab', legalName: '  Makerere University  ', showLink: true });
    const r = await post41(body);
    expect(r.status).toBe(201);
    const b = await r.json() as CreateOrganisationResponse;
    expect(await testDb.organization.findUniqueOrThrow({ where: { id: b.orgId } })).toMatchObject({ name: 'Legal Name Lab', legalName: 'Makerere University' });
    expect(await testDb.organisationAgreement.count({ where: { orgId: b.orgId } })).toBe(0);
    expect(await testDb.invitation.count({ where: { orgId: b.orgId, kind: 'first_owner', status: 'pending' } })).toBe(1);
    expect((await testDb.organisationEvent.findMany({ where: { orgId: b.orgId } })).map((e) => e.action)).toEqual(['organisation_created']);
    // An `agreement` key in the body is ignored, not refused and not stored.
    const ignored = await post41(valid({ agreement: { agreementVersion: '1', controllerLegalName: 'Other' } }));
    expect(ignored.status).toBe(201);
    expect(await testDb.organisationAgreement.count()).toBe(1);   // the fixture organisation's own record only
  });

  it('FR-ORG-01: a create without a legal name answers 422 on legalName and creates nothing', async () => {
    const before = await rowCounts();
    const cases: Array<Record<string, unknown>> = [
      { legalName: undefined }, { legalName: '' }, { legalName: '   ' }, { legalName: 42 }, { legalName: 'x'.repeat(201) },
    ];
    for (const over of cases) {
      const r = await post41(valid(over));
      expect({ over, status: r.status, field: (await fieldsOf(r)).some((f) => f.field === 'legalName') }).toEqual({ over, status: 422, field: true });
    }
    expect(await rowCounts()).toEqual(before);
    expect((await post41(valid({ legalName: 'x'.repeat(200) }))).status).toBe(201);   // 200 is allowed
  });

  it('FR-ORG-01: a replay with the same request id answers the first organisation; another body answers 409 request_id_reused', async () => {
    const requestId = randomUUID();
    const body = valid({ requestId, showLink: true });
    const first = await post41(body);
    expect(first.status).toBe(201);
    const a = await first.json() as CreateOrganisationResponse;
    const again = await post41(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ orgId: a.orgId, slug: a.slug, invitation: { id: a.invitation.id }, acceptUrl: null, emailSent: false });
    const before = await rowCounts();
    const other = await post41({ ...body, legalName: 'Another University' });
    expect({ status: other.status, code: (await other.json()).code }).toEqual({ status: 409, code: 'request_id_reused' });
    expect(await rowCounts()).toEqual(before);
    expect(await testDb.organization.count({ where: { id: a.orgId } })).toBe(1);
  });
});

describe('route 42: correct the name or the legal name', () => {
  it('FR-ORG-10: correcting the legal name keeps the earlier one in an organisation_legal_name_corrected row', async () => {
    const created = await (await post41(valid({ legalName: 'Old Legal Name' }))).json() as CreateOrganisationResponse;
    const r = await patch42(created.orgId, { legalName: '  New Legal Name ' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ previousLegalName: 'Old Legal Name' });
    expect((await testDb.organization.findUniqueOrThrow({ where: { id: created.orgId } })).legalName).toBe('New Legal Name');
    expect(await lastEvent(created.orgId)).toMatchObject({ action: 'organisation_legal_name_corrected', previousValue: 'Old Legal Name', actorRole: 'platform_admin', actorId: admin.userId });
    // An organisation with no legal name yet: the earlier value is null, and the row says so.
    const blank = await patch42(fx.org.id, { legalName: 'First Legal Name' });
    expect(await blank.json()).toEqual({ previousLegalName: null });
    expect(await lastEvent(fx.org.id)).toMatchObject({ action: 'organisation_legal_name_corrected', previousValue: null });
    expect((await patch42(randomUUID(), { legalName: 'Nowhere' })).status).toBe(404);
  });

  it('FR-ORG-10 (C4 ORG-SF-4): correcting the legal name to the value it already has answers 200 and writes nothing', async () => {
    await patch42(fx.org.id, { legalName: 'Same University' });
    const before = await rowCounts();
    const events = await testDb.organisationEvent.count({ where: { orgId: fx.org.id } });
    const r = await patch42(fx.org.id, { legalName: ' Same University ' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ previousLegalName: 'Same University' });
    expect(await rowCounts()).toEqual(before);
    expect(await testDb.organisationEvent.count({ where: { orgId: fx.org.id } })).toBe(events);
  });

  it('FR-ORG-10: a body with both name and legalName, or neither, answers 422 and writes nothing', async () => {
    const before = await rowCounts();
    const org = await testDb.organization.findUniqueOrThrow({ where: { id: fx.org.id } });
    for (const body of [{ name: 'A Name', legalName: 'A Legal Name' }, {}, { other: 'x' }, { legalName: ' ' }, { legalName: 'x'.repeat(201) }, { name: ' ' }, { legalName: 7 }]) {
      const r = await patch42(fx.org.id, body);
      expect({ body, status: r.status }).toEqual({ body, status: 422 });
    }
    const both = await patch42(fx.org.id, { name: 'A Name', legalName: 'A Legal Name' });
    expect((await fieldsOf(both)).map((f) => f.message)).toContain('Correct the name or the legal name, one at a time.');
    expect(await testDb.organization.findUniqueOrThrow({ where: { id: fx.org.id } })).toEqual(org);
    expect(await rowCounts()).toEqual(before);
    expect(await testDb.organisationEvent.count({ where: { orgId: fx.org.id, action: { in: ['organisation_name_corrected', 'organisation_legal_name_corrected'] } } })).toBe(0);
  });

  it('FR-ORG-10: a non-administrator gets 403 and the legal name is unchanged', async () => {
    await patch42(fx.org.id, { legalName: 'Kept University' });
    const before = await rowCounts();
    for (const userId of [fx.members.owner.userId, fx.members.admin.userId]) {
      sessionAs(userId);
      const r = await callRoute(R42, 'PATCH', { slug: '', params: { orgId: fx.org.id }, body: { legalName: 'Taken Over' } });
      expect({ status: r.status, code: (await r.json()).code }).toEqual({ status: 403, code: 'not_platform_admin' });
    }
    expect((await testDb.organization.findUniqueOrThrow({ where: { id: fx.org.id } })).legalName).toBe('Kept University');
    expect(await rowCounts()).toEqual(before);
    sessionAs(null);
    expect((await callRoute(R42, 'PATCH', { slug: '', params: { orgId: fx.org.id }, body: { legalName: 'Anon' } })).status).toBe(401);
  });

  it('FR-ORG-10: the definer functions refuse an actor who is not an active administrator, and write nothing', async () => {
    const assessor = fx.members.assessor.userId;
    const before = await rowCounts();
    await expect(adminCorrectOrgLegalName({ actorUserId: assessor, orgId: fx.org.id, legalName: 'Nope' })).rejects.toMatchObject({ status: 403, code: 'not_platform_admin' });
    await expect(adminCreateOrganisation({ ...keyed(), actorUserId: assessor, name: 'Never', slug: 'never-lg', legalName: 'Never Ltd', ownerEmail: 'n@fixture.test', tokenHash: hex('n'), expiresAt: in7days(), linkShown: false }))
      .rejects.toMatchObject({ status: 403, code: 'not_platform_admin' });
    await testDb.user.update({ where: { id: admin.userId }, data: { isActive: false } });
    await expect(adminCorrectOrgLegalName({ actorUserId: admin.userId, orgId: fx.org.id, legalName: 'Nope' })).rejects.toMatchObject({ status: 403, code: 'not_platform_admin' });
    expect(await rowCounts()).toEqual(before);
    expect((await testDb.organization.findUniqueOrThrow({ where: { id: fx.org.id } })).legalName).toBeNull();
  });

  it('FR-ORG-10: a correction touches only its own organisation and leaves the organisation context as it found it', async () => {
    const other = await buildOrg({ label: 'legal-name-other' });
    await adminCorrectOrgLegalName({ actorUserId: admin.userId, orgId: fx.org.id, legalName: 'Only Mine' });
    expect((await testDb.organization.findUniqueOrThrow({ where: { id: other.org.id } })).legalName).toBeNull();
    expect(await testDb.organisationEvent.count({ where: { orgId: other.org.id, action: 'organisation_legal_name_corrected' } })).toBe(0);
    expect(await testDb.organisationEvent.count({ where: { orgId: fx.org.id, action: 'organisation_legal_name_corrected' } })).toBe(1);
    await expect(adminCorrectOrgLegalName({ actorUserId: admin.userId, orgId: fx.org.id, legalName: '   ' })).rejects.toThrow(/legal name is required/);
    expect((await testDb.organization.findUniqueOrThrow({ where: { id: fx.org.id } })).legalName).toBe('Only Mine');
  });

  it('FR-ORG-10: the definer create function refuses a blank legal name and creates nothing', async () => {
    const before = await rowCounts();
    for (const legalName of ['', '   ']) {
      await expect(adminCreateOrganisation({ ...keyed(), actorUserId: admin.userId, name: 'Blank', slug: `blank-${randomUUID().slice(0, 6)}`, legalName,
        ownerEmail: 'b@fixture.test', tokenHash: hex(randomUUID()), expiresAt: in7days(), linkShown: false })).rejects.toThrow(/a legal name is required/);
    }
    expect(await rowCounts()).toEqual(before);
  });
});

describe('the database: the column, its grants, its policy and the expand-only overloads', () => {
  it('the identity and app lanes cannot UPDATE legalName', async () => {
    for (const [lane, url] of [['identity', process.env.IDENTITY_DATABASE_URL], ['app', process.env.APP_DATABASE_URL]] as const) {
      const e = await asLane(url, fx.org.id, (c) => c.query(`UPDATE organizations SET "legalName" = 'Forged' WHERE id = $1`, [fx.org.id]).then(() => null, (x: { code?: string }) => x));
      expect({ lane, code: e?.code }).toEqual({ lane, code: '42501' });
    }
    expect((await testDb.organization.findUniqueOrThrow({ where: { id: fx.org.id } })).legalName).toBeNull();
    const priv = (role: string, p: string) => q(`SELECT has_column_privilege($1, 'organizations', 'legalName', $2) AS ok`, [role, p]).then((r) => r[0].ok);
    expect({ definer: await priv('makrai_definer', 'UPDATE'), identity: await priv('makrai_identity', 'UPDATE'), app: await priv('makrai_app', 'UPDATE') })
      .toEqual({ definer: true, identity: false, app: false });
    expect(await priv('makrai_app', 'SELECT')).toBe(true);
  });

  it('the legalName CHECK admits null and 1 to 200 characters, and refuses blank and longer values', async () => {
    const insert = (legalName: string | null) => su.query(`INSERT INTO organizations (id, name, slug, "legalName", "updatedAt") VALUES ($1, 'c', $2, $3, now())`, [randomUUID(), `chk-${randomUUID()}`, legalName])
      .then(() => 'ok', (x: { constraint?: string }) => x.constraint ?? 'error');
    expect(await insert(null)).toBe('ok');
    expect(await insert('x'.repeat(200))).toBe('ok');
    expect(await insert('')).toBe('organizations_legalName_chk');
    expect(await insert('   ')).toBe('organizations_legalName_chk');
    expect(await insert('x'.repeat(201))).toBe('organizations_legalName_chk');
  });

  it('the new definer functions are owned by makrai_definer, pin search_path, and only makrai_identity executes them', async () => {
    const rows = await q(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, r.rolname AS owner, p.prosecdef AS definer, p.proconfig AS config,
        has_function_privilege('makrai_identity', p.oid, 'EXECUTE') AS identity, has_function_privilege('makrai_app', p.oid, 'EXECUTE') AS app,
        has_function_privilege('public', p.oid, 'EXECUTE') AS pub
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.proname = 'admin_correct_org_legal_name' OR (p.proname = 'admin_create_organisation' AND p.pronargs = 11)`);
    expect(rows.map((r) => r.proname).sort()).toEqual(['admin_correct_org_legal_name', 'admin_create_organisation']);
    for (const r of rows) {
      expect(r, r.proname).toMatchObject({ owner: 'makrai_definer', definer: true, config: ['search_path=pg_catalog, public, pg_temp'], identity: true, app: false, pub: false });
    }
  });

  it('organisation_events accepts organisation_legal_name_corrected and still every earlier action', async () => {
    const [{ def }] = await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'organisation_events_action_check'`);
    for (const a of ['organisation_created', 'agreement_recorded', 'owner_invitation_issued', 'owner_invitation_resent', 'owner_invitation_revoked', 'organisation_name_corrected',
      'account_deactivated', 'account_reactivated', 'member_invited', 'member_joined', 'member_role_changed', 'member_removed', 'member_left', 'organisation_legal_name_corrected']) {
      expect(def, a).toContain(`'${a}'`);
    }
  });

  it('the backfill copied the newest agreement\'s controller legal name', async () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const backfill = /UPDATE "organizations" o SET "legalName"[\s\S]*?;/.exec(sql)?.[0];
    expect(backfill, 'the migration holds the backfill statement').toBeDefined();
    const mk = async (label: string, names: Array<[string, string]>, legalName: string | null = null) => {
      const org = await buildOrg({ label, withAgreement: false });
      await testDb.organization.update({ where: { id: org.org.id }, data: { legalName } });
      for (const [recordedAt, controllerLegalName] of names) {
        await testDb.organisationAgreement.create({ data: { orgId: org.org.id, agreementVersion: '1', textHash: hex(randomUUID()), acceptedOn: new Date('2026-10-30T00:00:00Z'),
          controllerLegalName, dpContactEmail: 'dpo@fixture.test', recordedById: org.members.owner.userId, recordedAt: new Date(recordedAt) } });
      }
      return org.org.id;
    };
    const two = await mk('bf-two', [['2026-10-01T00:00:00Z', 'Older Name'], ['2026-11-01T00:00:00Z', 'Newer Name']]);
    const none = await mk('bf-none', []);
    const set = await mk('bf-set', [['2026-10-01T00:00:00Z', 'Agreement Name']], 'Already Set');
    const agreementsBefore = await testDb.organisationAgreement.count();
    await su.query(backfill!);
    const legal = async (id: string) => (await testDb.organization.findUniqueOrThrow({ where: { id } })).legalName;
    expect({ two: await legal(two), none: await legal(none), set: await legal(set) }).toEqual({ two: 'Newer Name', none: null, set: 'Already Set' });
    await su.query(backfill!);   // safe to repeat
    expect(await legal(two)).toBe('Newer Name');
    expect(await testDb.organisationAgreement.count()).toBe(agreementsBefore);   // it copies only
  });

  it('FR-ORG-06: an organisation with no agreement record keeps a null legal name and keeps working (owner invitation, members, projects)', async () => {
    const fx2 = await buildOrg({ label: 'no-agreement', withAgreement: false });
    expect((await listOrganisationsForAdmin()).find((r) => r.orgId === fx2.org.id)).toMatchObject({ legalName: null });
    expect((await organisationForAdmin(fx2.org.id)).row.legalName).toBeNull();
    await addProject(fx2);
    const file = 'app/api/v1/orgs/[slug]/projects/[id]/decisions/route.ts';
    sessionAs(fx2.members.assessor.userId);
    const ids = await idsOf(fx2, file);
    const saved = await callRoute(file, 'POST', { slug: fx2.org.slug, params: ids, ...validRequestFor(file, 'POST', ids) });
    expect([200, 201]).toContain(saved.status);
    // Members and a first-owner invitation: an organisation created without an agreement takes its owner as before.
    const created = await (await post41(valid({ showLink: true }))).json() as CreateOrganisationResponse;
    const owner = await testDb.user.create({ data: { email: created.invitation.email, name: 'Owner', passwordHash: 'x' } });
    const token = decodeURIComponent(created.acceptUrl!.split('/').at(-1)!);
    await expect(acceptInvitationViaDefiner({ tokenHash: hashInvitationToken(token), userId: owner.id })).resolves.toMatchObject({ orgId: created.orgId, role: 'owner' });
    expect(await testDb.membership.count({ where: { orgId: created.orgId, role: 'owner' } })).toBe(1);
  });

  it('a member of another organisation cannot read the legal name', async () => {
    const other = await buildOrg({ label: 'legal-name-b' });
    await adminCorrectOrgLegalName({ actorUserId: admin.userId, orgId: fx.org.id, legalName: 'A University' });
    await adminCorrectOrgLegalName({ actorUserId: admin.userId, orgId: other.org.id, legalName: 'B University' });
    const read = (orgContext: string, id: string) => asLane(process.env.APP_DATABASE_URL, orgContext, async (c) =>
      (await c.query(`SELECT "legalName" FROM organizations WHERE id = $1`, [id])).rows);
    expect(await read(fx.org.id, fx.org.id)).toEqual([{ legalName: 'A University' }]);
    expect(await read(fx.org.id, other.org.id)).toEqual([]);
    expect(await read(other.org.id, fx.org.id)).toEqual([]);
    expect(await asLane(process.env.APP_DATABASE_URL, null, async (c) => (await c.query(`SELECT "legalName" FROM organizations`)).rows)).toEqual([]);
  });

  it('the old 15-argument create function still runs for makrai_identity (expand-only)', async () => {
    const slug = `old-${randomUUID().slice(0, 6)}`;
    const orgId = randomUUID();
    const rows = await asLane(process.env.IDENTITY_DATABASE_URL, null, async (c) => (await c.query(
      `SELECT org_id, invitation_id, replayed FROM admin_create_organisation($1::text, $2::text, $3::text, $4::text, '1'::text, $5::text, '2026-10-30'::date, 'Old Controller'::text,
         'dpo@fixture.test'::text, 'old@fixture.test'::text, $6::text, now() + interval '7 days', false, $7::uuid, $8::text)`,
      [admin.userId, orgId, `Old ${slug}`, slug, hex('agreement'), hex(randomUUID()), randomUUID(), hex(randomUUID())])).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: orgId, replayed: false });
  });
});
