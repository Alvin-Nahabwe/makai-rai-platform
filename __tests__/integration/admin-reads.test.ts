import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { testDb, resetDb } from '../helpers/db';
import { buildOrg, buildPlatformAdmin, type FixtureAccount, type OrgFixture } from '../helpers/recordFixture';
import { accountsForAdmin, listOrganisationsForAdmin, organisationForAdmin } from '../../lib/data/admin';
import { NotFoundError } from '../../lib/data/tenant';

/**
 * The administrator's reads (S-23, S-24, S-25), on the identity lane through identityLaneClient. They name
 * organisations, member counts, owner activity, agreements and first-owner invitations, and never a record.
 */

const hex = (s: string) => createHash('sha256').update(s).digest('hex');

let admin: FixtureAccount;
let withAgreement: OrgFixture;
let noAgreement: OrgFixture;

beforeEach(async () => {
  await resetDb();
  admin = await buildPlatformAdmin();
  withAgreement = await buildOrg({ label: 'agr' });
  noAgreement = await buildOrg({ label: 'none', withAgreement: false });
});

async function firstOwnerInvitation(fx: OrgFixture, over: { status?: 'pending' | 'accepted' | 'revoked'; expiresAt?: Date; linkShownAt?: Date | null; email?: string; createdAt?: Date } = {}) {
  return testDb.invitation.create({ data: {
    orgId: fx.org.id, email: over.email ?? `first-owner-${fx.org.id}@fixture.test`, role: 'owner', kind: 'first_owner',
    tokenHash: hex(`token ${Math.random()}`), invitedById: admin.userId, status: over.status ?? 'pending',
    expiresAt: over.expiresAt ?? new Date(Date.now() + 7 * 86_400_000), linkShownAt: over.linkShownAt ?? null,
    ...(over.createdAt ? { createdAt: over.createdAt } : {}),
  } });
}

