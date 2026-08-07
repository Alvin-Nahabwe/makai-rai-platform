# Plan 1c — Evidence Attachment and Framework Pinning: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make two claims the product currently asserts without support verifiable — "we have evidence for this" and "this was assessed against framework version X".

**Architecture:** A global `framework_versions` registry (the first table that is neither tenant data nor identity data) pins every assessment to a content version whose hash is checked at build time and at runtime. Evidence is user-uploaded bytes stored as `bytea` in a tenant table split metadata-from-blob, attached to either an assessment response or a remediation item, isolated by RLS exactly as every other tenant table is.

**Tech Stack:** Next.js 16.2.9 (App Router, `proxy.ts` not `middleware.ts`), Prisma 7.8 + `@prisma/adapter-pg`, next-auth 5.0.0-beta (Credentials only, JWT strategy forced), PostgreSQL 16 with RLS + FORCE, vitest (`fileParallelism: false`), Playwright.

**Source of truth:** `docs/superpowers/specs/2026-08-06-phase1c-evidence-and-pinning-design.md`. Obligation numbers (O-1 … O-24) refer to spec §6.

## Global Constraints

Every task's requirements implicitly include this section.

- **Tenant data goes through `withOrg(ctx, cb)` only** (`lib/data/tenant.ts`). Non-tenant data goes through `identityDb` (`lib/data/identity.ts`). App code may not import `lib/db` or `lib/auth` — ESLint enforces this and `__tests__/lint/effective-config.test.ts` pins the resolved config.
- **The application never re-filters by `orgId`.** RLS owns isolation (ADR-0001). A redundant application filter masks the misconfiguration RLS fails by.
- **Identifiers are quoted camelCase TEXT.** No `::uuid` casts anywhere.
- **Migrations run as superuser** (`CREATE EVENT TRIGGER` is superuser-only, D-079) and must be applied to **both** `makrai` and `makrai_test`.
- **Every guard is proven non-vacuous** by reverting it and watching the test go red. A test that passes against unguarded code proves nothing.
- **Where a list must be complete, generate it from disk** rather than writing it.
- **`ALTER DEFAULT PRIVILEGES` has revoked everything for `makrai_app` on new tables** (`prisma/migrations/20260803140500_…/migration.sql:27-28`). Every new table needs an explicit `GRANT`, and the grant must be the narrowest one that works.
- **The DDL guard auto-enables RLS + FORCE on any new table carrying an `orgId` column** and creates **no policy** (`prisma/migrations/20260803074244_…/migration.sql:135-147`). A tenant table without its `org_isolation` policy denies everything — fail-closed, and it looks like a bug, so write the policy in the same migration.
- **Org roles are exactly:** `owner`, `admin`, `assessor`, `reviewer`, `viewer`.
- **Postgres aborts a transaction on any statement error.** Any psql verification that expects an error must wrap it in `SAVEPOINT` / `ROLLBACK TO SAVEPOINT`, or every subsequent statement reports `current transaction is aborted`.
- **The content-bundle hash for framework 3.0.0 is:**
  `7c343b7d25eee2dc02dcfa836f73c705451ea9d67453894b0bb0ef067af21b39`
  Computed 2026-08-06 over the four files in `data/`. Do not retype it; Task 2 regenerates it from disk and the test compares.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/data/framework.ts` | **Create.** Resolve the pinned version, expose `contentHash`, compare against the on-disk bundle. Lives under `lib/data/**` because that glob is the ESLint exemption for `lib/db` imports (`eslint.config.mjs:184`) — a module elsewhere would be banned from reading its own table. |
| `lib/framework/bundleHash.ts` | **Create.** Pure: hash the content files. No database, no imports from `lib/data`. Separate from the above so the build-time test can use it with no DB. |
| `lib/evidence/inspect.ts` | **Create.** Pure: decide what these bytes are and whether that is allowed. No storage, no auth, no tenancy. |
| `lib/data/evidence.ts` | **Create.** Tenant-scoped evidence CRUD, exclusively through `withOrg`. |
| `app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts` | **Create.** `POST` (upload), `GET` (list for an assessment). |
| `app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts` | **Create.** `GET` (download bytes), `DELETE`. |
| `lib/authz/policy.ts` | **Modify.** Three new `Action`s and their grants. |
| `lib/authz/routeActions.ts` | **Modify.** Entries for the two new route files — this file is already the single source of truth O-17 requires. |
| `prisma/schema.prisma` | **Modify.** `FrameworkVersion`, `Evidence`, `EvidenceBlob`, `Assessment.frameworkVersionId`; drop `RemediationItem.artifactPath`. |
| `components/report/useFindingsData.ts` | **Rename** from `useEvidenceData.ts`. "Evidence" means artifacts from this phase on. |

---

## Task 1: The registry table, the pin, and least privilege

Creates the first non-tenant, non-identity table in the system, pins every assessment to it, and makes the pin write-once in the database.

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_framework_registry_and_pin/migration.sql`
- Create: `lib/data/framework.ts`
- Create: `__tests__/integration/framework-registry.test.ts`
- Modify: `__tests__/lint/effective-config.test.ts`

**Interfaces:**
- Produces: `getPinnedVersion(assessmentId: string, tx: TenantTx): Promise<{ id: string; semver: string; contentHash: string }>` from `lib/data/framework.ts`. Task 2 and Task 9 consume it.
- Produces: the registry row id `'fv_3_0_0'`. Tasks 3 and 6 reference it.

- [ ] **Step 1: Confirm the module placement against the RESOLVED ESLint config**

This is a pre-flight check, not a formality: `lib/data/**` is exempted from the `lib/db` import ban, and a module placed anywhere else cannot read its own table.

Run:
```bash
npx eslint --print-config lib/data/framework.ts | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const c=JSON.parse(s);
  const r=c.rules['no-restricted-imports'];
  console.log('no-restricted-imports for lib/data/framework.ts:', JSON.stringify(r).slice(0,200));
});"
```
Expected: the rule is present but its patterns do **not** ban `@/lib/db`. If they do, STOP and report — the file must not be created outside the exemption.

- [ ] **Step 2: Write the failing test**

Create `__tests__/integration/framework-registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { identityDb } from '@/lib/data/identity';

describe('framework_versions registry', () => {
  it('carries the seeded 3.0.0 row created by the migration, not by seed.ts', async () => {
    const rows = await identityDb.$queryRaw<Array<{ id: string; semver: string; contentHash: string }>>`
      SELECT "id", "semver", "contentHash" FROM "framework_versions" ORDER BY "semver"`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'fv_3_0_0',
      semver: '3.0.0',
      contentHash: '7c343b7d25eee2dc02dcfa836f73c705451ea9d67453894b0bb0ef067af21b39',
    });
  });

  it('grants makrai_app SELECT and nothing else (O-5)', async () => {
    const privs = await identityDb.$queryRaw<Array<{ privilege_type: string }>>`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE table_name = 'framework_versions' AND grantee = 'makrai_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p.privilege_type)).toEqual(['SELECT']);
  });

  it('has no RLS, because it is not tenant data', async () => {
    const [t] = await identityDb.$queryRaw<Array<{ relrowsecurity: boolean }>>`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'framework_versions'`;
    expect(t.relrowsecurity).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run __tests__/integration/framework-registry.test.ts`
Expected: FAIL — `relation "framework_versions" does not exist`.

- [ ] **Step 4: Add the Prisma models**

In `prisma/schema.prisma`, add:

```prisma
model FrameworkVersion {
  id          String       @id
  semver      String       @unique
  contentHash String
  publishedAt DateTime     @db.Timestamptz(3)
  status      String       @default("published")
  createdAt   DateTime     @default(now()) @db.Timestamptz(3)

  assessments Assessment[]

  @@map("framework_versions")
}
```

And on `model Assessment`, add these two lines after `mode`:

```prisma
  frameworkVersionId String
  frameworkVersion   FrameworkVersion @relation(fields: [frameworkVersionId], references: [id])
```

and add to its attribute block:

```prisma
  @@index([frameworkVersionId])
```

- [ ] **Step 5: Write the migration by hand**

`prisma migrate dev` will not produce the reference-data insert or the trigger. Create the directory and write `migration.sql` yourself:

```bash
mkdir -p "prisma/migrations/$(date -u +%Y%m%d%H%M%S)_framework_registry_and_pin"
```

```sql
-- Plan 1c Task 1. Creates the registry, pins every assessment to it, and makes
-- the pin write-once. Ordering is expand -> backfill -> constrain; the registry
-- row is REFERENCE DATA and belongs here, not in prisma/seed.ts, which is a
-- standalone script the test harness never invokes (spec O-21).

-- No "orgId" column, so the DDL guard does not touch this table and no RLS is
-- enabled. That is correct: framework content is global, not tenant data.
CREATE TABLE "framework_versions" (
  "id"          TEXT PRIMARY KEY,
  "semver"      TEXT NOT NULL UNIQUE,
  "contentHash" TEXT NOT NULL,
  "publishedAt" TIMESTAMPTZ(3) NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'published',
  "createdAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "framework_versions_status_check"
    CHECK ("status" IN ('published', 'deprecated'))
);

INSERT INTO "framework_versions" ("id", "semver", "contentHash", "publishedAt")
VALUES (
  'fv_3_0_0',
  '3.0.0',
  '7c343b7d25eee2dc02dcfa836f73c705451ea9d67453894b0bb0ef067af21b39',
  '2026-05-23T00:00:00Z'
);

-- ALTER DEFAULT PRIVILEGES revoked everything for makrai_app on new tables, so
-- nothing here is implicit. SELECT is granted for exactly one reason: the report
-- renders the provenance line. Verified by spike 2026-08-06 that referential
-- integrity does NOT require it -- RI checks run with the referenced table's
-- rights -- so if the display requirement ever goes away, this grant goes too.
GRANT SELECT ON "framework_versions" TO makrai_app;

-- expand
ALTER TABLE "assessments" ADD COLUMN "frameworkVersionId" TEXT;

-- backfill
UPDATE "assessments" SET "frameworkVersionId" = 'fv_3_0_0'
WHERE "frameworkVersionId" IS NULL;

-- constrain
ALTER TABLE "assessments" ALTER COLUMN "frameworkVersionId" SET NOT NULL;
ALTER TABLE "assessments"
  ADD CONSTRAINT "assessments_frameworkVersionId_fkey"
  FOREIGN KEY ("frameworkVersionId") REFERENCES "framework_versions"("id");

-- Postgres does not index foreign keys automatically.
CREATE INDEX "assessments_frameworkVersionId_idx"
  ON "assessments" ("frameworkVersionId");

-- O-3: the pin is write-once, enforced here rather than in application code.
-- BEFORE UPDATE OF narrows to statements that mention the column; the WHEN
-- clause narrows further to statements that actually change it, so an ordinary
-- assessment update is untouched.
CREATE OR REPLACE FUNCTION reject_framework_version_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'assessments.frameworkVersionId is write-once (Plan 1c O-3)'
    USING HINT = 'An assessment records the framework version it was answered '
                 'against. Changing it would rewrite history silently.';
END $$;

DROP TRIGGER IF EXISTS trg_assessments_framework_version_write_once ON "assessments";
CREATE TRIGGER trg_assessments_framework_version_write_once
  BEFORE UPDATE OF "frameworkVersionId" ON "assessments"
  FOR EACH ROW
  WHEN (OLD."frameworkVersionId" IS DISTINCT FROM NEW."frameworkVersionId")
  EXECUTE FUNCTION reject_framework_version_change();
```

- [ ] **Step 6: Apply to both databases and regenerate the client**

```bash
npx prisma migrate deploy
DATABASE_URL="postgresql://makrai:makrai_dev_password@localhost:5432/makrai_test" npx prisma migrate deploy
npx prisma generate
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run __tests__/integration/framework-registry.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 8: Prove the write-once trigger fires (O-3), with savepoints**

```bash
docker exec -i docker-postgres-1 psql -U makrai -d makrai <<'SQL'
BEGIN;
SAVEPOINT s1;
UPDATE "assessments" SET "frameworkVersionId" = 'fv_3_0_0' WHERE true;
ROLLBACK TO s1;
SAVEPOINT s2;
UPDATE "assessments" SET "status" = "status" WHERE true;
ROLLBACK TO s2;
ROLLBACK;
SQL
```
Expected: the first `UPDATE` reports `UPDATE n` (same value, `IS DISTINCT FROM` is false, trigger does not fire); the second reports `UPDATE n` (column not mentioned). Then confirm a real change is rejected:

```bash
docker exec -i docker-postgres-1 psql -U makrai -d makrai -c \
  "BEGIN; UPDATE \"assessments\" SET \"frameworkVersionId\" = 'nope'; ROLLBACK;"
```
Expected: `ERROR: assessments.frameworkVersionId is write-once (Plan 1c O-3)`.

- [ ] **Step 9: Add `lib/data/framework.ts`**

```ts
import type { TenantTx } from '@/lib/data/tenant';

export type PinnedVersion = {
  id: string;
  semver: string;
  contentHash: string;
};

/**
 * The pinned framework version for one assessment.
 *
 * Runs inside a withOrg transaction: `assessments` is RLS-protected, so the
 * assessment lookup is tenant-filtered by the GUC. `framework_versions` is
 * NOT tenant data and has no RLS -- makrai_app holds SELECT on it for exactly
 * this read (the report's provenance line).
 */
