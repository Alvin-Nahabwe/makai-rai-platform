import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../helpers/db';
import { buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { lastActiveOwnerOf } from '../../lib/data/identityReads';

/**
 * S-21's data for M-38 (FR-EXP-03; contract "Further cross-unit symbols", gap G030; obligation B18): the organisations
 * where this account is the only owner whose account is active, so deleting it would leave the organisation with none.
 * Names only, and only of the caller's own organisations.
 */
async function addOwner(fx: OrgFixture, label: string): Promise<string> {
  const u = await testDb.user.create({ data: { email: `${label}-${fx.org.id}@fixture.test`, name: label, passwordHash: 'x' } });
  await testDb.membership.create({ data: { orgId: fx.org.id, userId: u.id, role: 'owner' } });
  return u.id;
}

beforeEach(resetDb);

describe('lastActiveOwnerOf', () => {
  it('M-38 FR-EXP-03 (S-21 data): only the caller\'s organisations are named, and only where no other active owner exists', async () => {
    const one = await buildOrg({ label: 'Lab One' });
    const two = await buildOrg({ label: 'Lab Two' });
    const second = await addOwner(two, 'second-owner'); // a second active owner in Lab Two
    expect(await lastActiveOwnerOf(one.members.owner.userId)).toEqual([one.org.name]);
    expect(await lastActiveOwnerOf(two.members.owner.userId)).toEqual([]);
    await testDb.user.update({ where: { id: second }, data: { isActive: false } });
    expect(await lastActiveOwnerOf(two.members.owner.userId)).toEqual([two.org.name]);
    expect(await lastActiveOwnerOf(one.members.viewer.userId)).toEqual([]);
  });

  it('M-38: names are sorted, archived organisations are left out, and a suspended owner is not an owner', async () => {
    const zeta = await buildOrg({ label: 'zeta' });
    const alpha = await buildOrg({ label: 'alpha' });
    const gone = await buildOrg({ label: 'gone' });
    // One account owning three organisations.
    const me = zeta.members.owner.userId;
    await testDb.membership.create({ data: { orgId: alpha.org.id, userId: me, role: 'owner' } });
    await testDb.membership.create({ data: { orgId: gone.org.id, userId: me, role: 'owner' } });
    await testDb.membership.delete({ where: { orgId_userId: { orgId: alpha.org.id, userId: alpha.members.owner.userId } } });
    await testDb.membership.delete({ where: { orgId_userId: { orgId: gone.org.id, userId: gone.members.owner.userId } } });
    await testDb.organization.update({ where: { id: gone.org.id }, data: { deletedAt: new Date() } });
    expect(await lastActiveOwnerOf(me)).toEqual([alpha.org.name, zeta.org.name].sort());
    // A suspended second owner does not keep zeta owned.
    const other = await addOwner(zeta, 'suspended-owner');
    await testDb.membership.update({ where: { orgId_userId: { orgId: zeta.org.id, userId: other } }, data: { status: 'suspended' } });
    expect(await lastActiveOwnerOf(me)).toEqual([alpha.org.name, zeta.org.name].sort());
  });
});
