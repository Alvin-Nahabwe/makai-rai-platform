import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';

async function seed(slug: string) {
  const user = await testDb.user.create({
    data: { email: `${slug}@x.org`, name: slug, passwordHash: 'x' },
  });
  const org = await testDb.organization.create({ data: { name: slug, slug } });
  const project = await testDb.project.create({
    data: { orgId: org.id, name: `${slug} project`, createdById: user.id },
  });
  return { user, org, project };
}

describe('tenant schema', () => {
  beforeEach(resetDb);

  it('refuses a project with no orgId', async () => {
    const u = await testDb.user.create({ data: { email: 'n@x.org', name: 'n', passwordHash: 'x' } });
    await expect(
      // @ts-expect-error orgId is required — this must not compile or run
      testDb.project.create({ data: { name: 'orphan', createdById: u.id } }),
    ).rejects.toThrow();
  });

  it('refuses an assessment attached to another org project', async () => {
    const a = await seed('t2-a');
    const b = await seed('t2-b');
    await expect(
      testDb.assessment.create({
        data: { orgId: a.org.id, projectId: b.project.id, userId: a.user.id, engineState: {} },
      }),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('refuses a remediation item attached to another org assessment', async () => {
    const a = await seed('t2-c');
    const b = await seed('t2-d');
    const asmt = await testDb.assessment.create({
      data: { orgId: b.org.id, projectId: b.project.id, userId: b.user.id, engineState: {} },
    });
    await expect(
      testDb.remediationItem.create({
        data: { orgId: a.org.id, assessmentId: asmt.id, areaId: 'PO-03',
                areaName: 'Accountability', tier: 'gap', description: 'cross-tenant' },
      }),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('accepts a same-org chain', async () => {
    const a = await seed('t2-ok');
    const asmt = await testDb.assessment.create({
      data: { orgId: a.org.id, projectId: a.project.id, userId: a.user.id, engineState: {} },
    });
    const item = await testDb.remediationItem.create({
      data: { orgId: a.org.id, assessmentId: asmt.id, areaId: 'PO-01',
              areaName: 'Governance', tier: 'attention', description: 'ok' },
    });
    expect(item.orgId).toBe(a.org.id);
  });
});
