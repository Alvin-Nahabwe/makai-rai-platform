import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { AgreementInput } from '../../types/api';
import { AppError } from '../../lib/http/errors';
import {
  acceptInvitationViaDefiner, adminCorrectOrgName, adminCreateOrganisation, adminIssueOwnerInvitation,
  adminRecordAgreement, adminResendInvitation, adminRevokeInvitation, adminSetAccountActive,
} from '../../lib/data/definer';
import { resetDb, testDb } from '../helpers/db';

/**
 * SRS 9.5 step 5 (line 3689) and the grant table (line 3673): one SECURITY DEFINER function per
 * platform-administrator action and accept_invitation, owned by the NOLOGIN role makrai_definer,
 * search_path pinned, executable by makrai_identity only, each writing its FR-ORG-09 row in the
 * same transaction; and their typed wrappers in lib/data/definer.ts (00-contract.md Services,
 * K0a), which map `makrai:<code>` to AppError(status, code).
 */

const hex = (seed: string) => createHash('sha256').update(seed).digest('hex');
const AGREEMENT: AgreementInput = {
  agreementVersion: '1', textHash: hex('agreement'), acceptedOn: '2026-10-30',
  controllerLegalName: 'Fixture Controller Ltd', dpContactEmail: 'dpo@fixture.test',
};
const in7days = () => new Date(Date.now() + 7 * 86400000);

let su: Client;
let admin: { id: string };
let assessor: { id: string; email: string };

const q = async (sql: string, params: unknown[] = []) => (await su.query(sql, params)).rows;
async function makeUser(over: { role?: 'admin' | 'assessor'; isActive?: boolean; email?: string } = {}) {
  return testDb.user.create({
    data: { email: over.email ?? `def-${randomUUID()}@fixture.test`, name: 'Fixture', passwordHash: 'x', role: over.role ?? 'assessor', isActive: over.isActive ?? true },
  });
}
async function counts(orgId: string) {
  const n = async (t: string, col = '"orgId"') => (await q(`SELECT count(*)::int n FROM "${t}" WHERE ${col} = $1`, [orgId]))[0].n;
  return { organizations: await n('organizations', 'id'), organization_agreements: await n('organization_agreements'),
    invitations: await n('invitations'), organisation_events: await n('organisation_events') };
}
/** A member of a fresh organisation (created by the administrator), joined through accept_invitation. */
async function orgWithMember(role: 'owner' | 'assessor' = 'owner'): Promise<{ orgId: string; member: { id: string; email: string } }> {
  const member = await makeUser();
  const slug = `def-${randomUUID().slice(0, 8)}`;
  const token = hex(randomUUID());
  const { orgId, invitationId } = await adminCreateOrganisation({ actorUserId: admin.id, name: `Org ${slug}`, slug, agreement: AGREEMENT,
    ownerEmail: member.email, tokenHash: token, expiresAt: in7days(), linkShown: false });
  if (role !== 'owner') await q(`UPDATE invitations SET role = $1 WHERE id = $2`, [role, invitationId]);
  await acceptInvitationViaDefiner({ tokenHash: token, userId: member.id });
  return { orgId, member };
}

beforeAll(async () => {
  su = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
  await su.connect();
});
beforeEach(async () => {
  await resetDb();
  admin = await makeUser({ role: 'admin' });
  assessor = await makeUser();
});
afterAll(async () => { await su.end(); });