export async function getPinnedVersion(
  assessmentId: string,
  tx: TenantTx,
): Promise<PinnedVersion | null> {
  const row = await tx.assessment.findUnique({
    where: { id: assessmentId },
    select: {
      frameworkVersion: { select: { id: true, semver: true, contentHash: true } },
    },
  });
  return row?.frameworkVersion ?? null;
}
```

- [ ] **Step 10: Pin the ESLint result so the placement cannot silently regress**

Append to `__tests__/lint/effective-config.test.ts`, inside the existing describe block:

```ts
it('lib/data/framework.ts may import lib/db (it is inside the lib/data exemption)', async () => {
  const cfg = await resolveConfigFor('lib/data/framework.ts');
  const patterns = JSON.stringify(cfg.rules?.['no-restricted-imports'] ?? {});
  expect(patterns).not.toContain('@/lib/db');
});
```

Use whatever helper the file already defines for resolving a config; do not invent a second mechanism.

- [ ] **Step 11: Run the full suite**

Run: `npx vitest run`
Expected: all green. Any assessment-creating test that now fails on a missing `frameworkVersionId` is Task 6's problem only if it is an API test; a direct `prisma.assessment.create` in a fixture needs the field added here.

- [ ] **Step 12: Commit**

```bash
git add prisma/schema.prisma prisma/migrations lib/data/framework.ts \
        __tests__/integration/framework-registry.test.ts __tests__/lint/effective-config.test.ts
