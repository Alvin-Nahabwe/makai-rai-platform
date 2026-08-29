import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// NOTE (Task 1 implementer, deviation from the brief, reported per AGENTS.md
// §2): the brief specified `import { identityDb } from '@/lib/data/identity'`
// and called `.$queryRaw` on it. `identityDb` (lib/data/identity.ts) is a
// deliberately narrow, CONSTRUCTED client -- its whole design point (see that
// file's five-attempt history comment) is that it exposes ONLY `user`,
// `consentRecord`, `$connect`, `$disconnect`; `$queryRaw`/`$executeRaw` are
// absent on purpose, because raw SQL would let a caller read a tenant table
// directly and defeat `assertNoTenantRelation`'s guard entirely. Calling
// `identityDb.$queryRaw` throws `TypeError: identityDb.$queryRaw is not a
// function` -- confirmed by running the brief's test verbatim before making
// this change. `testDb` (../helpers/db) is the established precedent for
// exactly this class of pg_catalog/information_schema introspection query --
// `__tests__/integration/tenant-schema.test.ts` already does the identical
// RLS/grant introspection through it. It connects as the same `makrai`
// superuser role `identityDb`'s base client uses (same DATABASE_URL), so the
// query semantics are unchanged; only the guard wrapper -- irrelevant here,
// since none of these three tests touch `user`/`consentRecord` -- is absent.
import { testDb, resetDb, SEEDED_FRAMEWORK_VERSION_ID } from '../helpers/db';
import { appClient } from '../../lib/data/tenant';

describe('framework_versions registry', () => {
  it('carries the seeded 3.0.0 row created by the migration, not by seed.ts', async () => {
    // Filtered by id, not asserted as the table's only row (the brief's
    // literal form used `toHaveLength(1)` over an unfiltered SELECT). Task 2
    // (docs/superpowers/plans/2026-08-06-phase1c-evidence-and-pinning.md,
    // Task 2 Step 7) inserts a second row ('fv_bogus') with `ON CONFLICT DO
    // NOTHING`, and `resetDb()` (../helpers/db.ts) deliberately excludes
    // `framework_versions` from its TRUNCATE list (this same Task 1 commit),
    // so an unfiltered/exact-cardinality assertion here is still the wrong
    // choice even though it is no longer permanently wrong the way this
    // comment originally said: Task 2 fix round 2 (2026-08-08) paired that
    // INSERT with an `afterEach` -> `deleteMany('fv_bogus')` in
    // framework-hash.test.ts, so the row is normally gone by the time any
    // other test file runs. It can still exist TRANSIENTLY while that
    // describe block is mid-run, or persist if a run crashes before its
    // `afterEach` fires -- an unfiltered assertion here would be flaky on
    // run ORDER and process health, for a reason unrelated to what this
    // test exists to prove, which the `WHERE "id" = 'fv_3_0_0'` filter below
    // avoids entirely regardless of any of that.
    const rows = await testDb.$queryRaw<Array<{ id: string; semver: string; contentHash: string }>>`
      SELECT "id", "semver", "contentHash" FROM "framework_versions" WHERE "id" = 'fv_3_0_0'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'fv_3_0_0',
      semver: '3.0.0',
      contentHash: '7c343b7d25eee2dc02dcfa836f73c705451ea9d67453894b0bb0ef067af21b39',
    });
  });

  it('grants makrai_app SELECT and nothing else (O-5)', async () => {
    const privs = await testDb.$queryRaw<Array<{ privilege_type: string }>>`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE table_name = 'framework_versions' AND grantee = 'makrai_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p.privilege_type)).toEqual(['SELECT']);
  });

  it('has no RLS, because it is not tenant data', async () => {
    const [t] = await testDb.$queryRaw<Array<{ relrowsecurity: boolean }>>`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'framework_versions'`;
    expect(t.relrowsecurity).toBe(false);
  });
});

/**
 * Task review, fix round 3, Important 1 (2026-08-08). O-3's ONLY proof
 * anywhere was a one-time manual `docker exec psql` transcript in the
 * report -- nothing in `__tests__/` attempted to change `frameworkVersionId`
 * on an existing row. A later migration or refactor could silently drop or
 * weaken `trg_assessments_framework_version_write_once`
 * (prisma/migrations/20260807102031_framework_registry_and_pin/migration.sql:73-77)
 * and `npx vitest run` would stay green throughout, exactly the "a test that
 * passes against unguarded code proves nothing" failure this project's own
 * rule (O-5's declarative test, the no-RLS test above) already guards
 * against for the table's OTHER two properties.
 */
