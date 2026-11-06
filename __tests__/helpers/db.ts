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
 *
 * v0.6.0 (NFR-INT-01, obligation S15): every append-only table carries
 * refusal triggers on `record_refuse_change()` that refuse TRUNCATE for every
 * role, the owner included, and fire in replica mode. So the reset finds those
 * triggers in pg_catalog (on every truncated table, not from a hand list),
 * disables them, truncates, and re-enables them `ENABLE ALWAYS`, all in ONE
 * transaction as the test owner role: if the TRUNCATE fails, the disables roll
 * back with it and every refusal trigger is still in mode `A`
 * (`__tests__/integration/v060-reset-db.test.ts` pins both). No setting, GUC or
 * function skips a refusal trigger; this helper exists only under `__tests__`.
 * `lock_timeout` bounds the wait behind another session's lock, so a held lock
 * fails the reset instead of hanging the suite.
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
  const names = tables.map((t) => t.tablename);
  const refusal = await testDb.$queryRaw<{ table: string; trigger: string; mode: string }[]>`
    SELECT c.relname::text AS "table", t.tgname::text AS "trigger", t.tgenabled::text AS "mode"
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
      AND p.proname = 'record_refuse_change'
      AND c.relname = ANY (${names}::text[])
    ORDER BY 1, 2`;
  // Every refusal trigger is ENABLE ALWAYS by migration; the reset restores exactly that, so it
  // refuses to run over one in another mode instead of silently setting it back to A.
  const notAlways = refusal.filter((r) => r.mode !== 'A');
  if (notAlways.length > 0) {
    throw new Error(`resetDb: refusal trigger(s) not ENABLE ALWAYS: ${notAlways.map((r) => `${r.table}.${r.trigger} (mode ${r.mode})`).join(', ')}`);
  }
  const list = names.map((t) => `"${t}"`).join(', ');
  await testDb.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
      for (const r of refusal) await tx.$executeRawUnsafe(`ALTER TABLE "${r.table}" DISABLE TRIGGER "${r.trigger}"`);
      await tx.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
      for (const r of refusal) await tx.$executeRawUnsafe(`ALTER TABLE "${r.table}" ENABLE ALWAYS TRIGGER "${r.trigger}"`);
    },
    { timeout: 60_000 },
  );
}
