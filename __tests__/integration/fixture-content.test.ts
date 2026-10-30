import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { computeVersionBundleHash } from '@/lib/content/bundleHash';
import { runningSemver } from '@/lib/content/root';
import { testDb, resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';

/**
 * G-17 (unit H0). `useFixtureContent` makes a fixture content version the running one and puts its
 * `framework_versions` row in the database, so a decision can be recorded against it.
 */
describe('useFixtureContent', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // resetDb() keeps framework_versions, so the fixture rows would outlive this file, and
  // framework-registry.test.ts fails on any row no migration inserted. This file records nothing against
  // the rows, so deleting them is safe; a test that does record against them deletes what refers to them first.
  afterAll(async () => {
    await testDb.frameworkVersion.deleteMany({ where: { id: { startsWith: 'fv_fixture_' } } });
  });

  it('G-17: useFixtureContent publishes the fixture row idempotently after resetDb', async () => {
    await resetDb();
    const a = await useFixtureContent('0.0.2-fixture');
    const b = await useFixtureContent('0.0.2-fixture');
    expect(a).toEqual(b);
    expect(a).toEqual({
      contentVersionId: 'fv_fixture_0_0_2',
      semver: '0.0.2-fixture',
      contentHash: computeVersionBundleHash('__tests__/fixtures/content/0.0.2-fixture'),
    });
    expect(runningSemver()).toBe('0.0.2-fixture');
    expect(await testDb.frameworkVersion.count({ where: { id: 'fv_fixture_0_0_2', status: 'published' } })).toBe(1);
  });

  it('G-17: both fixture versions have their own row, and switching back restores the default running version', async () => {
    const one = await useFixtureContent('0.0.1-fixture');
    const two = await useFixtureContent('0.0.2-fixture');
    expect(one.contentVersionId).toBe('fv_fixture_0_0_1');
    expect(two.contentVersionId).toBe('fv_fixture_0_0_2');
    expect(one.contentHash).not.toBe(two.contentHash);
    await useFixtureContent('0.0.1-fixture');
    expect(runningSemver()).toBe('0.0.1-fixture');
    const rows = await testDb.frameworkVersion.findMany({ where: { id: { startsWith: 'fv_fixture_' } }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.id, r.semver, r.status, r.contentHash])).toEqual([
      ['fv_fixture_0_0_1', '0.0.1-fixture', 'published', one.contentHash],
      ['fv_fixture_0_0_2', '0.0.2-fixture', 'published', two.contentHash],
    ]);
  });

  it('G-17: a stale row is brought back to the current hash and status', async () => {
    await testDb.frameworkVersion.upsert({
      where: { id: 'fv_fixture_0_0_1' },
      create: { id: 'fv_fixture_0_0_1', semver: '0.0.1-fixture', contentHash: 'stale', publishedAt: new Date('2026-01-01T00:00:00Z'), status: 'deprecated' },
      update: { contentHash: 'stale', status: 'deprecated' },
    });
    const ref = await useFixtureContent('0.0.1-fixture');
    const row = await testDb.frameworkVersion.findUniqueOrThrow({ where: { id: 'fv_fixture_0_0_1' } });
    expect([row.contentHash, row.status]).toEqual([ref.contentHash, 'published']);
  });
});