describe('trg_assessments_framework_version_write_once (O-3)', () => {
  const OTHER_VERSION_ID = 'fv_o3_trigger_other_version';

  beforeEach(async () => {
    await resetDb();
    // A second, REAL framework_versions row -- framework_versions is
    // deliberately excluded from resetDb()'s truncation, so this is made
    // idempotent (delete-then-create) rather than assumed absent.
    //
    // Using a genuinely valid FK target here, not an arbitrary/nonexistent
    // string, is deliberate and was found necessary live, not guessed:
    // the first draft of this test targeted a bogus id that did not exist
    // in framework_versions at all. Proving this test non-vacuous (dropping
    // the trigger, per the review's own instruction) still failed the
    // UPDATE -- but with the frameworkVersionId FK constraint's error, not
    // the trigger's, because a nonexistent id fails the FK regardless of
    // whether the trigger exists. That is a red for the WRONG reason: it
    // does not prove the trigger is what is protecting this column. Fixed
    // by targeting a second EXISTING row, so the FK check passes and only
    // the trigger (when present) is what can reject the change.
    await testDb.frameworkVersion.deleteMany({ where: { id: OTHER_VERSION_ID } });
    await testDb.frameworkVersion.create({
      data: {
        id: OTHER_VERSION_ID,
        semver: '0.0.1-o3-trigger-other',
        contentHash: 'o3-trigger-other',
        publishedAt: new Date('2020-01-01T00:00:00Z'),
      },
    });
  });

  afterEach(async () => {
    await testDb.frameworkVersion.deleteMany({ where: { id: OTHER_VERSION_ID } });
  });

  it("rejects an UPDATE that changes an existing assessment's frameworkVersionId", async () => {
    const user = await testDb.user.create({
      data: { email: 'o3-trigger@x.org', name: 'o3-trigger', passwordHash: 'x' },
    });
    const org = await testDb.organization.create({
      data: { name: 'o3-trigger', slug: 'o3-trigger' },
    });
    const project = await testDb.project.create({
      data: { orgId: org.id, name: 'o3-trigger project', createdById: user.id },
    });
    const assessment = await testDb.assessment.create({
      data: {
        orgId: org.id,
        projectId: project.id,
        userId: user.id,
        frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID,
        engineState: {} as never,
      },
    });

    // Postgres aborts the WHOLE transaction on any statement error. Without
    // a SAVEPOINT, the expected error from the UPDATE below would leave every
    // later statement in this same transaction -- including the follow-up
    // read that confirms the row is unchanged -- failing with "current
    // transaction is aborted, commands ignored until end of transaction
    // block", which would report the WRONG failure (this project has been
    // bitten by exactly this before). SAVEPOINT / ROLLBACK TO SAVEPOINT lets
    // the transaction keep going after the expected rejection.
    await testDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SAVEPOINT trigger_test');
      await expect(
        tx.$executeRaw`UPDATE "assessments" SET "frameworkVersionId" = ${OTHER_VERSION_ID} WHERE "id" = ${assessment.id}`,
      ).rejects.toThrow(/write-once/i);
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT trigger_test');

      const after = await tx.assessment.findUniqueOrThrow({ where: { id: assessment.id } });
      expect(after.frameworkVersionId).toBe(SEEDED_FRAMEWORK_VERSION_ID);
    });
  });
});

/**
 * Task review, fix round 3, Minor 3 (2026-08-08). The design spec's O-5 says
 * least privilege is "Proven by executing all four [SELECT/INSERT/UPDATE/
 * DELETE] as that role." The declarative test above
 * (information_schema.table_privileges) is real evidence of the GRANT
 * metadata, but a different method than the one the spec names -- and a test
 * that discharges an obligation by a different method than the obligation
 * names is exactly the mismatch this project keeps auditing for. Kept
 * alongside this block rather than replaced: the two prove different things
 * (the GRANT exists in the catalog vs. Postgres actually enforces it), and
 * neither subsumes the other -- a catalog row could in principle exist
 * without matching enforcement, or vice versa.
 *
 * `appClient` (lib/data/tenant.ts) is the production Prisma client already
 * connected as makrai_app via APP_DATABASE_URL -- reused here rather than
 * opening a second ad hoc connection, since it is exactly the role boundary
 * this test needs to cross.
 *
 * Every write attempt below targets a DEDICATED throwaway row
 * (`fv_o5_role_check*`), created and removed via the SUPERUSER `testDb`, not
 * `makrai_app` -- never the real seeded `fv_3_0_0` row every other
 * assessment-creating fixture in this suite depends on. If any assertion
 * below is wrong and a write actually succeeds (the exact bug this test
 * exists to catch), it corrupts a disposable fixture instead of shared
 * fixture data every other test file relies on.
 */
