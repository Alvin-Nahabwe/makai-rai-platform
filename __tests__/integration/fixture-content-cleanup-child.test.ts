import { beforeEach, expect, it } from 'vitest';
import { bootstrapOrgWithOwner } from '../../lib/data/preauth';
import { testDb, resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';

/**
 * The file `fixture-content-cleanup.test.ts` runs in a separate vitest process, because only the end of a
 * test file shows whether its `afterAll` ran. It publishes both fixture rows and pins an assessment to one,
 * so the rows are referenced when the file ends. Run alone it proves nothing; the suite also runs it as a
 * file, where it passes and cleans up like any other.
 */

beforeEach(resetDb);

it('G-17 (harness): both fixture rows exist while the file runs, one of them referenced by an assessment', async () => {
  const one = await useFixtureContent('0.0.1-fixture');
  const two = await useFixtureContent('0.0.2-fixture');
  const boot = await bootstrapOrgWithOwner({
    email: 'fixture-cleanup-owner@uni.ac.ug',
    name: 'Fixture Cleanup Owner',
    passwordHash: 'x',
    orgName: 'Fixture Cleanup Org',
    ipAddress: '127.0.0.1',
  });
  const project = await testDb.project.create({ data: { orgId: boot.orgId, name: 'Cleanup Project', createdById: boot.userId } });
  await testDb.assessment.create({
    data: { orgId: boot.orgId, projectId: project.id, userId: boot.userId, frameworkVersionId: two.contentVersionId, engineState: {} as never },
  });
  const ids = (await testDb.frameworkVersion.findMany({ where: { id: { startsWith: 'fv_fixture_' } }, orderBy: { id: 'asc' } })).map((r) => r.id);
  expect(ids).toEqual([one.contentVersionId, two.contentVersionId]);
});
