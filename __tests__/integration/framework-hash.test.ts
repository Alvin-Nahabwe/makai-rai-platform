import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { computeBundleHash, BUNDLE_FILES } from '@/lib/framework/bundleHash';
import { testDb } from '../helpers/db';

describe('content bundle hash', () => {
  it('hashes exactly the four content files, in a fixed order', () => {
    expect(BUNDLE_FILES).toEqual([
      'data/assessmentAreas.json',
      'data/projectConfig.json',
      'data/questionBank.json',
      'data/scoringConfig.json',
    ]);
  });

  it('matches the hash recorded in the registry (O-13)', async () => {
    const [row] = await testDb.$queryRaw<Array<{ contentHash: string }>>`
      SELECT "contentHash" FROM "framework_versions" WHERE "semver" = '3.0.0'`;
    expect(computeBundleHash()).toBe(row.contentHash);
  });

  /**
   * O-14, first half. Deviates from the brief in two ways, both because the
   * brief's snippet was written from memory rather than verified (reported
   * per AGENTS.md §2 "an assumption in the brief turns out false"):
   *
   * 1. `fx.orgA.usersByRole.owner[0].id` does not exist on `TwoOrgFixture`
   *    (__tests__/helpers/fixture.ts:52-57): the real shape is
   *    `{ orgs: [FixtureOrg, FixtureOrg], users: FixtureUser[] }` with a
   *    FLAT `users` array carrying `userId`/`orgSlug`/`role`/`index`, not a
   *    per-org `usersByRole` map. Matches the idiom already used by
   *    `__tests__/integration/fixture.test.ts` and
   *    `permission-matrix.test.ts` (`fixture.orgs[0]`,
   *    `fixture.users.filter((u) => u.orgSlug === org.slug && ...)`).
   * 2. `tx.project.findFirstOrThrow({ select: { id: true } })` assumes a
   *    Project already exists in the fresh org. It does not:
   *    `buildTwoOrgFixture()` -> `bootstrapOrgWithOwner`
   *    (lib/data/preauth.ts:155-175) creates only User, Organization and
   *    ConsentRecord rows -- no Project. Verified live: running the brief's
   *    literal form throws
   *    `PrismaClientKnownRequestError: An operation failed because it
   *    depends on one or more records that were required but not found.`
   *    (P2025) from `findFirstOrThrow`. A Project is created explicitly
   *    below instead, matching the pattern every other integration test
   *    that needs one already uses (e.g. framework-registry.test.ts:113,
   *    permission-matrix.test.ts:409).
   */
  it('reports a mismatch when the pinned hash differs from the running bundle', async () => {
    const { buildTwoOrgFixture } = await import('@/__tests__/helpers/fixture');
    const { resolveFramework } = await import('@/lib/data/framework');
    const { withOrg, createOrgContext } = await import('@/lib/data/tenant');
    const { createAssessment } = await import('@/lib/engine/AssessmentEngine.js');

    const fx = await buildTwoOrgFixture();
    const orgA = fx.orgs[0];
    const owner = fx.users.find(
      (u) => u.orgSlug === orgA.slug && u.role === 'owner' && u.index === 0,
    );
    expect(owner, 'fixture must carry a bootstrap owner (index 0) for orgA').toBeDefined();

    // A second registry row with a deliberately wrong hash. The migration's own
    // row is correct by construction, so this is the only way to produce a
    // mismatch. framework_versions is not tenant data, so it is written on the
    // identity connection.
    await testDb.$executeRaw`
      INSERT INTO "framework_versions" ("id","semver","contentHash","publishedAt")
      VALUES ('fv_bogus','9.9.9','0000000000000000000000000000000000000000000000000000000000000000', now())
      ON CONFLICT ("id") DO NOTHING`;

    const ctx = createOrgContext(orgA.id, 'owner');
    const res = await withOrg(ctx, async (tx) => {
      // buildTwoOrgFixture() creates no Project for either org -- see the
      // doc comment above. Created explicitly, scoped to orgA the same way
      // the RLS INSERT policy requires (orgId must equal the GUC withOrg set).
      const project = await tx.project.create({
        data: { orgId: orgA.id, name: 'fw-hash-mismatch project', createdById: owner!.userId },
      });
      // A NEW assessment pinned to the bogus row at creation. Do NOT update an
      // existing assessment's pin: Task 1's write-once trigger rejects that, and
      // the trigger is a control this plan installs, never something a test
      // works around.
      const created = await tx.assessment.create({
        data: {
          orgId: orgA.id,
          projectId: project.id,
          userId: owner!.userId,
          frameworkVersionId: 'fv_bogus',
          // Same cast the real writer uses (app/api/v1/orgs/[slug]/assessments/route.ts:86) --
          // EngineState (lib/engine/AssessmentEngine.d.ts) has no index
          // signature, so it is not directly assignable to Prisma's Json
          // input type.
          engineState: createAssessment() as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return resolveFramework(created.id, tx);
    });

    expect(res?.pinned.semver).toBe('9.9.9');
    expect(res?.matches).toBe(false);
  });
});