describe('makrai_app can SELECT but not INSERT/UPDATE/DELETE on framework_versions (O-5)', () => {
  const TEST_ROW_ID = 'fv_o5_role_check';
  const TEST_ROW_PREFIX = 'fv_o5_role_check';

  beforeEach(async () => {
    // Idempotent: cleans up any row a previous crashed run left behind
    // before creating a fresh one, so this block does not depend on
    // resetDb() (framework_versions is deliberately excluded from it).
    await testDb.frameworkVersion.deleteMany({ where: { id: { startsWith: TEST_ROW_PREFIX } } });
    await testDb.frameworkVersion.create({
      data: {
        id: TEST_ROW_ID,
        semver: '0.0.1-o5-role-check',
        contentHash: 'o5-role-check',
        publishedAt: new Date('2020-01-01T00:00:00Z'),
      },
    });
  });

  afterEach(async () => {
    await testDb.frameworkVersion.deleteMany({ where: { id: { startsWith: TEST_ROW_PREFIX } } });
  });

  it('SELECT succeeds', async () => {
    const row = await appClient.frameworkVersion.findUnique({ where: { id: TEST_ROW_ID } });
    expect(row?.semver).toBe('0.0.1-o5-role-check');
  });

  it('INSERT is rejected', async () => {
    await expect(
      appClient.frameworkVersion.create({
        data: {
          id: `${TEST_ROW_PREFIX}_insert`,
          semver: '999.0.0-o5-insert-check',
          contentHash: 'x',
          publishedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('UPDATE is rejected', async () => {
    await expect(
      appClient.frameworkVersion.update({
        where: { id: TEST_ROW_ID },
        data: { contentHash: 'attempted-o5-update' },
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('DELETE is rejected', async () => {
    await expect(
      appClient.frameworkVersion.delete({ where: { id: TEST_ROW_ID } }),
    ).rejects.toThrow(/permission denied/i);
  });
});

/**
 * D-148 names `framework_versions`' exclusion from `resetDb()`'s TRUNCATE as
 * a conscious deferral (reference data, not fixture data -- ../helpers/db.ts
 * above), not a licence for rows to accumulate forever. They did anyway:
 * `evidence-upload.test.ts`'s own `fv_bogus_task6` was paired with an
 * `afterAll` cleanup from the start, but `report-provenance.test.ts`
 * (`fv_bogus_task9`, `fv_bogus_task9_samelen`) and `assessments.test.ts`
 * (`fv_bogus_assessments_patch`) inserted their own bogus rows via the same
 * idempotent `ON CONFLICT DO NOTHING` technique WITHOUT copying the cleanup
 * half -- `framework-hash.test.ts:98-132`'s own comment already explains at
 * length why idempotent insertion is not cleanup. Found live: `makrai_test`
 * carried three such rows (`fv_bogus_assessments_patch`,
 * `fv_bogus_task9`, `fv_bogus_task9_samelen`) with no test anywhere
 * checking for it, which is precisely the "generate it, don't hand-write
 * it" gap AGENTS.md §3 and §0.4 name -- a hand-maintained list of "the
 * bogus ids currently known to exist" would need editing every time a new
 * test file adopted the same technique (or renamed its own id), same as
 * `BUNDLE_FILES` would if generated by hand.
 *
 * The three test files above were given the same afterEach/afterAll
 * cleanup pairing `framework-hash.test.ts` and `evidence-upload.test.ts`
 * already use (delete dependent assessments first -- the FK carries no
 * `onDelete: Cascade`, by design -- then the `framework_versions` row).
 * This test is the mechanism that stops the NEXT one from going
 * unnoticed: it does not know any bogus id by name. It generates the
 * COMPLETE set of ids a migration ever legitimately inserted by reading
 * every `prisma/migrations/*\/migration.sql` file, and asserts the live
 * table contains exactly that set and nothing else. A new test file that
 * copies the `ON CONFLICT DO NOTHING` technique without its cleanup half
 * fails THIS test the next time `npx vitest run` reaches it (file order:
 * `framework-registry.test.ts` runs after `evidence-upload.test.ts` and
 * `assessments.test.ts` alphabetically, and `fileParallelism: false`
 * (vitest.config.ts) means every earlier file's own hooks have already run
 * to completion by then -- so a row surviving to this point is either
 * this run's own genuine leak or an earlier crash, not another file's
 * transient mid-test state).
 */
describe('framework_versions carries no residue beyond what a migration inserted', () => {
  /**
   * Reads every `INSERT INTO "framework_versions"` in
   * `prisma/migrations/*\/migration.sql` and returns the ids it inserts, in
   * migration (directory-name / chronological) order. All three inserts
   * that exist today list `"id"` FIRST in the column list (verified by
   * reading the three migration files directly, not assumed), so the
   * first quoted string literal inside each matching `VALUES (...)` is the
   * id.
   *
   * A JS-side regex over `readFileSync`'d migration.sql content, not a
   * shelled-out `grep`/`sed` pipeline (`framework-hash.test.ts`'s own
   * `execSync('find ...')` precedent would also have worked) -- chosen
   * here because extracting a captured group from a multi-line SQL
   * statement is simpler and less shell-quoting-fragile as a JS regex than
   * as a `sed` expression, and this function's own output is asserted
   * non-empty below rather than trusted blindly.
   *
   * NOT the same "runtime-generated list" the coordinator rejected for
   * `BUNDLE_FILES` (bundleHash.ts:29-45) -- that ruling is about
   * PRODUCTION code computing its own file list at build/runtime, where a
   * silently-incomplete trace would silently narrow the list. This runs
   * only inside a TEST, reads migration files that ship with the repo
   * (not anything Turbopack traces into a standalone build), and its
   * whole purpose is to CATCH a live table diverging from what migrations
   * say it should contain -- the opposite failure mode, not the same one.
   */
  function migrationSeededFrameworkVersionIds(): string[] {
    const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const ids: string[] = [];
    for (const dir of dirs) {
      const sqlPath = join(migrationsDir, dir, 'migration.sql');
      const sql = readFileSync(sqlPath, 'utf8');
      const insertRe = /INSERT INTO "framework_versions"[^;]*?VALUES\s*\(\s*'([^']+)'/g;
      let match: RegExpExecArray | null;
      while ((match = insertRe.exec(sql)) !== null) {
        ids.push(match[1]);
      }
    }
    return ids;
  }

  it('migrationSeededFrameworkVersionIds() finds every migration-inserted id -- non-vacuity check', () => {
    // If this file's regex ever stops matching (a migration.sql format
    // change, a typo introduced here), the main test below would pass
    // VACUOUSLY: an empty expected set trivially "contains" whatever the
    // live table holds. Pinned against the three ids read directly out of
    // the migration files above (framework-hash.test.ts's own golden-value
    // test pins 'fv_4_0_0' the same way, for the same reason).
    expect(migrationSeededFrameworkVersionIds()).toEqual(['fv_3_0_0', 'fv_3_0_1', 'fv_4_0_0']);
  });

  it('the live id set is exactly the ids a migration INSERTed -- no leftover test row', async () => {
    const expectedIds = migrationSeededFrameworkVersionIds();
    const rows = await testDb.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "framework_versions"`;
    const liveIds = rows.map((r) => r.id).sort();
    expect(
      liveIds,
      'framework_versions holds an id no migration inserted. resetDb() deliberately ' +
        'excludes this table from its TRUNCATE (reference data, D-148), so a test that ' +
        'inserts a bogus row (the fv_bogus* / ON CONFLICT DO NOTHING technique several ' +
        'integration suites use) must also delete it -- assessments referencing it ' +
        'first, then the row itself (no onDelete: Cascade, by design). Find the culprit ' +
        'with: grep -rn \'INSERT INTO "framework_versions"\' __tests__/, add the ' +
        'afterEach/afterAll pairing framework-hash.test.ts and evidence-upload.test.ts ' +
        'already use, and delete the stray row from makrai_test directly.',
    ).toEqual([...expectedIds].sort());
  });
});
