import { beforeAll, describe, expect, it } from 'vitest';
import type { Identity } from '../../lib/auth/identity';
import { orgRoleLabel } from '../../lib/authz/roleLabel';
import { resetDb, testDb } from '../helpers/db';
import { buildOrg, buildPlatformAdmin, type FixtureAccount, type OrgFixture } from '../helpers/recordFixture';

/**
 * UX-02 (SRS lines 1523-1524): the sidebar shows the person's role in the organisation whose page is open, or
 * "MAK-AI administrator", and never the account's platform role field (`User.role` defaults to `assessor`).
 * The label is read from the database on every call, so a role change shows on the next page.
 */

const identityOf = (u: FixtureAccount, platformRole: Identity['platformRole'] = 'assessor'): Identity =>
  ({ userId: u.userId, email: u.email, name: u.name, platformRole, mustChangePassword: false });

let a: OrgFixture;
let b: OrgFixture;
let c: OrgFixture;
let u: FixtureAccount;

beforeAll(async () => {
  await resetDb();
  [a, b, c] = [await buildOrg({ label: 'label-a' }), await buildOrg({ label: 'label-b' }), await buildOrg({ label: 'label-c' })];
  // one account: viewer in A (its fixture seat), owner in B
  u = a.members.viewer;
  await testDb.membership.create({ data: { orgId: b.org.id, userId: u.userId, role: 'owner' } });
});

describe('the sidebar role label (UX-02)', () => {
  it('UX-02: the sidebar label is the role in the open organisation', async () => {
    expect(await orgRoleLabel(identityOf(u), a.org.slug)).toBe('viewer');
    expect(await orgRoleLabel(identityOf(u), b.org.slug)).toBe('owner');
    expect(await orgRoleLabel(identityOf(u), c.org.slug)).toBeNull();      // not a member of C
    expect(await orgRoleLabel(identityOf(u), undefined)).toBeNull();       // not an organisation page
    const admin = await buildPlatformAdmin();
    expect(await orgRoleLabel(identityOf(admin, 'admin'), a.org.slug)).toBe('MAK-AI administrator');
    expect(await orgRoleLabel(identityOf(u), a.org.slug)).not.toBe('assessor');   // never User.role (SRS line 1524)
  });

  it('UX-02: the platform administrator reads "MAK-AI administrator" on every page, and nothing else does', async () => {
    // The file resets the database once (beforeAll), and the database keeps a single administrator (NFR-SEC-19): the
    // previous case's administrator steps down first.
    await testDb.user.updateMany({ where: { role: 'admin' }, data: { role: 'assessor' } });
    const admin = await buildPlatformAdmin();
    expect(await orgRoleLabel(identityOf(admin, 'admin'), undefined)).toBe('MAK-AI administrator');
    expect(await orgRoleLabel(identityOf(admin, 'admin'), 'no-such-organisation')).toBe('MAK-AI administrator');
    for (const role of ['owner', 'admin', 'assessor', 'reviewer', 'viewer'] as const)
      expect(await orgRoleLabel(identityOf(a.members[role]), a.org.slug)).toBe(role);
    expect(await orgRoleLabel(identityOf(u), 'no-such-organisation')).toBeNull();
  });

  it('UX-02 FR-AUTHZ-01: the label follows the membership row on the next call: a role change, a suspension, an archived organisation', async () => {
    const seat = c.members.assessor;
    expect(await orgRoleLabel(identityOf(seat), c.org.slug)).toBe('assessor');
    await testDb.membership.update({ where: { orgId_userId: { orgId: c.org.id, userId: seat.userId } }, data: { role: 'admin' } });
    expect(await orgRoleLabel(identityOf(seat), c.org.slug)).toBe('admin');
    await testDb.membership.update({ where: { orgId_userId: { orgId: c.org.id, userId: seat.userId } }, data: { status: 'suspended' } });
    expect(await orgRoleLabel(identityOf(seat), c.org.slug)).toBeNull();
    const reviewer = c.members.reviewer;
    await testDb.organization.update({ where: { id: c.org.id }, data: { deletedAt: new Date() } });
    expect(await orgRoleLabel(identityOf(reviewer), c.org.slug)).toBeNull();
  });
});
