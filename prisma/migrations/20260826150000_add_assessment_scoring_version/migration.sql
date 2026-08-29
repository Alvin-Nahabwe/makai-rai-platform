-- Assessment.scoringVersion: the scoring methodology a completed report was
-- produced under, denormalised out of reportData so list surfaces can read it
-- without loading the whole JSONB blob.
--
-- Taken early from the report-shape-migration design (D4 of
-- docs/superpowers/specs/2026-08-19-report-shape-migration-design.md). Nothing
-- else of that project is built here. The band-withholding rule needs this on
-- the project list and project detail pages, which select overallScore alone.
--
-- Nullable, no backfill. A row completed before this column existed genuinely
-- has no recorded version, and inventing one would assert a methodology nobody
-- verified -- the exact defect the framework pin exists to prevent.
--
-- No GRANT: makrai_app holds table-level INSERT/SELECT/UPDATE/DELETE on
-- "assessments", which covers columns added later. Verified with
-- has_table_privilege before this migration was written -- all four
-- returned 't' against both makrai and makrai_test.
--
-- ALTER TABLE ADD COLUMN with no default is metadata-only in Postgres (no
-- table rewrite), and does not touch RLS: relrowsecurity/relforcerowsecurity
-- stay 't'/'t' and the "org_isolation" policy is row-level on "orgId", so it
-- covers the new column automatically. Also does not trip
-- trg_enforce_rls_on_tenant_tables, which fires only on CREATE TABLE/CREATE
-- TABLE AS/SELECT INTO, not ALTER TABLE.
ALTER TABLE "assessments" ADD COLUMN "scoringVersion" TEXT;

-- Write-once, in the same shape as trg_assessments_framework_version_write_once
-- (20260807102031_framework_registry_and_pin), and for the same reason: a
-- completed report's methodology is a historical fact, and changing it would
-- rewrite history silently.
--
-- The WHEN clause differs from that trigger in one way that matters. This
-- column starts NULL and is written once at completion, so NULL -> value must
-- be ALLOWED; only value -> different-value is rejected. A bare
-- IS DISTINCT FROM would reject the legitimate first write, because
-- Postgres's IS DISTINCT FROM treats NULL as a comparable value (NULL IS
-- DISTINCT FROM '5.0.0' is TRUE), unlike ordinary `=`. The extra
-- "OLD IS NOT NULL" guard is what makes the NULL -> value transition take
-- the WHEN-false, trigger-does-not-fire path; a same-value re-write (e.g. the
-- idempotent already_completed branch re-running the same UPDATE) also stays
-- WHEN-false because OLD IS DISTINCT FROM NEW is false when they are equal.
CREATE OR REPLACE FUNCTION reject_scoring_version_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'assessments.scoringVersion is write-once'
    USING HINT = 'A completed report records the scoring methodology it was '
                 'produced under. Changing it would relabel a superseded score.';
END $$;

DROP TRIGGER IF EXISTS trg_assessments_scoring_version_write_once ON "assessments";
CREATE TRIGGER trg_assessments_scoring_version_write_once
  BEFORE UPDATE OF "scoringVersion" ON "assessments"
  FOR EACH ROW
  WHEN (OLD."scoringVersion" IS NOT NULL
        AND OLD."scoringVersion" IS DISTINCT FROM NEW."scoringVersion")
  EXECUTE FUNCTION reject_scoring_version_change();
