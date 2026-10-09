import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

export const testDb = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL })),
});

/**
 * The CURRENTLY PUBLISHED `framework_versions` row, and every fixture's
 * default choice for `Assessment.frameworkVersionId`. Plan 1c Task 1 seeded
 * `fv_3_0_0`; the 2026-08-18 content corrections deprecated it and published
 * `fv_3_0_1` in its place, and the 2026-08-27 weight flatten deprecated that
 * and published `fv_4_0_0` -- which is exactly the one-line edit this constant
 * was extracted to make possible. Exported here — not repeated as a
 * literal at each of the 8+ call sites that need SOME valid id to satisfy
 * the FK (cross-tenant isolation, PATCH provenance, the permission matrix,
 * etc.) — so a future change to which version is seeded is a one-line edit
 * instead of a grep-and-replace across every integration test file
 * (simplify-pass finding, corroborated independently by two review angles:
 * reuse and simplification both flagged the un-deduplicated literal).
 *
 * `__tests__/integration/framework-registry.test.ts` deliberately does NOT
 * import this constant for its own "the migration seeded fv_3_0_0"
 * assertions — that test exists to pin the migration's actual output, and a
 * golden-value test that imported its own expected value from the same
 * place the implementation could drift from would stop catching that drift.
 */
export const SEEDED_FRAMEWORK_VERSION_ID = 'fv_4_0_0';

/**
 * TRUNCATEs every public table, EXCEPT the ones that are not per-test fixture
 * data. Guarded by the database's OWN name rather than by the URL string:
 * importing this helper outside the vitest runner would otherwise inherit
 * .env's DATABASE_URL and wipe the dev database.
 *
 * `framework_versions` (Plan 1c Task 1) excluded alongside `_prisma_migrations`
 * for the same reason: it is REFERENCE data inserted once by a migration, not
 * fixture data scoped to one test. Found live: with it left in the truncate
 * list, the FIRST test file whose `beforeEach` calls `resetDb()` deletes the
 * `fv_3_0_0` row, and every `Assessment` created by any LATER test in the same
 * `vitest run` then fails `assessments_frameworkVersionId_fkey` — invisible
 * running `framework-registry.test.ts` alone (it never calls `resetDb()`),
 * and only visible running the full suite, which is exactly why this class of
 * defect is dangerous (AGENTS.md §3: composing tests broke what an isolated
 * one did not exercise).
 *
 * `integrity_log` (ADR-0010) cannot be truncated at all: its trigger refuses
 * TRUNCATE for every role, and one refused table fails the whole statement.
 * Its rows accumulate across runs by design; integrity-log.test.ts checks the
 * whole chain, so it does not assume an empty table.
 *
 * HONEST LIMIT: this is a hand-maintained three-item exclusion list, exactly
 * the shape AGENTS.md §3 warns "is a latent defect with a timestamp on it"
 * when a list must be complete. The decision to leave it hand-maintained
 * rather than generalise it, and why, is recorded in
 * docs/DEFERRED_REGISTER.md as D-148 (fix round 3, 2026-08-08) — a
 * conscious deferral belongs in the register, not only in a comment
 * (AGENTS.md §6), so this comment states the fact and D-148 carries the
 * full reasoning and pick-up trigger.
 */
export async function resetDb(): Promise<void> {
  const [{ current_database: db }] =
    await testDb.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
  if (db !== 'makrai_test') {
    throw new Error(`Refusing to reset database "${db}" — resetDb() only runs against makrai_test`);
  }
  const tables = await testDb.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('_prisma_migrations', 'framework_versions', 'integrity_log')`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await testDb.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Runs `fn` with the seeded `framework_versions` row's `contentHash` set to a
 * value that is NOT the running bundle's, then restores it.
 *
 * This is the only way to make `resolveFramework(...).matches` /
 * `resolveCurrentFramework(...).matches` false for the CURRENT content
 * version: `RUNNING_BUNDLE_HASH` is computed once at module load from the
 * real `data/*.json` files (`lib/framework/bundleHash.ts`), so the row is the
 * only side of the comparison a test can move. It reproduces the real drift
 * condition exactly -- someone edited the content files without bumping
 * `meta.version`, so the registry row's recorded hash no longer describes
 * what is deployed.
 *
 * Distinct from the `fv_bogus*` rows several suites insert: those give an
 * assessment a MISPINNED version to read back, which is the right fixture for
 * a guard on an EXISTING assessment. This one moves the version the deployed
 * content itself resolves to, which is the only fixture that can reach a
 * CREATION-time guard, since creation has no assessment to mispin yet.
 *
 * Extracted here (C6 fix wave) after the identical mutate-run-restore block
 * was written twice, in `__tests__/integration/assessments.test.ts` and
 * `__tests__/integration/framework-current-version.test.ts`.
 *
 * The `finally` is load-bearing, not defensive: `resetDb()` deliberately does
 * NOT truncate `framework_versions` (see its own comment above), so a
 * mutation left behind here corrupts every later test in the same run.
 */
export async function withDriftedFrameworkContent<T>(fn: () => Promise<T>): Promise<T> {
  const before = await testDb.frameworkVersion.findUniqueOrThrow({
    where: { id: SEEDED_FRAMEWORK_VERSION_ID },
    select: { contentHash: true },
  });
  await testDb.frameworkVersion.update({
    where: { id: SEEDED_FRAMEWORK_VERSION_ID },
    data: { contentHash: 'f'.repeat(64) },
  });
  try {
    return await fn();
  } finally {
    await testDb.frameworkVersion.update({
      where: { id: SEEDED_FRAMEWORK_VERSION_ID },
      data: { contentHash: before.contentHash },
    });
  }
}
