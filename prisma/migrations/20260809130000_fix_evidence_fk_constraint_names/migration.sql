-- Task 8 (Plan 1c). Fixes a Minor routed here from Task 3's review
-- (task-3-report.md; progress.md "Task 3: minor (deferred)") because this
-- is the only later task in the plan that runs a migration.
--
-- The two composite FK constraints added by 20260808140048_evidence_tables
-- were named "evidence_assessment_fkey" and "evidence_blobs_evidence_fkey"
-- -- short, hand-picked names that do not follow this project's
-- Prisma-generated convention <table>_<field1>_<field2>_fkey. Every other
-- hand-written composite-FK migration already follows it exactly:
--   remediation_items_orgId_assessmentId_fkey (20260803034110)
--   assessments_orgId_projectId_fkey           (20260803034110)
--   project_metadata_orgId_projectId_fkey       (20260803034110)
-- Neither `evidence`'s nor `evidence_blobs`'s `@relation` in
-- prisma/schema.prisma carries a `map:` override, so nothing pins the short
-- names as deliberate -- schema.prisma has therefore ALWAYS implicitly
-- expected the convention-following names below; the live database was the
-- thing out of step. Left unfixed, the next `npx prisma migrate dev` would
-- compute the convention-following names as the expected state and propose
-- a spurious DROP/ADD rename as noise alongside whatever real change it is
-- computing. One of the two short names came verbatim from the Task 3
-- brief itself.
--
-- RENAME CONSTRAINT is a catalog-only metadata change (it updates
-- pg_constraint.conname; no table rewrite, no data scan, no row touched) --
-- briefly ACCESS EXCLUSIVE like any ALTER TABLE, but on a metadata-only
-- change that lock is held for microseconds, not proportional to table
-- size. Both new names are Prisma's OWN default computed name for their
-- respective relation, so after this migration a future
-- `npx prisma migrate dev --create-only` computes the identical name from
-- schema.prisma and proposes no change -- verified, not assumed
-- (task-8-report.md carries the actual command output).

ALTER TABLE "evidence"
  RENAME CONSTRAINT "evidence_assessment_fkey" TO "evidence_orgId_assessmentId_fkey";

ALTER TABLE "evidence_blobs"
  RENAME CONSTRAINT "evidence_blobs_evidence_fkey" TO "evidence_blobs_orgId_evidenceId_fkey";
