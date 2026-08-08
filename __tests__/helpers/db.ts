import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

export const testDb = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL })),
});

/**
 * The one `framework_versions` row the Plan 1c Task 1 migration seeds, and
 * every fixture's only valid choice for `Assessment.frameworkVersionId`
 * until a second version is registered. Exported here — not repeated as a
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
export const SEEDED_FRAMEWORK_VERSION_ID = 'fv_3_0_0';

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
 * HONEST LIMIT: this is a hand-maintained two-item exclusion list, exactly
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
      AND tablename NOT IN ('_prisma_migrations', 'framework_versions')`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await testDb.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
