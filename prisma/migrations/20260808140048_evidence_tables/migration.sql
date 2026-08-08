-- Plan 1c Task 3. Both tables carry "orgId", so the DDL guard auto-enables RLS
-- and FORCE on each and creates NO policy -- the policies below are required or
-- the tables deny everything. evidence_blobs carries "orgId" even though it is
-- 1:1 with a row that already has one: the guard keys on the presence of that
-- column, so omitting it would silently exempt the one table holding the actual
-- bytes from tenant isolation entirely.
--
-- DEVIATIONS FROM THE TASK BRIEF (task-3-brief.md), found during the fresh
-- senior-security pass required at C1 (re-derived for this task, not reused
-- from Task 1's or the design spec's threat table -- AGENTS.md §7.1) and
-- reported in task-3-report.md rather than applied silently (AGENTS.md §2):
--
-- 1. evidence_blobs.orgId had no enforced relationship to evidence.orgId --
--    a plain `evidenceId REFERENCES evidence(id)` says nothing about the
--    orgId column RLS actually filters on. Since RLS on evidence_blobs is
--    driven ENTIRELY by ITS OWN "orgId" (design spec §2.3: "the guard keys
--    on the presence of that column"), an insert that mismatched the two
--    values would isolate the BLOB under the wrong tenant while the metadata
--    row sat under the right one -- a structural hole in O-1's own isolation
--    guarantee, on the one table that holds the actual bytes. Every other
--    child table in this schema closes the equivalent hole with a composite
--    FK to its parent's (orgId, id) pair (evidence_assessment_fkey below is
--    one; projects/assessments/remediation_items do the same in prior
--    migrations, e.g. 20260803034110). Fixed by giving `evidence` a
--    UNIQUE(orgId, id) -- redundant with the "id" PK alone, required only so
--    evidence_blobs has a composite target, exactly what
--    assessments_orgId_id_key / projects_orgId_id_key already do for THEIR
--    children -- and making evidence_blobs' FK composite on
--    (orgId, evidenceId) -> evidence(orgId, id).
--
-- 2. No FK below named an explicit ON UPDATE action in the brief. Postgres's
--    implicit default (NO ACTION) is behaviourally identical to RESTRICT for
--    a non-deferrable FK, but this project's OWN precedent
--    (20260807102031_framework_registry_and_pin/migration.sql:43-49) explains
--    why leaving it implicit is wrong for a HAND-WRITTEN migration: "written
--    by hand rather than `prisma migrate dev`, so this is stated explicitly
--    ... an implicit NO ACTION/NO ACTION here would silently diverge from
--    that convention and risk a future `prisma migrate dev` treating the
--    difference as drift." Every FK in every one of the 11 prior migrations
--    that adds one declares ON UPDATE CASCADE explicitly (verified:
--    `grep -rn "ON UPDATE" prisma/migrations` before writing this file,
--    16-for-16 FOREIGN KEY/REFERENCES clauses). Added below so this
--    migration is not the first exception to a convention with zero prior
--    exceptions, and so a future `prisma migrate dev` diff against this
--    schema comes back empty rather than proposing to "fix" it.
--
-- 3. The brief's migration SQL and its Step 1 test both index three of
--    `evidence`'s four FK columns (assessmentId, remediationItemId,
--    frameworkVersionId) and omit `uploadedById`. The design spec itself
--    (2026-08-06-phase1c-evidence-and-pinning-design.md §6, O-4) says
--    "Explicit indexes on all four new FK columns" -- this is a plain miscount
--    against the spec's own obligation, not a judgement call. Added below.

