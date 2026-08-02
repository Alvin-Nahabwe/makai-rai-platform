import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';

async function seedOrg(slug: string) {
  const user = await testDb.user.create({
    data: { email: `${slug}@example.org`, name: slug, passwordHash: 'x' },
  });
  const org = await testDb.organization.create({ data: { name: slug, slug } });
  await testDb.membership.create({
    data: { orgId: org.id, userId: user.id, role: 'owner' },
  });
  return { org, user };
}

describe('tenant tables', () => {
  beforeEach(resetDb);

  it('requires orgId on a project', async () => {
    const { user } = await seedOrg('org-a');
    await expect(
      // @ts-expect-error orgId is required
      testDb.project.create({ data: { name: 'P', createdById: user.id } }),
    ).rejects.toThrow();
  });

  it('refuses an assessment pointing at another org\'s project', async () => {
    const a = await seedOrg('org-a');
    const b = await seedOrg('org-b');
    const projectA = await testDb.project.create({
      data: { orgId: a.org.id, name: 'A project', createdById: a.user.id },
    });
    await expect(
      testDb.assessment.create({
        data: {
          orgId: b.org.id,             // org B ...
          projectId: projectA.id,      // ... pointing at org A's project
          userId: b.user.id,
          engineState: {},
        },
      }),
    ).rejects.toThrow();
  });
});
