import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';

describe('organization schema', () => {
  beforeEach(resetDb);

  it('creates an org with an owner membership', async () => {
    const user = await testDb.user.create({
      data: { email: 'a@example.org', name: 'A', passwordHash: 'x' },
    });
    const org = await testDb.organization.create({
      data: { name: 'Makerere AI Lab', slug: 'makerere-ai-lab' },
    });
    const m = await testDb.membership.create({
      data: { orgId: org.id, userId: user.id, role: 'owner' },
    });
    expect(m.role).toBe('owner');
    expect(m.status).toBe('active');
  });

  it('rejects a duplicate membership for the same user and org', async () => {
    const user = await testDb.user.create({
      data: { email: 'b@example.org', name: 'B', passwordHash: 'x' },
    });
    const org = await testDb.organization.create({
      data: { name: 'Org B', slug: 'org-b' },
    });
    await testDb.membership.create({
      data: { orgId: org.id, userId: user.id, role: 'admin' },
    });
    await expect(
      testDb.membership.create({
        data: { orgId: org.id, userId: user.id, role: 'viewer' },
      }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate org slug', async () => {
    await testDb.organization.create({ data: { name: 'One', slug: 'dup' } });
    await expect(
      testDb.organization.create({ data: { name: 'Two', slug: 'dup' } }),
    ).rejects.toThrow();
  });
});