describe('listOrganisationsForAdmin', () => {
  it('FR-ORG-03 FR-ORG-06: the organisation rows hold only the allowed fields and flag what is missing', async () => {
    await testDb.organization.update({ where: { id: withAgreement.org.id }, data: { legalName: 'Fixture Controller Ltd' } });
    const rows = await listOrganisationsForAdmin();
    const a = rows.find((r) => r.orgId === withAgreement.org.id)!;
    expect(Object.keys(a).sort()).toEqual(['archived', 'createdAt', 'hasActiveOwner', 'legalName', 'memberCount', 'name', 'orgId', 'ownerInvitationState']);
    expect(a).toMatchObject({ name: withAgreement.org.name, memberCount: 5, legalName: 'Fixture Controller Ltd', hasActiveOwner: true, archived: false, ownerInvitationState: null });
    expect(a.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(rows.find((r) => r.orgId === noAgreement.org.id)!.legalName).toBeNull();
  });

  it('FR-ORG-02 FR-ORG-03: the owner invitation state is the newest first-owner invitation, and archiving is shown', async () => {
    await firstOwnerInvitation(noAgreement, { status: 'revoked', createdAt: new Date(Date.now() - 60_000) });
    await firstOwnerInvitation(noAgreement, { expiresAt: new Date(Date.now() - 1000) });
    await testDb.organization.update({ where: { id: withAgreement.org.id }, data: { deletedAt: new Date() } });
    const rows = await listOrganisationsForAdmin();
    expect(rows.find((r) => r.orgId === noAgreement.org.id)!.ownerInvitationState).toBe('expired');
    expect(rows.find((r) => r.orgId === withAgreement.org.id)!.archived).toBe(true);
  });
});

describe('organisationForAdmin', () => {
  it('FR-ORG-05: the agreement records an organisation already holds stay in its history, newest first, beside its legal name', async () => {
    const orgId = withAgreement.org.id;
    await testDb.organisationAgreement.create({ data: { orgId, agreementVersion: '2', textHash: hex('agreement v2'), acceptedOn: new Date('2026-10-30T00:00:00Z'),
      controllerLegalName: 'Fixture Controller Ltd', dpContactEmail: 'dpo@fixture.test', recordedById: admin.userId } });
    await testDb.organization.update({ where: { id: orgId }, data: { legalName: 'Fixture Controller Ltd' } });
    const d = await organisationForAdmin(orgId);
    expect(d.agreements.map((x) => x.agreementVersion)).toEqual(['2', '1']);
    expect(d.row.legalName).toBe('Fixture Controller Ltd');
    expect(Object.keys(d.agreements[0]).sort()).toEqual(['acceptedOn', 'agreementVersion', 'controllerLegalName', 'dpContactEmail', 'id', 'recordedAt', 'textHash']);
    expect(d.agreements[0].acceptedOn).toBe('2026-10-30');
  });

  it('FR-ORG-07: an organisation whose only owner is deactivated has no active owner', async () => {
    const other = await buildOrg({ label: 'other' });
    const otherOrgOnlyOwner = other.members.owner.userId;
    await testDb.user.update({ where: { id: withAgreement.members.owner.userId }, data: { isActive: false } });
    expect((await organisationForAdmin(withAgreement.org.id)).row.hasActiveOwner).toBe(false);
    const accounts = await accountsForAdmin();
    expect(accounts.find((u) => u.userId === otherOrgOnlyOwner)!.onlyActiveOwnerOf).toEqual([other.org.name]);
    expect(accounts.find((u) => u.userId === withAgreement.members.owner.userId)!.onlyActiveOwnerOf).toEqual([]);   // inactive: not an active owner
    expect(accounts.find((u) => u.userId === other.members.admin.userId)!.onlyActiveOwnerOf).toEqual([]);           // an organisation admin is not an owner
  });

  it('FR-ORG-07: an owner beside another active owner is not the only one', async () => {
    const second = await testDb.user.create({ data: { email: 'second-owner@fixture.test', name: 'Second Owner', passwordHash: 'x' } });
    await testDb.membership.create({ data: { orgId: withAgreement.org.id, userId: second.id, role: 'owner' } });
    const accounts = await accountsForAdmin();
    expect(accounts.find((u) => u.userId === withAgreement.members.owner.userId)!.onlyActiveOwnerOf).toEqual([]);
    expect(accounts.find((u) => u.userId === second.id)!.onlyActiveOwnerOf).toEqual([]);
  });

  it('FR-ORG-02 FR-ACC-10 (helper): first-owner invitations carry their state, and an account created from a shown link is marked', async () => {
    const shownAt = new Date(Date.now() - 3600_000);
    const fromLink = await firstOwnerInvitation(noAgreement, { status: 'accepted', linkShownAt: shownAt, email: 'from-link@fixture.test', createdAt: new Date(Date.now() - 7200_000) });
    await testDb.user.create({ data: { email: 'from-link@fixture.test', name: 'From Link', passwordHash: 'x', createdAt: new Date(shownAt.getTime() + 1000) } });
    const before = await firstOwnerInvitation(noAgreement, { status: 'accepted', linkShownAt: shownAt, email: 'had-account@fixture.test', createdAt: new Date(Date.now() - 5400_000) });
    await testDb.user.create({ data: { email: 'had-account@fixture.test', name: 'Had Account', passwordHash: 'x', createdAt: new Date(shownAt.getTime() - 1000) } });
    const noLink = await firstOwnerInvitation(noAgreement, { email: 'pending@fixture.test' });
    await testDb.invitation.create({ data: {   // a member invitation is not a first-owner invitation
      orgId: noAgreement.org.id, email: 'member@fixture.test', role: 'viewer', kind: 'member', tokenHash: hex('member'),
      invitedById: noAgreement.members.owner.userId, expiresAt: new Date(Date.now() + 86_400_000),
    } });

    const d = await organisationForAdmin(noAgreement.org.id);
    expect(d.ownerInvitations.map((i) => i.id)).toEqual([noLink.id, before.id, fromLink.id]);   // newest first
    const byId = new Map(d.ownerInvitations.map((i) => [i.id, i]));
    expect(byId.get(fromLink.id)).toMatchObject({ kind: 'first_owner', role: 'owner', state: 'accepted', linkShown: true, createdFromShownLink: true });
    expect(byId.get(before.id)).toMatchObject({ state: 'accepted', linkShown: true, createdFromShownLink: false });
    expect(byId.get(noLink.id)).toMatchObject({ state: 'pending', linkShown: false, createdFromShownLink: false });
    expect(d.row.ownerInvitationState).toBe('pending');
  });

  it('FR-ACC-10 (helper): an account with the address made after the invitation was accepted is not marked as from the link', async () => {
    const shownAt = new Date(Date.now() - 3600_000);
    const inv = await firstOwnerInvitation(noAgreement, { status: 'accepted', linkShownAt: shownAt, email: 'reused@fixture.test' });
    await testDb.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date(shownAt.getTime() + 60_000) } });
    await testDb.user.create({ data: { email: 'reused@fixture.test', name: 'Later Account', passwordHash: 'x', createdAt: new Date(shownAt.getTime() + 120_000) } });
    expect((await organisationForAdmin(noAgreement.org.id)).ownerInvitations[0]).toMatchObject({ id: inv.id, createdFromShownLink: false });
  });

  it('FR-ORG-03: an unknown organisation id is NotFoundError', async () => {
    await expect(organisationForAdmin('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    await expect(organisationForAdmin('')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('accountsForAdmin', () => {
  it('FR-ORG-07 NFR-SEC-19: lists every account with its platform role and state, and the administrator owns nothing', async () => {
    await testDb.user.update({ where: { id: noAgreement.members.viewer.userId }, data: { isActive: false } });
    const accounts = await accountsForAdmin();
    expect(accounts).toHaveLength(11);   // the administrator and two organisations of five
    const me = accounts.find((u) => u.userId === admin.userId)!;
    expect(Object.keys(me).sort()).toEqual(['createdAt', 'email', 'isActive', 'name', 'onlyActiveOwnerOf', 'platformRole', 'userId']);
    expect(me).toMatchObject({ platformRole: 'admin', isActive: true, onlyActiveOwnerOf: [], email: admin.email, name: admin.name });
    expect(accounts.find((u) => u.userId === noAgreement.members.viewer.userId)).toMatchObject({ platformRole: 'assessor', isActive: false });
  });
});