describe('definer functions and their wrappers', () => {
  it('FR-ORG-01 FR-ORG-09: create writes organisation, agreement, pending owner invitation and one event, or nothing', async () => {
    const args = { actorUserId: admin.id, name: 'Lab A', slug: 'lab-a', agreement: AGREEMENT, ownerEmail: 'o@fixture.test', tokenHash: hex('h'), expiresAt: in7days(), linkShown: true };
    const r = await adminCreateOrganisation(args);
    expect(await counts(r.orgId)).toEqual({ organizations: 1, organization_agreements: 1, invitations: 1, organisation_events: 1 });
    expect(await q(`SELECT kind, role, status, email, "linkShownAt" IS NOT NULL AS shown, "invitedById" FROM invitations WHERE id = $1`, [r.invitationId]))
      .toEqual([{ kind: 'first_owner', role: 'owner', status: 'pending', email: 'o@fixture.test', shown: true, invitedById: admin.id }]);
    expect(await q(`SELECT "actorId", "actorRole", action, "targetInvitationId" FROM organisation_events WHERE "orgId" = $1`, [r.orgId]))
      .toEqual([{ actorId: admin.id, actorRole: 'platform_admin', action: 'organisation_created', targetInvitationId: r.invitationId }]);
    await expect(adminCreateOrganisation({ ...args, name: 'Lab A', tokenHash: hex('h-2') })).rejects.toMatchObject({ status: 409, code: 'slug_taken' });
    expect((await q(`SELECT count(*)::int n FROM organizations WHERE name = 'Lab A'`))[0].n).toBe(1);   // the failed call left nothing
    expect((await q(`SELECT count(*)::int n FROM invitations WHERE "tokenHash" = $1`, [hex('h-2')]))[0].n).toBe(0);
  });

  it('FR-ORG-01 NFR-SEC-12: admin functions refuse a non-administrator actor', async () => {
    const { orgId } = await orgWithMember();
    await expect(adminRecordAgreement({ actorUserId: assessor.id, orgId, agreement: AGREEMENT })).rejects.toMatchObject({ status: 403, code: 'not_platform_admin' });
    const inactiveAdmin = await testDb.user.update({ where: { id: admin.id }, data: { isActive: false } });
    await expect(adminCorrectOrgName({ actorUserId: inactiveAdmin.id, orgId, name: 'x' })).rejects.toMatchObject({ code: 'not_platform_admin' });
    await expect(adminCreateOrganisation({ actorUserId: randomUUID(), name: 'n', slug: 'n', agreement: AGREEMENT, ownerEmail: 'n@fixture.test', tokenHash: hex('n'), expiresAt: in7days(), linkShown: false }))
      .rejects.toMatchObject({ code: 'not_platform_admin' });
  });

  it('FR-ORG-01 NFR-SEC-12 (C4 SEC-2): every administrator function refuses an assessor and an inactive administrator, writing nothing', async () => {
    // An organisation with no owner and a pending first-owner invitation, and an account in no
    // organisation: each call below would succeed, or fail on its own rule, for the administrator.
    const slug = `def-${randomUUID().slice(0, 8)}`;
    const { orgId, invitationId } = await adminCreateOrganisation({ actorUserId: admin.id, name: `Org ${slug}`, slug, agreement: AGREEMENT,
      ownerEmail: 'first@fixture.test', tokenHash: hex(randomUUID()), expiresAt: in7days(), linkShown: false });
    const loner = await makeUser();
    const inactiveAdmin = await makeUser({ role: 'admin', isActive: false });
    const fingerprint = async () => (await q(`SELECT
      (SELECT string_agg(id || ':' || name, ',' ORDER BY id) FROM organizations) AS orgs,
      (SELECT count(*)::int FROM organization_agreements) AS agreements,
      (SELECT string_agg(id || ':' || status, ',' ORDER BY id) FROM invitations) AS invitations,
      (SELECT count(*)::int FROM organisation_events) AS org_events,
      (SELECT count(*)::int FROM platform_events) AS platform_events,
      (SELECT string_agg(id || ':' || "isActive" || ':' || "sessionEpoch", ',' ORDER BY id) FROM users) AS users`))[0];
    const calls: Array<[string, (actorUserId: string) => Promise<unknown>]> = [
      ['admin_create_organisation', (actorUserId) => adminCreateOrganisation({ actorUserId, name: 'Never', slug: `never-${randomUUID().slice(0, 6)}`, agreement: AGREEMENT,
        ownerEmail: 'never@fixture.test', tokenHash: hex(randomUUID()), expiresAt: in7days(), linkShown: false })],
      ['admin_record_agreement', (actorUserId) => adminRecordAgreement({ actorUserId, orgId, agreement: { ...AGREEMENT, agreementVersion: '9' } })],
      ['admin_correct_org_name', (actorUserId) => adminCorrectOrgName({ actorUserId, orgId, name: 'Never Renamed' })],
      ['admin_issue_owner_invitation', (actorUserId) => adminIssueOwnerInvitation({ actorUserId, orgId, email: 'n@fixture.test', tokenHash: hex(randomUUID()),
        expiresAt: in7days(), requestReference: 'REF-N', linkShown: false })],
      ['admin_resend_invitation', (actorUserId) => adminResendInvitation({ actorUserId, invitationId, tokenHash: hex(randomUUID()), expiresAt: in7days(), linkShown: false })],
      ['admin_revoke_invitation', (actorUserId) => adminRevokeInvitation({ actorUserId, invitationId })],
      ['admin_set_account_active', (actorUserId) => adminSetAccountActive({ actorUserId, userId: loner.id, active: false, requestReference: 'REF-N' })],
    ];
    const before = await fingerprint();
    for (const [fn, call] of calls) {
      for (const [who, actor] of [['assessor', assessor.id], ['inactive administrator', inactiveAdmin.id]] as const) {
        const e = await call(actor).then(() => null, (x: unknown) => x);
        expect({ fn, who, e }).toEqual({ fn, who, e: expect.objectContaining({ status: 403, code: 'not_platform_admin' }) });
      }
    }
    expect(await fingerprint()).toEqual(before);
  });

  it('FR-ORG-05 FR-ORG-10: record an agreement and correct the name, each with its row; the earlier name is kept in previousValue', async () => {
    const { orgId } = await orgWithMember();
    const { agreementId } = await adminRecordAgreement({ actorUserId: admin.id, orgId, agreement: { ...AGREEMENT, agreementVersion: '2' } });
    expect(await q(`SELECT "agreementVersion", "recordedById" FROM organization_agreements WHERE id = $1`, [agreementId])).toEqual([{ agreementVersion: '2', recordedById: admin.id }]);
    const [{ name: before }] = await q(`SELECT name FROM organizations WHERE id = $1`, [orgId]);
    expect(await adminCorrectOrgName({ actorUserId: admin.id, orgId, name: 'Corrected Name' })).toEqual({ previousName: before });
    expect(await q(`SELECT name FROM organizations WHERE id = $1`, [orgId])).toEqual([{ name: 'Corrected Name' }]);
    expect(await q(`SELECT action, "previousValue" FROM organisation_events WHERE "orgId" = $1 AND action IN ('agreement_recorded', 'organisation_name_corrected') ORDER BY at, action`, [orgId]))
      .toEqual([{ action: 'agreement_recorded', previousValue: null }, { action: 'organisation_name_corrected', previousValue: before }]);
  });

  it('FR-ORG-02: a new owner invitation is refused while an active owner exists', async () => {
    const { orgId: withOwner } = await orgWithMember();
    const args = { actorUserId: admin.id, orgId: withOwner, email: 'n@fixture.test', tokenHash: hex('h2'), expiresAt: in7days(), requestReference: 'REF-1', linkShown: false };
    await expect(adminIssueOwnerInvitation(args)).rejects.toMatchObject({ status: 409, code: 'active_owner_exists' });
  });

  it('FR-ORG-02: with no active owner, one first-owner invitation may be issued, resent (new row, old revoked) and revoked, each recorded', async () => {
    const { orgId, member } = await orgWithMember();
    await adminSetAccountActive({ actorUserId: admin.id, userId: member.id, active: false, requestReference: 'REF-DEACT' });
    const args = { actorUserId: admin.id, orgId, email: 'n@fixture.test', tokenHash: hex('h3'), expiresAt: in7days(), requestReference: 'REF-1', linkShown: true };
    const { invitationId } = await adminIssueOwnerInvitation(args);
    await expect(adminIssueOwnerInvitation({ ...args, tokenHash: hex('h4') })).rejects.toMatchObject({ code: 'pending_owner_invitation_exists' });
    const resent = await adminResendInvitation({ actorUserId: admin.id, invitationId, tokenHash: hex('h5'), expiresAt: in7days(), linkShown: false });
    expect(resent.invitationId).not.toBe(invitationId);
    expect(await q(`SELECT id, status, "requestReference", kind FROM invitations WHERE id IN ($1, $2) ORDER BY "createdAt", status`, [invitationId, resent.invitationId]))
      .toEqual(expect.arrayContaining([
        { id: invitationId, status: 'revoked', requestReference: 'REF-1', kind: 'first_owner' },
        { id: resent.invitationId, status: 'pending', requestReference: 'REF-1', kind: 'first_owner' }]));
    await expect(adminResendInvitation({ actorUserId: admin.id, invitationId, tokenHash: hex('h6'), expiresAt: in7days(), linkShown: false })).rejects.toMatchObject({ status: 409, code: 'invitation_not_pending' });
    await adminRevokeInvitation({ actorUserId: admin.id, invitationId: resent.invitationId });
    await expect(adminRevokeInvitation({ actorUserId: admin.id, invitationId: resent.invitationId })).rejects.toMatchObject({ code: 'invitation_not_pending' });
    expect((await q(`SELECT action, "requestReference" FROM organisation_events WHERE "orgId" = $1 AND action LIKE 'owner_invitation_%' ORDER BY at`, [orgId])).map((r) => r.action))
      .toEqual(['owner_invitation_issued', 'owner_invitation_resent', 'owner_invitation_revoked']);
    // A member invitation is not the administrator's to resend or revoke.
    const member2 = await orgWithMember('assessor');
    const [memberInvitation] = await q(`SELECT id FROM invitations WHERE "orgId" = $1`, [member2.orgId]);
    await q(`UPDATE invitations SET kind = 'member', status = 'pending' WHERE id = $1`, [memberInvitation.id]);
    await expect(adminRevokeInvitation({ actorUserId: admin.id, invitationId: memberInvitation.id })).rejects.toMatchObject({ code: 'invitation_not_pending' });
  });

  it('FR-ORG-07 FR-ACC-06: deactivation raises sessionEpoch, voids reset tokens, writes one row per organisation', async () => {
    const { orgId, member } = await orgWithMember('assessor');
    await q(`INSERT INTO password_reset_tokens (id, "userId", "tokenHash", "expiresAt") VALUES (gen_random_uuid()::text, $1, $2, now() + interval '30 minutes')`, [member.id, hex('rt')]);
    const epoch = async (id: string) => (await testDb.user.findUniqueOrThrow({ where: { id } })).sessionEpoch;
    const openResetTokens = async (id: string) => (await q(`SELECT count(*)::int n FROM password_reset_tokens WHERE "userId" = $1 AND "voidedAt" IS NULL AND "usedAt" IS NULL`, [id]))[0].n;
    const before = await epoch(member.id);
    const r = await adminSetAccountActive({ actorUserId: admin.id, userId: member.id, active: false, requestReference: null });
    expect(await epoch(member.id)).toBe(before + 1);
    expect(await openResetTokens(member.id)).toBe(0);
    expect(r.affectedOrgIds).toEqual([orgId]);
    expect(await q(`SELECT action, "targetUserId", "actorRole" FROM organisation_events WHERE "orgId" = $1 AND action LIKE 'account_%'`, [orgId]))
      .toEqual([{ action: 'account_deactivated', targetUserId: member.id, actorRole: 'platform_admin' }]);
    expect((await testDb.user.findUniqueOrThrow({ where: { id: member.id } })).isActive).toBe(false);
    // Reactivation restores sign-in and no earlier session.
    await adminSetAccountActive({ actorUserId: admin.id, userId: member.id, active: true, requestReference: null });
    expect(await epoch(member.id)).toBe(before + 1);
    expect((await testDb.user.findUniqueOrThrow({ where: { id: member.id } })).isActive).toBe(true);
  });

  it('FR-ORG-07 FR-ORG-09: an account in no organisation gets a platform_events row; self and the only active owner are refused', async () => {
    const loner = await makeUser();
    expect(await adminSetAccountActive({ actorUserId: admin.id, userId: loner.id, active: false, requestReference: 'REF-9' })).toEqual({ affectedOrgIds: [] });
    expect(await q(`SELECT "actorId", action, "targetUserId", "requestReference" FROM platform_events WHERE "targetUserId" = $1`, [loner.id]))
      .toEqual([{ actorId: admin.id, action: 'account_deactivated', targetUserId: loner.id, requestReference: 'REF-9' }]);
    await expect(adminSetAccountActive({ actorUserId: admin.id, userId: admin.id, active: false, requestReference: null })).rejects.toMatchObject({ status: 409, code: 'self_deactivation' });
    const { member: owner } = await orgWithMember('owner');
    await expect(adminSetAccountActive({ actorUserId: admin.id, userId: owner.id, active: false, requestReference: null })).rejects.toMatchObject({ status: 422, code: 'request_reference_required' });
    expect((await testDb.user.findUniqueOrThrow({ where: { id: owner.id } })).isActive).toBe(true);   // refused: nothing changed
    await expect(adminSetAccountActive({ actorUserId: admin.id, userId: randomUUID(), active: false, requestReference: 'R' })).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('NFR-SEC-12: a temporary table named organizations does not change what the definer writes', async () => {
    const { orgId } = await orgWithMember();
    const s = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
    await s.connect();
    try {
      await s.query(`CREATE TEMP TABLE organizations (id text, name text, slug text, "deletedAt" timestamp)`);
      await s.query(`INSERT INTO pg_temp.organizations VALUES ($1, 'Temp', 'temp', null)`, [orgId]);
      expect((await s.query(`SELECT to_regclass('pg_temp.organizations') IS NOT NULL AS ok`)).rows[0].ok).toBe(true);
      await s.query(`SET ROLE makrai_identity`);
      await s.query(`SELECT admin_correct_org_name($1,$2,$3)`, [admin.id, orgId, 'Corrected']);
      await s.query(`RESET ROLE`);
      expect((await s.query(`SELECT name FROM pg_temp.organizations`)).rows[0].name).toBe('Temp');
    } finally {
      await s.end();
    }
    expect((await q(`SELECT name FROM organizations WHERE id = $1`, [orgId]))[0].name).toBe('Corrected');
  });

  it('FR-ACC-01 FR-ORG-09: acceptInvitationViaDefiner writes the membership and its member_joined row, and refuses a mismatched email and a used token', async () => {
    const u = await makeUser();
    const token = hex(randomUUID());
    const { orgId, invitationId } = await adminCreateOrganisation({ actorUserId: admin.id, name: 'Acc', slug: `acc-${randomUUID().slice(0, 6)}`, agreement: AGREEMENT,
      ownerEmail: u.email.toUpperCase(), tokenHash: token, expiresAt: in7days(), linkShown: false });
    const other = await makeUser();
    await expect(acceptInvitationViaDefiner({ tokenHash: token, userId: other.id })).rejects.toMatchObject({ status: 410, code: 'invitation_unusable' });
    expect(await acceptInvitationViaDefiner({ tokenHash: token, userId: u.id })).toEqual({ orgId, role: 'owner' });
    expect(await q(`SELECT "actorId", "actorRole", "targetUserId", "targetInvitationId" FROM organisation_events WHERE "orgId" = $1 AND action = 'member_joined'`, [orgId]))
      .toEqual([{ actorId: u.id, actorRole: 'owner', targetUserId: u.id, targetInvitationId: invitationId }]);
    expect(await q(`SELECT status, "acceptedAt" IS NOT NULL AS at FROM invitations WHERE id = $1`, [invitationId])).toEqual([{ status: 'accepted', at: true }]);
    await expect(acceptInvitationViaDefiner({ tokenHash: token, userId: u.id })).rejects.toMatchObject({ code: 'invitation_unusable' });   // used
    await expect(acceptInvitationViaDefiner({ tokenHash: hex('unknown'), userId: u.id })).rejects.toMatchObject({ code: 'invitation_unusable' });
    const expiredToken = hex(randomUUID());
    const late = await makeUser();
    const exp = await adminCreateOrganisation({ actorUserId: admin.id, name: 'Late', slug: `late-${randomUUID().slice(0, 6)}`, agreement: AGREEMENT,
      ownerEmail: late.email, tokenHash: expiredToken, expiresAt: new Date(Date.now() - 1000), linkShown: false });
    expect(exp.orgId).toBeTruthy();
    await expect(acceptInvitationViaDefiner({ tokenHash: expiredToken, userId: late.id })).rejects.toMatchObject({ code: 'invitation_unusable' });
  });

  it('NFR-SEC-04: a platform administrator cannot accept an invitation', async () => {
    const token = hex(randomUUID());
    await adminCreateOrganisation({ actorUserId: admin.id, name: 'Adm', slug: `adm-${randomUUID().slice(0, 6)}`, agreement: AGREEMENT,
      ownerEmail: (await testDb.user.findUniqueOrThrow({ where: { id: admin.id } })).email, tokenHash: token, expiresAt: in7days(), linkShown: false });
    await expect(acceptInvitationViaDefiner({ tokenHash: token, userId: admin.id })).rejects.toMatchObject({ code: 'invitation_unusable' });
    expect((await q(`SELECT count(*)::int n FROM memberships WHERE "userId" = $1`, [admin.id]))[0].n).toBe(0);
  });

  it('NFR-SEC-12: makrai_identity may execute exactly the eight definer functions, makrai_app none', async () => {
    const executableFunctions = async (role: string) => (await q(`SELECT p.proname AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND has_function_privilege($1::text, p.oid, 'EXECUTE')
        AND p.prorettype::regtype::text NOT IN ('trigger', 'event_trigger') ORDER BY 1`, [role])).map((r) => r.fn);
    expect(await executableFunctions('makrai_identity')).toEqual(['accept_invitation', 'admin_correct_org_name',
      'admin_create_organisation', 'admin_issue_owner_invitation', 'admin_record_agreement', 'admin_resend_invitation',
      'admin_revoke_invitation', 'admin_set_account_active']);
    expect(await executableFunctions('makrai_app')).toEqual([]);
    expect(await q(`SELECT DISTINCT r.rolname AS owner, p.prosecdef AS definer, p.proconfig AS config FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.proname IN ('accept_invitation', 'admin_correct_org_name', 'admin_create_organisation', 'admin_issue_owner_invitation',
        'admin_record_agreement', 'admin_resend_invitation', 'admin_revoke_invitation', 'admin_set_account_active')`))
      .toEqual([{ owner: 'makrai_definer', definer: true, config: ['search_path=pg_catalog, public, pg_temp'] }]);
  });

  it('NFR-SEC-04 NFR-SEC-12: the definer role can update only isActive and sessionEpoch on users', async () => {
    const columnPrivileges = async (role: string, table: string, p: string) => (await q(`SELECT a.attname::text AS c FROM pg_attribute a
      WHERE a.attrelid = $2::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege($1, $2::regclass, a.attname, $3) ORDER BY 1`, [role, table, p])).map((r) => r.c);
    expect(await columnPrivileges('makrai_definer', 'users', 'UPDATE')).toEqual(['isActive', 'sessionEpoch']);
    expect((await q(`SELECT has_table_privilege('makrai_definer', 'users', 'SELECT') AS ok`))[0].ok).toBe(true);
    expect((await q(`SELECT has_table_privilege('makrai_definer', 'users', 'UPDATE') AS ok`))[0].ok).toBe(false);
  });

  it('FR-ACC-03 FR-ACC-01: acceptInvitationViaDefiner on a given transaction commits or rolls back with it', async () => {
    const u = await makeUser();
    const token = hex(randomUUID());
    await adminCreateOrganisation({ actorUserId: admin.id, name: 'Tx', slug: `tx-${randomUUID().slice(0, 6)}`, agreement: AGREEMENT,
      ownerEmail: u.email, tokenHash: token, expiresAt: in7days(), linkShown: false });
    // An identity-lane interactive transaction, as lib/data/preauth.ts's client opens one.
    const identity = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: process.env.IDENTITY_DATABASE_URL, max: 1, options: '' })) });
    try {
      await expect(identity.$transaction(async (tx) => {
        await acceptInvitationViaDefiner({ tokenHash: token, userId: u.id }, tx);
        expect((await tx.membership.count({ where: { userId: u.id } }))).toBe(1);   // visible inside the transaction
        throw new Error('roll back');
      })).rejects.toThrow('roll back');
      expect(await testDb.membership.count({ where: { userId: u.id } })).toBe(0);
      await identity.$transaction(async (tx) => { await acceptInvitationViaDefiner({ tokenHash: token, userId: u.id }, tx); });
      expect(await testDb.membership.count({ where: { userId: u.id } })).toBe(1);
    } finally {
      await identity.$disconnect();
    }
  });

  it('NFR-SEC-12: identityLaneClient is imported only by definer.ts, identityReads.ts and admin.ts', () => {
    const ALLOWED_IDENTITY_CLIENT_IMPORTERS = ['lib/data/definer.ts', 'lib/data/identityReads.ts', 'lib/data/admin.ts'];
    const importersOf = (mod: string) => execSync(`grep -rlE "from ['\\"][^'\\"]*${mod.split('/').pop()}['\\"]" app lib components --include=*.ts --include=*.tsx || true`)
      .toString().trim().split('\n').filter(Boolean);
    const importers = importersOf('lib/data/identityClient');
    expect(importers).toContain('lib/data/definer.ts');   // the enumeration finds a real importer, so it is not vacuous
    expect(importers.filter((f) => !ALLOWED_IDENTITY_CLIENT_IMPORTERS.includes(f))).toEqual([]);
  });

  it('NFR-SEC-12 (helper): an unknown definer error is not turned into an AppError', async () => {
    await expect(adminCorrectOrgName({ actorUserId: admin.id, orgId: randomUUID(), name: 'x' })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    const e = await adminRecordAgreement({ actorUserId: admin.id, orgId: (await orgWithMember()).orgId, agreement: { ...AGREEMENT, acceptedOn: 'not-a-date' } }).catch((x) => x);
    expect(e).not.toBeInstanceOf(AppError);
  });
});
