import { describe, it, expect } from 'vitest';
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
import { testDb } from '../helpers/db';

describe('framework_versions registry', () => {
  it('carries the seeded 3.0.0 row created by the migration, not by seed.ts', async () => {
    // Filtered by id, not asserted as the table's only row (the brief's
    // literal form used `toHaveLength(1)` over an unfiltered SELECT). Task 2
    // (docs/superpowers/plans/2026-08-06-phase1c-evidence-and-pinning.md,
    // Task 2 Step 7) inserts a second row ('fv_bogus') with `ON CONFLICT DO
    // NOTHING` and no matching DELETE, and `resetDb()` (../helpers/db.ts) now
    // deliberately excludes `framework_versions` from its TRUNCATE list
    // (this same Task 1 commit) so that row -- once Task 2 lands -- persists
    // across every future test run on this database. An exact-cardinality
    // assertion here would then fail permanently for a reason unrelated to
    // what this test exists to prove.
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
