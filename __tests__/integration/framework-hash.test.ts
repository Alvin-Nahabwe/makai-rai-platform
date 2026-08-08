import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
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

  /**
   * Task 2 review, fix round 2, Important 1 (2026-08-08). `BUNDLE_FILES`
   * above is a hand-written list with nothing anywhere cross-checking it
   * against `data/` -- AGENTS.md §3: "Where a list must be complete,
   * generate it rather than writing it... a hand-written list that must be
   * complete is a latent defect with a timestamp on it." Someone adds
   * `data/newContent.json`, forgets `BUNDLE_FILES`, and `computeBundleHash()`
   * keeps hashing only the original four -- content changes, the hash does
   * not, and `resolveFramework` reports `matches: true` for an assessment
   * pinned against content that changed underneath it. That is exactly "the
   * pin is a stored claim nothing verifies," one level down from what this
   * whole task exists to fix. Modelled on
   * `__tests__/integration/port-completeness.test.ts`'s shape (also D-103:
   * an authoritative hand list, proven complete by a disk enumeration on
   * every run, rather than trusted or auto-generated).
   *
   * DELIBERATELY NOT auto-generating `BUNDLE_FILES` from `readdirSync('data')`
   * at runtime instead of asserting equality here -- coordinator's ruling,
   * recorded so a future reader does not "improve" this back into the
   * version already rejected: a runtime-generated list would make the hash
   * depend on whatever happens to be traced into the standalone image at
   * that moment (see lib/framework/bundleHash.ts and next.config.ts's
   * `outputFileTracingIncludes` comments for why tracing gaps are a real,
   * previously-hit failure mode here). A file silently missing from the
   * standalone image would then silently drop out of the runtime-generated
   * list too, and the hash would still compute successfully over the
   * remaining files -- a quiet mismatch on every assessment instead of a
   * loud throw. `BUNDLE_FILES`'s determinism is the feature this test
   * protects, not a gap to close.
   *
   * Sorts both sides before comparing: this test's claim is that the SET of
   * `.json` files under `data/` is complete, not that `find`'s filesystem
   * enumeration order (unspecified, not guaranteed alphabetical) matches
   * `BUNDLE_FILES`'s array order -- a different property (that order is what
   * makes the hash deterministic across processes, already proven by the
   * "matches the hash recorded in the registry" test below reproducing a
   * fixed golden value).
   */
  it('BUNDLE_FILES enumerates exactly the .json files present in data/', () => {
    const filesOnDisk = execSync(`find data -maxdepth 1 -name '*.json'`)
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort();
    expect(filesOnDisk.length).toBeGreaterThan(0);
    expect(filesOnDisk).toEqual([...BUNDLE_FILES].sort());
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
   *
   * Task 2 review, fix round 2, Important 2 (2026-08-08). This test's own
   * INSERT below is already idempotent (`ON CONFLICT ("id") DO NOTHING`),
   * but idempotent is not the same as cleaned up: nothing deleted the
   * `fv_bogus` row afterward, and `framework_versions` is deliberately
   * excluded from `resetDb()`'s TRUNCATE (`__tests__/helpers/db.ts:34-53`,
   * reference data) with no `globalSetup`/`pretest` to catch it either -- so
   * every run of this suite left a permanent `status='published'` row at
   * semver `9.9.9` in `makrai_test`. That collides with this codebase's own
   * idiom: `framework-current-version.test.ts` already uses a `…-9.9.9`
   * string to mean "a semver that must not exist" in a no-fallback throw
   * test, and a bare `9.9.9` literal used the same way elsewhere would
   * resolve instead of throwing. The `afterEach` below pairs with the
   * INSERT the same way `framework-registry.test.ts`:76-104 pairs its
   * idempotent insert with an `afterEach` -> `deleteMany` for
   * `OTHER_VERSION_ID` -- but does NOT carry that pairing over verbatim.
   * Found live, not reasoned, and worth recording because it is the reason
   * this is not a direct copy-paste: a first draft that only deleted
   * `frameworkVersion` failed every run with `PrismaClientKnownRequestError:
   * Foreign key constraint violated on the constraint:
   * assessments_frameworkVersionId_fkey`. Unlike O-3's `OTHER_VERSION_ID`
   * (only ever referenced by an UPDATE that gets ROLLED BACK via SAVEPOINT,
   * so nothing durable ever points at it) and O-5's `TEST_ROW_ID` (never
   * referenced by an assessment at all), THIS test's whole point is to
   * create a real, COMMITTED `Assessment` permanently pinned to `fv_bogus`
   * -- `Assessment.frameworkVersion` carries no `onDelete: Cascade`
   * (prisma/schema.prisma:146), by design (a pin must not silently vanish),
   * so Postgres correctly refuses to delete a `framework_versions` row a
   * real assessment still points to. The assessment (and its throwaway
   * fixture org/user/project) is deleted first, breaking the FK reference,
   * before the `framework_versions` row itself.
   */
  afterEach(async () => {
    await testDb.assessment.deleteMany({ where: { frameworkVersionId: 'fv_bogus' } });
    await testDb.frameworkVersion.deleteMany({ where: { id: 'fv_bogus' } });
  });

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