git commit -m "feat(1c): framework_versions registry, write-once pin, least privilege (O-3, O-5, O-21)"
```

---

## Task 2: The content hash, checked at build time and at runtime

Makes the pin mean something. Without this task the pin is a stored claim nothing verifies — the exact defect (`engineState.version`) this plan exists to fix.

**Files:**
- Create: `lib/framework/bundleHash.ts`
- Modify: `lib/data/framework.ts`
- Create: `__tests__/integration/framework-hash.test.ts`

**Interfaces:**
- Consumes: `getPinnedVersion` from Task 1.
- Produces: `computeBundleHash(): string` from `lib/framework/bundleHash.ts`; `resolveFramework(assessmentId, tx): Promise<FrameworkResolution>` from `lib/data/framework.ts`, where
  `type FrameworkResolution = { pinned: PinnedVersion; matches: boolean }`. Tasks 6 and 9 consume it.

- [ ] **Step 1: Write the failing test**

Create `__tests__/integration/framework-hash.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeBundleHash, BUNDLE_FILES } from '@/lib/framework/bundleHash';
import { identityDb } from '@/lib/data/identity';

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
    const [row] = await identityDb.$queryRaw<Array<{ contentHash: string }>>`
      SELECT "contentHash" FROM "framework_versions" WHERE "semver" = '3.0.0'`;
    expect(computeBundleHash()).toBe(row.contentHash);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/integration/framework-hash.test.ts`
Expected: FAIL — cannot resolve `@/lib/framework/bundleHash`.

- [ ] **Step 3: Implement the hash**

Create `lib/framework/bundleHash.ts`:

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The framework content files, in a fixed order. Hashing the BYTES on disk
 * rather than a canonicalised parse is deliberate: it removes every JSON
 * canonicalisation subtlety (key order, whitespace, unicode escapes) at the
 * price of treating a reformat as a content change. That price is the right
 * one -- a reformat failing loudly in CI is better than a content change
 * passing silently, and git is the immutability layer here (spec section 1,
 * decision 3).
 *
 * data/constants.ts is deliberately EXCLUDED: it is code (rating labels),
 * not framework content, and including it would couple the content version
 * to unrelated refactors.
 */
export const BUNDLE_FILES = [
  'data/assessmentAreas.json',
  'data/projectConfig.json',
  'data/questionBank.json',
  'data/scoringConfig.json',
] as const;

export function computeBundleHash(root = process.cwd()): string {
  const parts = BUNDLE_FILES.map((f) => {
    const digest = createHash('sha256').update(readFileSync(join(root, f))).digest('hex');
    return `${f}:${digest}`;
  });
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run __tests__/integration/framework-hash.test.ts`
Expected: PASS, 2 tests. The second asserts `7c343b…f21b39` indirectly through the registry row.

- [ ] **Step 5: Prove the test is non-vacuous**

Append a byte to a content file, run the test, confirm it goes red, then restore:

```bash
printf ' ' >> data/projectConfig.json
npx vitest run __tests__/integration/framework-hash.test.ts   # expect FAIL
git checkout data/projectConfig.json
npx vitest run __tests__/integration/framework-hash.test.ts   # expect PASS
```
Expected: FAIL then PASS. Record both outputs in the task report — a hash test that cannot go red is decoration.

- [ ] **Step 6: Add the runtime resolution**

Append to `lib/data/framework.ts`:

```ts
import { computeBundleHash } from '@/lib/framework/bundleHash';

/**
 * Computed once at module load. The content files are static imports in every
 * other consumer, so they cannot change under a running process.
 */
const RUNNING_BUNDLE_HASH = computeBundleHash();

export type FrameworkResolution = {
  pinned: PinnedVersion;
  /** false when the deployed content does not match what this assessment pinned. */
  matches: boolean;
};

export async function resolveFramework(
  assessmentId: string,
  tx: TenantTx,
): Promise<FrameworkResolution | null> {
  const pinned = await getPinnedVersion(assessmentId, tx);
  if (!pinned) return null;
  return { pinned, matches: pinned.contentHash === RUNNING_BUNDLE_HASH };
}
```

- [ ] **Step 7: Write the mismatch test (O-14, first half)**

Append to `__tests__/integration/framework-hash.test.ts`:

```ts
it('reports a mismatch when the pinned hash differs from the running bundle', async () => {
  const { buildTwoOrgFixture } = await import('@/__tests__/helpers/fixture');
  const { resolveFramework } = await import('@/lib/data/framework');
  const { withOrg, createOrgContext } = await import('@/lib/data/tenant');
  const { createAssessment } = await import('@/lib/engine/AssessmentEngine.js');

  const fx = await buildTwoOrgFixture();

  // A second registry row with a deliberately wrong hash. The migration's own
  // row is correct by construction, so this is the only way to produce a
  // mismatch. framework_versions is not tenant data, so it is written on the
  // identity connection.
  await identityDb.$executeRaw`
    INSERT INTO "framework_versions" ("id","semver","contentHash","publishedAt")
    VALUES ('fv_bogus','9.9.9','0000000000000000000000000000000000000000000000000000000000000000', now())
    ON CONFLICT ("id") DO NOTHING`;

  const ctx = createOrgContext(fx.orgA.id, 'owner');
  const res = await withOrg(ctx, async (tx) => {
    // A NEW assessment pinned to the bogus row at creation. Do NOT update an
    // existing assessment's pin: Task 1's write-once trigger rejects that, and
    // the trigger is a control this plan installs, never something a test
    // works around.
    const project = await tx.project.findFirstOrThrow({ select: { id: true } });
    const created = await tx.assessment.create({
      data: {
        orgId: fx.orgA.id,
        projectId: project.id,
        userId: fx.orgA.usersByRole.owner[0].id,
        frameworkVersionId: 'fv_bogus',
        engineState: createAssessment(),
      },
      select: { id: true },
    });
    return resolveFramework(created.id, tx);
  });

  expect(res?.pinned.semver).toBe('9.9.9');
  expect(res?.matches).toBe(false);
});
```

Check the exact fixture accessor for a user id against `__tests__/helpers/fixture.ts` before writing this — `FixtureOrg` and `TwoOrgFixture` are defined at lines 52-54 and the role-indexed shape is whatever `buildTwoOrgFixture()` actually returns. Do not guess it.

- [ ] **Step 8: Run and commit**

Run: `npx vitest run __tests__/integration/framework-hash.test.ts`
Expected: PASS, 3 tests.

