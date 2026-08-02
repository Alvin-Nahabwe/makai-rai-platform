import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';

async function mkUser(email: string) {
  return testDb.user.create({ data: { email, name: email, passwordHash: 'x' } });
}

describe('organization schema', () => {
  beforeEach(resetDb);

  it('enforces a unique org slug', async () => {
    await testDb.organization.create({ data: { name: 'A', slug: 'dup' } });
    await expect(
      testDb.organization.create({ data: { name: 'B', slug: 'dup' } }),
    ).rejects.toThrow();
  });

  it('allows one membership per (org, user) and rejects a second', async () => {
    const u = await mkUser('m@x.org');
    const o = await testDb.organization.create({ data: { name: 'O', slug: 'o' } });
    await testDb.membership.create({ data: { orgId: o.id, userId: u.id, role: 'owner' } });
    await expect(
      testDb.membership.create({ data: { orgId: o.id, userId: u.id, role: 'viewer' } }),
    ).rejects.toThrow();
  });

  it('lets one user belong to two organizations', async () => {
    const u = await mkUser('multi@x.org');
    const a = await testDb.organization.create({ data: { name: 'A', slug: 'a' } });
    const b = await testDb.organization.create({ data: { name: 'B', slug: 'b' } });
    await testDb.membership.create({ data: { orgId: a.id, userId: u.id, role: 'owner' } });
    await testDb.membership.create({ data: { orgId: b.id, userId: u.id, role: 'viewer' } });
    expect(await testDb.membership.count({ where: { userId: u.id } })).toBe(2);
  });

  it('enforces a unique invitation token', async () => {
    const o = await testDb.organization.create({ data: { name: 'O', slug: 'inv' } });
    const u = await mkUser('inviter@x.org');
    const base = { orgId: o.id, email: 'a@x.org', role: 'viewer' as const,
                   invitedById: u.id, expiresAt: new Date(Date.now() + 86400000) };
    await testDb.invitation.create({ data: { ...base, token: 'tok' } });
    await expect(testDb.invitation.create({ data: { ...base, token: 'tok' } })).rejects.toThrow();
  });
});