CREATE TABLE "evidence" (
  "id"                 TEXT PRIMARY KEY,
  "orgId"              TEXT NOT NULL,
  "assessmentId"       TEXT NOT NULL,
  "frameworkVersionId" TEXT NOT NULL
    REFERENCES "framework_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "questionId"         TEXT,
  "remediationItemId"  TEXT
    REFERENCES "remediation_items"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "filename"           TEXT NOT NULL,
  "mimeType"           TEXT NOT NULL,
  "byteSize"           INTEGER NOT NULL,
  "sha256"             TEXT NOT NULL,
  "uploadedById"       TEXT
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "uploadedAt"         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "evidence_assessment_fkey"
    FOREIGN KEY ("orgId", "assessmentId")
    REFERENCES "assessments"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- O-2: exactly one attach target. num_nonnulls is the clean Postgres idiom;
  -- a hand-written OR/AND pair gets three-valued logic wrong.
  CONSTRAINT "evidence_attach_target_check"
    CHECK (num_nonnulls("questionId", "remediationItemId") = 1),
  -- O-23: idempotent retry. NULLS NOT DISTINCT is load-bearing -- without it two
  -- rows with a NULL remediationItemId count as distinct and this never fires.
  -- Proven non-vacuous in task-3-report.md.
  CONSTRAINT "evidence_dedup_key"
    UNIQUE NULLS NOT DISTINCT ("assessmentId", "sha256", "questionId", "remediationItemId")
);

-- Required so evidence_blobs (below) can composite-FK to (orgId, id) -- see
-- deviation 1 above. Same "redundant but required" shape as
-- assessments_orgId_id_key / projects_orgId_id_key (20260803034110).
CREATE UNIQUE INDEX "evidence_orgId_id_key" ON "evidence"("orgId", "id");

CREATE TABLE "evidence_blobs" (
  "evidenceId" TEXT PRIMARY KEY,
  "orgId"      TEXT NOT NULL,
  "content"    BYTEA NOT NULL,
  -- Composite, not a plain evidenceId REFERENCES evidence(id) -- see
  -- deviation 1 above. Ties this row's orgId to its parent's orgId so the
  -- pair cannot diverge: an invalid cross-org blob becomes unrepresentable
  -- rather than merely unlikely, the same guarantee evidence_assessment_fkey
  -- gives evidence itself.
  CONSTRAINT "evidence_blobs_evidence_fkey"
    FOREIGN KEY ("orgId", "evidenceId")
    REFERENCES "evidence"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Required by Prisma's one-to-one relation validator for the composite
-- relation above ("A one-to-one relation must use unique fields on the
-- defining side") -- functionally redundant with the "evidenceId" PK alone,
-- kept in sync with schema.prisma's matching @@unique so a future
-- `prisma migrate dev` sees schema and database agree rather than drift.
CREATE UNIQUE INDEX "evidence_blobs_orgId_evidenceId_key" ON "evidence_blobs"("orgId", "evidenceId");

-- Postgres does not index foreign keys automatically (O-4). Four columns,
-- matching the design spec's "all four" -- see deviation 3 above.
CREATE INDEX "evidence_orgId_assessmentId_idx" ON "evidence" ("orgId", "assessmentId");
CREATE INDEX "evidence_remediationItemId_idx"  ON "evidence" ("remediationItemId");
CREATE INDEX "evidence_frameworkVersionId_idx" ON "evidence" ("frameworkVersionId");
CREATE INDEX "evidence_uploadedById_idx"       ON "evidence" ("uploadedById");

-- O-1. Same form as all 7 existing policies: USING and WITH CHECK both
-- present, NULLIF'd empty-string GUC, no ::uuid cast (D-064). Verified
-- verbatim against pg_policies for "assessments" before writing this file --
-- see task-3-report.md.
CREATE POLICY "org_isolation" ON "evidence"
  USING ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

CREATE POLICY "org_isolation" ON "evidence_blobs"
  USING ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

-- No UPDATE: evidence is uploaded or deleted, never edited. Granting only
-- what the design uses is the whole point of the revoked default privileges
-- (20260803140500_.../migration.sql:27-28). Proven behaviourally, not just by
-- the absence below, in task-3-report.md.
GRANT SELECT, INSERT, DELETE ON "evidence"       TO makrai_app;
GRANT SELECT, INSERT, DELETE ON "evidence_blobs" TO makrai_app;