```bash
git add lib/framework/bundleHash.ts lib/data/framework.ts __tests__/integration/framework-hash.test.ts
git commit -m "feat(1c): content bundle hash, checked at build time and runtime (O-13, O-14)"
```

---

## Task 3: The evidence tables, their policies, and their constraints

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_evidence_tables/migration.sql`
- Create: `__tests__/integration/evidence-schema.test.ts`

**Interfaces:**
- Produces: Prisma models `Evidence` and `EvidenceBlob`; table names `evidence`, `evidence_blobs`. Tasks 6, 7, 8, 9 consume them.

- [ ] **Step 1: Write the failing test**

Create `__tests__/integration/evidence-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { identityDb } from '@/lib/data/identity';

const TENANT_TABLES = ['evidence', 'evidence_blobs'];

describe('evidence schema', () => {
  it.each(TENANT_TABLES)('%s has RLS enabled AND forced', async (t) => {
    const [row] = await identityDb.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, t);
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
  });

  it.each(TENANT_TABLES)('%s has an org_isolation policy with USING and WITH CHECK (O-1)', async (t) => {
    const rows = await identityDb.$queryRawUnsafe<Array<{ policyname: string; qual: string | null; with_check: string | null }>>(
      `SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = $1`, t);
    expect(rows).toHaveLength(1);
    expect(rows[0].policyname).toBe('org_isolation');
    expect(rows[0].qual).not.toBeNull();
    expect(rows[0].with_check).not.toBeNull();
  });

  it('rejects both-null and both-set attach targets (O-2)', async () => {
    await expect(identityDb.$executeRaw`
      INSERT INTO "evidence" ("id","orgId","assessmentId","frameworkVersionId","filename","mimeType","byteSize","sha256")
      VALUES ('x','o','a','fv_3_0_0','f','text/plain',1,'h')`).rejects.toThrow(/attach_target/);
  });

  it('indexes every foreign key column (O-4)', async () => {
    const idx = await identityDb.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'evidence'`;
    const defs = idx.map((i) => i.indexdef).join('\n');
    expect(defs).toMatch(/"assessmentId"/);
    expect(defs).toMatch(/"remediationItemId"/);
    expect(defs).toMatch(/"frameworkVersionId"/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run __tests__/integration/evidence-schema.test.ts`
Expected: FAIL — `evidence` does not exist.

- [ ] **Step 3: Add the Prisma models**

```prisma
model Evidence {
  id                 String           @id @default(uuid())
  orgId              String
  assessmentId       String
  assessment         Assessment       @relation(fields: [orgId, assessmentId], references: [orgId, id], onDelete: Cascade)
  frameworkVersionId String
  frameworkVersion   FrameworkVersion @relation(fields: [frameworkVersionId], references: [id])

  questionId         String?
  remediationItemId  String?
  remediationItem    RemediationItem? @relation(fields: [remediationItemId], references: [id], onDelete: Cascade)

  filename           String
  mimeType           String
  byteSize           Int
  sha256             String
  uploadedById       String?
  uploadedBy         User?            @relation("EvidenceUploadedBy", fields: [uploadedById], references: [id], onDelete: SetNull)
  uploadedAt         DateTime         @default(now()) @db.Timestamptz(3)

  blob               EvidenceBlob?

  @@index([orgId, assessmentId])
  @@index([remediationItemId])
  @@index([frameworkVersionId])
  @@map("evidence")
}

model EvidenceBlob {
  evidenceId String   @id
  evidence   Evidence @relation(fields: [evidenceId], references: [id], onDelete: Cascade)
  orgId      String
  content    Bytes

  @@map("evidence_blobs")
}
```

Add `evidence Evidence[]` to `model Assessment`, `evidence Evidence[]` to `model RemediationItem`, and
`uploadedEvidence Evidence[] @relation("EvidenceUploadedBy")` to `model User`.

- [ ] **Step 4: Write the migration**

```sql
-- Plan 1c Task 3. Both tables carry "orgId", so the DDL guard auto-enables RLS
-- and FORCE on each and creates NO policy -- the policies below are required or
-- the tables deny everything. evidence_blobs carries "orgId" even though it is
-- 1:1 with a row that already has one: the guard keys on the presence of that
-- column, so omitting it would silently exempt the one table holding the actual
-- bytes from tenant isolation entirely.

CREATE TABLE "evidence" (
  "id"                 TEXT PRIMARY KEY,
  "orgId"              TEXT NOT NULL,
  "assessmentId"       TEXT NOT NULL,
  "frameworkVersionId" TEXT NOT NULL REFERENCES "framework_versions"("id"),
  "questionId"         TEXT,
  "remediationItemId"  TEXT REFERENCES "remediation_items"("id") ON DELETE CASCADE,
  "filename"           TEXT NOT NULL,
  "mimeType"           TEXT NOT NULL,
  "byteSize"           INTEGER NOT NULL,
  "sha256"             TEXT NOT NULL,
  "uploadedById"       TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "uploadedAt"         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "evidence_assessment_fkey"
    FOREIGN KEY ("orgId", "assessmentId")
    REFERENCES "assessments"("orgId", "id") ON DELETE CASCADE,
  -- O-2: exactly one attach target. num_nonnulls is the clean Postgres idiom;
  -- a hand-written OR/AND pair gets three-valued logic wrong.
  CONSTRAINT "evidence_attach_target_check"
    CHECK (num_nonnulls("questionId", "remediationItemId") = 1),
  -- O-23: idempotent retry. NULLS NOT DISTINCT is load-bearing -- without it two
  -- rows with a NULL remediationItemId count as distinct and this never fires.
  CONSTRAINT "evidence_dedup_key"
    UNIQUE NULLS NOT DISTINCT ("assessmentId", "sha256", "questionId", "remediationItemId")
);

CREATE TABLE "evidence_blobs" (
  "evidenceId" TEXT PRIMARY KEY REFERENCES "evidence"("id") ON DELETE CASCADE,
  "orgId"      TEXT NOT NULL,
  "content"    BYTEA NOT NULL
);

-- Postgres does not index foreign keys automatically (O-4).
CREATE INDEX "evidence_orgId_assessmentId_idx"  ON "evidence" ("orgId", "assessmentId");
CREATE INDEX "evidence_remediationItemId_idx"   ON "evidence" ("remediationItemId");
CREATE INDEX "evidence_frameworkVersionId_idx"  ON "evidence" ("frameworkVersionId");

-- O-1. Same form as all 7 existing policies: USING and WITH CHECK both present.
CREATE POLICY "org_isolation" ON "evidence"
  USING ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

CREATE POLICY "org_isolation" ON "evidence_blobs"
  USING ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

GRANT SELECT, INSERT, DELETE ON "evidence"       TO makrai_app;
GRANT SELECT, INSERT, DELETE ON "evidence_blobs" TO makrai_app;
```

**Note on the grants:** no `UPDATE`. Evidence is never edited — it is uploaded or deleted. Granting only what the design uses is the whole point of the revoked default privileges.

**Note on `NULLIF`:** copy the exact predicate form used by the existing policies. Check one first with
`docker exec -i docker-postgres-1 psql -U makrai -d makrai -tAc "SELECT qual FROM pg_policies WHERE tablename='assessments'"`
and match it — do not invent a variant.

- [ ] **Step 5: Apply, generate, run**

```bash
npx prisma migrate deploy
DATABASE_URL="postgresql://makrai:makrai_dev_password@localhost:5432/makrai_test" npx prisma migrate deploy
npx prisma generate
npx vitest run __tests__/integration/evidence-schema.test.ts
```
Expected: PASS.

- [ ] **Step 6: Establish the policies' baseline behaviour**

The full non-vacuity proof needs Task 6's cross-org test, which does not exist yet. What this step establishes now is the *mechanism*: that with `FORCE ROW LEVEL SECURITY` and no policy, the table denies rather than leaks.

```bash
docker exec -i docker-postgres-1 psql -U makrai -d makrai <<'SQL'
BEGIN;
-- Fail loudly if there is no assessment to probe with. Without this the INSERT
-- below silently affects 0 rows and BOTH counts come back 0 for the trivial
-- reason that the table is empty -- a check that passes while proving nothing.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "assessments") THEN
    RAISE EXCEPTION 'no assessment exists; seed the dev database before running this probe';
  END IF;
END $$;
INSERT INTO "evidence" ("id","orgId","assessmentId","frameworkVersionId","questionId","filename","mimeType","byteSize","sha256")
  SELECT 'probe', a."orgId", a."id", 'fv_3_0_0', 'Q-PP-01', 'f.pdf', 'application/pdf', 1, 'h'
  FROM "assessments" a LIMIT 1;
SAVEPOINT s1;
SET ROLE makrai_app;
SET LOCAL app.current_org_id = 'definitely-not-a-real-org';
SELECT count(*) AS visible_to_wrong_org FROM "evidence";
RESET ROLE;
ROLLBACK TO s1;
SAVEPOINT s2;
DROP POLICY "org_isolation" ON "evidence";
SET ROLE makrai_app;
SET LOCAL app.current_org_id = 'definitely-not-a-real-org';
SELECT count(*) AS visible_with_no_policy FROM "evidence";
RESET ROLE;
ROLLBACK TO s2;
ROLLBACK;
SQL
```

Expected: **both counts are `0`.** With the policy, the wrong org sees nothing because the predicate excludes it; with no policy at all, `FORCE` means the default deny applies and the owner-role bypass does not — so nothing leaks either way. Record both numbers in the task report. **If `visible_with_no_policy` is greater than 0, stop and report** — that would mean `FORCE` is not in effect and the DDL guard did not do its job.

Task 6 Step 6 carries the real non-vacuity proof, where dropping the policy makes a passing test go red.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations __tests__/integration/evidence-schema.test.ts
git commit -m "feat(1c): evidence tables, RLS policies, attach-target and dedup constraints (O-1, O-2, O-4, O-23)"
```

---

## Task 4: The three permission actions, and the seam to the routes

**Files:**
- Modify: `lib/authz/policy.ts`
- Modify: `lib/authz/routeActions.ts`
- Modify: `__tests__/authz/policy.test.ts`

**Interfaces:**
- Produces: `Action` gains `'evidence:create' | 'evidence:read' | 'evidence:delete'`. Tasks 6 and 7 pass these to `requireOrgContext`.

- [ ] **Step 1: Extend the MATRIX fixture the tests are generated from**

In `__tests__/authz/policy.test.ts`, add three rows to the `MATRIX` fixture:

```ts
  'evidence:read':   ['owner', 'admin', 'assessor', 'reviewer', 'viewer'],
  'evidence:create': ['owner', 'admin', 'assessor'],
  'evidence:delete': ['owner', 'admin', 'assessor'],
```

Rationale to carry into the code comment: `evidence:read` mirrors `assessment:read` because evidence is part of what a reader reads. `evidence:create` and `evidence:delete` mirror `assessment:respond` because uploading and removing evidence are part of answering, and deletion is confined to in-progress assessments by O-24 — so it is not the destructive power it would otherwise be.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/authz/policy.test.ts`
Expected: FAIL — the three actions are not in the `Action` union, so the fixture does not type-check.

- [ ] **Step 3: Add the actions and grants**

In `lib/authz/policy.ts`, add to the `Action` union after `'remediation:update'`:

```ts
  | 'evidence:read' | 'evidence:create' | 'evidence:delete'
```

and to `GRANTS`: append `'evidence:read','evidence:create','evidence:delete'` to `owner`, `admin` and `assessor`; append only `'evidence:read'` to `reviewer` and `viewer`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run __tests__/authz/policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove non-vacuity with a DEMONSTRABLY DIFFERENT action (O-10)**

The obvious swap fails silently here: `evidence:read` has the same grant set as `assessment:read`, `org:read` and `member:read`, so swapping among them changes nothing and the check passes while proving nothing. Use these partners, chosen because their grant sets differ:

| Action under test | Grants | Swap partner | Partner grants | Cells that must flip |
|---|---|---|---|---|
| `evidence:read` | 5 roles | `assessment:respond` | 3 roles | `reviewer`, `viewer` |
| `evidence:create` | 3 roles | `assessment:read` | 5 roles | `reviewer`, `viewer` |
| `evidence:delete` | 3 roles | `member:invite` | owner, admin | `assessor` |

For each row: temporarily change the `MATRIX` fixture entry to the partner's grant list, run the test, confirm exactly the named cells fail, restore. Record the failing cell counts in the task report.

- [ ] **Step 6: Do NOT touch `lib/authz/routeActions.ts` in this task**

The declarations belong with the route files, and they are added by Task 6 (upload/list) and Task 7 (download/delete). Verified 2026-08-06, before this plan was executed:

- `__tests__/integration/port-completeness.test.ts` checks **disk → map** only (`expect(undeclared).toEqual([])`, line 25), so a declaration with no file would slip past it.
- `__tests__/integration/permission-matrix.test.ts` **dynamically imports the real handlers from `app/api/**`** and asserts `SUCCESS_STATUS` has exactly one entry per `ROUTE_ACTIONS` method (line 256). A declaration whose route file does not exist therefore breaks *that* suite, on a module-resolution error that names neither this task nor this file.

Splitting the declaration to the task that creates the file keeps every task's suite green on its own commit — which is what makes a per-task review gate meaningful.

- [ ] **Step 7: Run the full suite and commit**

Run: `npx vitest run`
Expected: **all green.** This task adds three actions, their grants, and three matrix rows — nothing that any existing test enumerates from disk. If anything fails, stop and report; it is not expected.

```bash
git add lib/authz/policy.ts __tests__/authz/policy.test.ts
git commit -m "feat(1c): evidence:read/create/delete actions and grants (O-10)"
```

---

## Task 5: Byte inspection

Pure, no database, no auth. The one place the client's claim about its own file is discarded.

**Files:**
- Create: `lib/evidence/inspect.ts`
- Create: `__tests__/unit/evidence-inspect.test.ts`

**Interfaces:**
- Produces: `inspect(buf: Buffer): InspectResult`, where
  `type InspectResult = { ok: true; mimeType: string } | { ok: false; reason: string }`. Task 6 consumes it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { inspect, MAX_BYTES } from '@/lib/evidence/inspect';

const pdf  = Buffer.from('255044462d312e34', 'hex');            // %PDF-1.4
const png  = Buffer.from('89504e470d0a1a0a', 'hex');
const jpeg = Buffer.from('ffd8ffe000104a46', 'hex');
const zip  = Buffer.from('504b03040a000000', 'hex');            // PK.. -- docx/xlsx/pptx
const html = Buffer.from('<html><script>alert(1)</script>');

describe('inspect', () => {
  it('accepts a PDF by magic bytes', () => {
    expect(inspect(pdf)).toEqual({ ok: true, mimeType: 'application/pdf' });
  });

  it('accepts PNG and JPEG', () => {
    expect(inspect(png)).toEqual({ ok: true, mimeType: 'image/png' });
    expect(inspect(jpeg)).toEqual({ ok: true, mimeType: 'image/jpeg' });
  });

  it('accepts a ZIP container and labels it as such, NOT as a Word document (D-139)', () => {
    // .docx/.xlsx/.pptx are ZIP archives; magic bytes establish "zip", not
    // "document". Recording that limit as an assertion is the point.
    expect(inspect(zip)).toEqual({ ok: true, mimeType: 'application/zip' });
  });

  it('rejects HTML even when it would be declared as an image (O-7)', () => {
    const r = inspect(html);
    expect(r.ok).toBe(false);
  });

  it('rejects an empty buffer', () => {
    expect(inspect(Buffer.alloc(0)).ok).toBe(false);
  });

  it('rejects a buffer over the size limit', () => {
    expect(inspect(Buffer.alloc(MAX_BYTES + 1)).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/unit/evidence-inspect.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/** 10 MiB. Institutional policy documents and screenshots; not datasets. */
export const MAX_BYTES = 10 * 1024 * 1024;

export type InspectResult =
  | { ok: true; mimeType: string }
  | { ok: false; reason: string };

/**
 * Magic-byte signatures, longest first so a longer match wins.
 *
 * KNOWN LIMIT, recorded as D-139 rather than left implicit: .docx, .xlsx and
 * .pptx are ZIP archives whose first four bytes are PK\x03\x04, identical to
 * any zip, jar or apk. This function therefore establishes "this is a zip",
 * never "this is a Word document", for the formats most likely to be used as
 * institutional evidence. The residual risk is bounded by the download path,
 * which serves application/octet-stream as an attachment with nosniff (O-8),
 * so a mislabelled archive is never rendered or executed.
 */
const SIGNATURES: ReadonlyArray<{ magic: Buffer; mimeType: string }> = [
  { magic: Buffer.from('89504e470d0a1a0a', 'hex'), mimeType: 'image/png' },
  { magic: Buffer.from('255044462d', 'hex'),       mimeType: 'application/pdf' },
  { magic: Buffer.from('504b0304', 'hex'),         mimeType: 'application/zip' },
  { magic: Buffer.from('ffd8ff', 'hex'),           mimeType: 'image/jpeg' },
];

export function inspect(buf: Buffer): InspectResult {
  if (buf.length === 0) return { ok: false, reason: 'empty' };
  if (buf.length > MAX_BYTES) return { ok: false, reason: 'too large' };

  for (const { magic, mimeType } of SIGNATURES) {
    if (buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic)) {
      return { ok: true, mimeType };
    }
  }
  return { ok: false, reason: 'unrecognised file type' };
}
```

**Deliberately no plain-text branch.** "Looks like text" is not a signature — every rejected binary also looks like text under a loose heuristic, and admitting `text/plain` by exclusion re-opens exactly the HTML case O-7 exists to close. If plain-text evidence is needed later it gets an explicit decision, not a fallthrough.

- [ ] **Step 4: Run to verify it passes, then commit**

Run: `npx vitest run __tests__/unit/evidence-inspect.test.ts`
Expected: PASS, 6 tests.

```bash
git add lib/evidence/inspect.ts __tests__/unit/evidence-inspect.test.ts
git commit -m "feat(1c): byte inspection with a stated OOXML limit (O-7, D-139)"
```

---

## Task 6: The evidence data layer and the upload route

**Files:**
- Create: `lib/data/evidence.ts`
- Create: `app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts`
- Modify: `lib/rate-limit.ts`
- Create: `__tests__/integration/evidence-upload.test.ts`

**Interfaces:**
- Consumes: `inspect` (Task 5), `resolveFramework` (Task 2), `evidence:create` / `evidence:read` (Task 4).
- Produces: `createEvidence(input, tx)` and `listEvidenceForAssessment(assessmentId, tx)` from `lib/data/evidence.ts`. Tasks 7, 8, 9 consume them.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/integration/evidence-upload.test.ts` covering, at minimum:

```ts
// O-6: an attach target in ANOTHER assessment of the SAME org is rejected 404.
// This is a DIFFERENT claim from cross-org isolation and neither proves the other.
it('rejects a remediationItemId belonging to a different assessment in the same org', async () => { /* ... */ });

// O-22: a questionId absent from the pinned version is rejected.
it('rejects a questionId that does not exist in the pinned framework version', async () => { /* ... */ });

// O-9: attribution and integrity are recorded.
it('records uploadedById, byteSize and the sha256 of the stored bytes', async () => { /* ... */ });

// O-23: the same bytes on the same claim are idempotent, not duplicated.
it('returns the existing row when the same bytes are uploaded to the same claim twice', async () => { /* ... */ });

// O-24 (insert half): a completed assessment accepts no new evidence.
it('rejects an upload to a completed assessment', async () => { /* ... */ });

// O-1: cross-org isolation, asserted through withOrg rather than raw SQL.
it('does not return org B evidence to an org A context', async () => { /* ... */ });
```

Build fixtures with `buildTwoOrgFixture()` from `__tests__/helpers/fixture.ts`, which already produces 2 orgs x 5 roles x 2 members. Do not build a second fixture mechanism.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run __tests__/integration/evidence-upload.test.ts`
Expected: FAIL — `@/lib/data/evidence` not found.

- [ ] **Step 3: Implement the data layer**

```ts
import { createHash } from 'node:crypto';
import type { TenantTx } from '@/lib/data/tenant';

export type CreateEvidenceInput = {
  assessmentId: string;
  frameworkVersionId: string;
  questionId: string | null;
  remediationItemId: string | null;
  filename: string;
  mimeType: string;
  content: Buffer;
  uploadedById: string;
  orgId: string;
};

/**
 * Metadata and blob are written in ONE transaction: a metadata row with no
 * bytes is a broken evidence claim, and bytes with no metadata are
 * unreachable. The caller is already inside withOrg, so `tx` is that
 * transaction -- do not open a second one.
 */
export async function createEvidence(input: CreateEvidenceInput, tx: TenantTx) {
  const sha256 = createHash('sha256').update(input.content).digest('hex');

  const existing = await tx.evidence.findFirst({
    where: {
      assessmentId: input.assessmentId,
      sha256,
      questionId: input.questionId,
      remediationItemId: input.remediationItemId,
    },
  });
  if (existing) return existing;

  const row = await tx.evidence.create({
    data: {
      orgId: input.orgId,
      assessmentId: input.assessmentId,
      frameworkVersionId: input.frameworkVersionId,
      questionId: input.questionId,
      remediationItemId: input.remediationItemId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.content.byteLength,
      sha256,
      uploadedById: input.uploadedById,
    },
  });
  await tx.evidenceBlob.create({
    data: { evidenceId: row.id, orgId: input.orgId, content: input.content },
  });
  return row;
}

/**
 * Metadata only -- never selects the blob. The tables are split precisely so
 * this cannot accidentally drag bytes; keep it that way.
 */
export function listEvidenceForAssessment(assessmentId: string, tx: TenantTx) {
  return tx.evidence.findMany({
    where: { assessmentId },
    orderBy: { uploadedAt: 'desc' },
  });
}
```

- [ ] **Step 4: Implement the route**

`app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts`. The `POST` handler performs, in this order:

1. `requireOrgContextWithIdentity(slug, 'evidence:create')`
2. read the multipart body; reject before buffering if `Content-Length` exceeds `MAX_BYTES`
3. `inspect(buffer)` — on `ok: false`, return 400 with the reason and **discard the client's declared type entirely**
4. `withOrg(ctx, async (tx) => { … })` containing:
   - `resolveFramework(assessmentId, tx)` — 404 if null, **409 if `matches === false`** (O-14: an in-progress assessment whose content has drifted accepts no more input)
   - assessment status check — 409 if `completed` (O-24)
   - if `remediationItemId` given: `tx.remediationItem.findUnique` and confirm `assessmentId` matches the URL — 404 otherwise (O-6). RLS already confines it to the org; this confines it within the org to this assessment.
   - if `questionId` given: confirm it exists in the pinned version's question bank — 400 otherwise (O-22)
   - `createEvidence(...)`
5. return 201 with the metadata row, never the bytes

Follow the shape of `app/api/v1/orgs/[slug]/assessments/route.ts` exactly: `NextRequest`, `params: Promise<{...}>`, `try`/`catch` with `toResponse(e)`.

- [ ] **Step 4b: Declare the route's actions (O-17)**

Now that the file exists, add to `ROUTE_ACTIONS` in `lib/authz/routeActions.ts`:

```ts
  'app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts': {
    GET: 'evidence:read',
    POST: 'evidence:create',
  },
```

This map is the single source of truth O-17 requires — the matrix suite drives the real handler and asserts the status this declaration predicts, so a handler consulting a different action than declared fails a cell rather than passing quietly. You must also add the matching `SUCCESS_STATUS` entries in `__tests__/integration/permission-matrix.test.ts`: line 256 asserts exactly one per `ROUTE_ACTIONS` method, so a declaration without them fails that check by design.

- [ ] **Step 5: Add the rate-limit rule (O-18)**

In `lib/rate-limit.ts`, add above `'default'`:

```ts
  'POST:/api/v1/orgs': { window: 60 * 1000, max: 10, keyBy: 'userId' },
```

Match the existing key format exactly — read how `RATE_LIMITS` keys are compared (longest-prefix on `key.startsWith(k)`, `lib/rate-limit.ts:53`) before choosing the string, and confirm the chosen key does not accidentally also match the projects or members routes.

- [ ] **Step 6: Run, prove non-vacuity, commit**

Run: `npx vitest run __tests__/integration/evidence-upload.test.ts`
Expected: PASS.

Then, for O-6 specifically: comment out the "belongs to this assessment" check, re-run, confirm that test alone goes red, restore. Record both outputs.

```bash
git add lib/data/evidence.ts "app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts" \
        lib/rate-limit.ts __tests__/integration/evidence-upload.test.ts
git commit -m "feat(1c): evidence data layer and upload route (O-6, O-9, O-18, O-22, O-23, O-24)"
```

---

## Task 7: Download and delete

**Files:**
- Create: `app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts`
- Create: `__tests__/integration/evidence-download.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// O-8
it('serves octet-stream as an attachment with nosniff', async () => { /* ... */ });
it('cannot be header-injected by a filename containing CRLF', async () => { /* ... */ });
it('encodes a filename containing a double quote per RFC 6266', async () => { /* ... */ });
// O-9
it('rejects the download if the stored bytes do not match the recorded sha256', async () => { /* ... */ });
// O-24 (delete half)
it('refuses to delete evidence attached to a completed assessment', async () => { /* ... */ });
it('deletes evidence attached to an in-progress assessment, and its blob with it', async () => { /* ... */ });
```

- [ ] **Step 2: Run to verify they fail; Step 3: implement**

The `GET` handler:

```ts
const filename = row.filename;
// RFC 6266: ASCII fallback with dangerous characters stripped, plus filename*
// for the real value. Never interpolate a raw filename into a header.
const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
const encoded = encodeURIComponent(filename);

return new Response(blob.content, {
  headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': String(row.byteSize),
  },
});
```

`encodeURIComponent` removes CR and LF by construction, and the ASCII fallback strips quotes and backslashes — the two ways a `Content-Disposition` value breaks out. Verify the stored `sha256` against a fresh hash of `blob.content` before responding; on mismatch return 500 and `logSecurityEvent`, because the only ways to get there are corruption or tampering.

The `DELETE` handler: `requireOrgContext(slug, 'evidence:delete')`, then inside `withOrg` confirm the parent assessment is not `completed` (409 if it is), then `tx.evidence.delete` — the blob follows by `ON DELETE CASCADE`.

- [ ] **Step 4: Declare the route's actions (O-17)**

```ts
  'app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts': {
    GET: 'evidence:read',
    DELETE: 'evidence:delete',
  },
```

in `lib/authz/routeActions.ts`, plus the matching `SUCCESS_STATUS` entries in `__tests__/integration/permission-matrix.test.ts` — line 256 asserts exactly one per declared method.

- [ ] **Step 5: Run, commit**

Run: `npx vitest run`
Expected: all green, including `port-completeness` (which enumerates route files from disk and now finds both new ones declared) and `permission-matrix`.

```bash
git add "app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts" lib/authz/routeActions.ts \
        __tests__/integration/evidence-download.test.ts __tests__/integration/permission-matrix.test.ts
git commit -m "feat(1c): evidence download and delete with hostile-safe headers (O-8, O-9, O-17, O-24)"
```

---

## Task 8: Close the defect this plan exists for

`evidenceLevel` becomes derived. Until this lands, the plan has shipped a real evidence system beside a hand-settable enum claiming the same fact — worse than before, because now they can disagree.

**Files:**
- Modify: `app/api/v1/orgs/[slug]/assessments/[id]/remediation/route.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_drop_artifact_path/migration.sql`
- Create: `__tests__/integration/evidence-level-derived.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('ignores a client-supplied evidenceLevel entirely (O-20)', async () => {
  // PATCH {evidenceLevel: 'artifact_uploaded'} with NO evidence attached.
  // The stored value must remain self_attestation.
});

it('reports artifact_uploaded once real evidence exists for the item', async () => {
  // Upload evidence against the remediation item, then read it back.
});
```

- [ ] **Step 2: Run to verify it fails** — the current route writes the body value straight through (`remediation/route.ts:97`).

- [ ] **Step 3: Remove the field from the PATCH route**

Delete `evidenceLevel` from the destructure at line 58 and the `evidenceLevel: evidenceLevel ?? undefined` line at 97. Replace the surrounding comment so it records why: the value is derived from the presence of evidence rows and is not a client assertion.

- [ ] **Step 4: Derive it on read**

Wherever `RemediationItem` is returned to a client, compute:

```ts
evidenceLevel: item.evidence.length > 0 ? 'artifact_uploaded' : 'self_attestation',
```

using an `include: { evidence: { select: { id: true } } }`. Keep the database column for now — it is still the storage for legacy rows — but nothing writes it from a request.

- [ ] **Step 5: Drop `artifactPath`**

It has no reader and no writer anywhere in the tree (verified 2026-08-06). Migration:

```sql
ALTER TABLE "remediation_items" DROP COLUMN "artifactPath";
```
and remove the field from `prisma/schema.prisma`.

- [ ] **Step 6: Run, apply to both DBs, commit**

```bash
git add "app/api/v1/orgs/[slug]/assessments/[id]/remediation/route.ts" prisma/ \
        __tests__/integration/evidence-level-derived.test.ts
git commit -m "fix(1c): evidenceLevel is derived, artifactPath dropped (O-20)"
```

---

## Task 9: The report surface

**Files:**
- Rename: `components/report/useEvidenceData.ts` -> `components/report/useFindingsData.ts`
- Modify: every importer of it (find them, do not guess)
- Modify: `components/report/ReportSummary.tsx`, `lib/pdf/ReportPdf.tsx`
- Create: `__tests__/unit/report-provenance.test.tsx`

- [ ] **Step 1: Find every importer before renaming**

```bash
grep -rn "useEvidenceData" --include=*.ts --include=*.tsx . | grep -v node_modules
```
Rename with `git mv` and update every hit. `EvidenceItem` and `useEvidenceData` inside the file become `FindingItem` and `useFindingsData`.

- [ ] **Step 2: Write the failing test** — the provenance line renders semver, pin date and a short hash (O-15), and the PDF contains a manifest row per evidence item and no `content` field (O-16).

- [ ] **Step 3: Implement** — provenance line copy exactly:

```
Assessed against MAK-AI RAI Framework {semver}, pinned {date} · content {hash.slice(0,8)}…
```

- [ ] **Step 4: Add the mismatch banner (O-14, completed half)** — when `resolveFramework(...).matches === false` and the assessment is completed, render the cached `reportData` with a banner stating the deployed content differs from the pinned version.

- [ ] **Step 5: Run, commit**

```bash
git commit -m "feat(1c): provenance line, evidence manifest, findings/evidence rename (O-14, O-15, O-16)"
```

---

## Task 10: The attach UI

**Files:**
- Modify: `app/(authenticated)/orgs/[slug]/assessment/[id]/AssessmentPageClient.tsx`
- Modify: `components/assessment/QuestionBlock.tsx`
- Create: `components/evidence/EvidenceAttach.tsx`
- Modify: `e2e/role-matrix.spec.ts`

- [ ] **Step 1: Register the new controls FIRST**

`e2e/role-matrix.spec.ts` holds a `Control` registry and runs a completeness census that **fails if any button or link in `<main>` has no registry entry**. Adding the UI without registering will fail the census — that is the D-129 mechanism working. Add the entries before the components:

```ts
{ name: 'attach-evidence', action: 'evidence:create', mode: 'presence' },
{ name: 'delete-evidence', action: 'evidence:delete', mode: 'presence' },
```

- [ ] **Step 2: Build the component** — gates on `can(ctx.role, 'evidence:create')`, derived server-side and passed down. The component reflects the decision; it never makes one.

- [ ] **Step 3: Run the e2e role matrix, commit**

```bash
npx playwright test e2e/role-matrix.spec.ts
git commit -m "feat(1c): evidence attach UI, registered in the control census"
```

---

## Task 11: Backstops

**Files:**
- Modify: `__tests__/integration/trigger-enumeration.test.ts`
- Modify: `app/api/users/me/export/route.ts`
- Modify: `scripts/pen-test.mjs`

- [ ] **Step 1: Register the new guards (O-11)** — add the three `evidence:*` actions and the derived `evidenceLevel` read-site to the enumeration, so a guard with no production caller fails a test rather than shipping.

- [ ] **Step 2: Include evidence in the export (O-12)** — metadata and bytes, base64-encoded, so export and delete stay symmetric.

- [ ] **Step 3: Add pen-test cases (O-19)** — oversize upload, wrong magic bytes, cross-assessment attach.

- [ ] **Step 4: Run everything, commit**

```bash
npx vitest run && node scripts/pen-test.mjs
git commit -m "test(1c): trigger enumeration, evidence in export, pen-test cases (O-11, O-12, O-19)"
```

---

## Task 12: Live end-to-end verification

C5 defines done as observed working in a real browser, not as passing tests.

- [ ] **Step 1: Start the app** — use the `run` skill.
- [ ] **Step 2: Walk the full path as each of the 5 roles** — upload as owner/admin/assessor, confirm the control is absent for reviewer/viewer, download, delete while in-progress, complete the assessment, confirm delete is refused afterwards, view the report and confirm the provenance line, export the PDF and confirm the manifest.
- [ ] **Step 3: Record what was and was not verified live**, plainly, in the task report.
- [ ] **Step 4: Run the whole suite one final time**

```bash
npx vitest run && npx playwright test
```

---

## Self-review

**Spec coverage.** Every obligation O-1 … O-24 maps to a task: O-1/2/4/23 Task 3; O-3/5/21 Task 1; O-6/9/18/22/23/24 Task 6; O-7 Task 5; O-8/9/24 Task 7; O-10/17 Task 4; O-11/12/19 Task 11; O-13/14 Task 2; O-14/15/16 Task 9; O-20 Task 8. The pre-flight ESLint item is Task 1 Step 1. Spec §5.1–§5.5 map to Tasks 6, 7, 8 and the register rows already committed.

**Known thin spots, stated rather than hidden.** Tasks 9, 10 and 11 carry less literal code than Tasks 1–8. That is deliberate — they are edits to files whose current contents the implementer must read anyway, and inventing their exact current text here would produce confident fiction. Each names the file, the mechanism and the obligation. If an implementer reports NEEDS_CONTEXT on one of these, that is the plan working, not failing.

**Type consistency.** `getPinnedVersion` / `PinnedVersion` (Task 1) are consumed by `resolveFramework` / `FrameworkResolution` (Task 2), which Tasks 6 and 9 consume. `inspect` / `InspectResult` (Task 5) is consumed by Task 6. `createEvidence` / `CreateEvidenceInput` and `listEvidenceForAssessment` (Task 6) are consumed by Tasks 7, 8, 9. Table names `evidence` / `evidence_blobs` and registry id `'fv_3_0_0'` are used verbatim throughout.
