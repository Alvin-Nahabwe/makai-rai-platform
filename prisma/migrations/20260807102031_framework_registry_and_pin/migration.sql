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
-- ON DELETE RESTRICT ON UPDATE CASCADE, matching what Prisma generates for
-- every other required relation in this schema with no explicit onDelete/
-- onUpdate (verified live against assessments_userId_fkey: confupdtype='c',
-- confdeltype='r'). Written by hand rather than `prisma migrate dev`, so
-- this is stated explicitly rather than left to the default -- an implicit
-- NO ACTION/NO ACTION here would silently diverge from that convention and
-- risk a future `prisma migrate dev` treating the difference as drift.
ALTER TABLE "assessments"
  ADD CONSTRAINT "assessments_frameworkVersionId_fkey"
  FOREIGN KEY ("frameworkVersionId") REFERENCES "framework_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

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
