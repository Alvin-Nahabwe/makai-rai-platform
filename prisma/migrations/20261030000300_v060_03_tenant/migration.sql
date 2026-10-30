-- v0.6.0 step 3 (SRS 9.5 step 3, line 3687): the tenant tables in dependency order, each with
-- forced RLS, the org_isolation policy, its grants and its triggers in this one file (9.5 rule
-- 6, line 3637). Names, columns and types are 00-contract.md's "Data model names"; the
-- physical design (indexes, CHECK text, trigger bodies) is K0a's.
--
-- Shared rules (9.5 rules 1 to 5, lines 3632-3636):
--   * ids are TEXT (Prisma uuid()), as every existing table; `requestId` alone is UUID;
--   * every reference to a tenant row is a composite foreign key ("orgId", <parent>) ON DELETE
--     RESTRICT ON UPDATE RESTRICT, so a row can neither point across organisations nor be
--     removed by a cascade from its parent (obligation S2); each such key has an index;
--   * times are TIMESTAMPTZ(3); every "(db)" time is overwritten on insert by
--     record_set_db_time() (step 1), so a client value is ignored (FR-DEC-09, obligation S7);
--   * status sets are TEXT with a CHECK, except the existing OrgRole enum for role columns;
--   * every free-text column x has "xSalt" BYTEA, nullable, defaulting to the contract's core
--     salt expression (16 random bytes from gen_random_uuid(); no extension, finding F02);
--   * no CHECK requires an erasable text: erasure sets it to null (SRS line 1306);
--   * the eleven retry-keyed tables carry "requestId" UUID and "requestDigest" with
--     UNIQUE ("orgId", "requestId") (contract "Request columns"; owner answer A1);
--   * every append-only table gets the two refusal triggers of step 1, ENABLE ALWAYS.
-- User ids (entered by, decided by, owner, ...) are plain TEXT columns, as
-- users."lastActiveOrgId" is: accounts are scrubbed, never deleted (FR-EXP-03).

-- ---------------------------------------------------------------------------------------
-- projects: archived is read-only (FR-PRJ-03).
ALTER TABLE "projects" ADD COLUMN "archivedAt" TIMESTAMPTZ(3);

-- ---------------------------------------------------------------------------------------
-- organisation_events (FR-ORG-09; 9.5 line 3659). "orgId" defaults to the transaction's
-- organisation, so an app-lane insert inside withOrg names none and org_isolation's WITH CHECK
-- still applies (finding F14); the definer functions set the organisation context first.
CREATE TABLE "organisation_events" (
  "id"                 TEXT NOT NULL,
  "orgId"              TEXT NOT NULL DEFAULT NULLIF(current_setting('app.current_org_id', true), ''),
  "actorId"            TEXT NOT NULL,
  "actorRole"          TEXT NOT NULL
    CONSTRAINT "organisation_events_actorRole_check"
    CHECK ("actorRole" IN ('owner', 'admin', 'assessor', 'reviewer', 'viewer', 'platform_admin')),
  "action"             TEXT NOT NULL
    CONSTRAINT "organisation_events_action_check"
    CHECK ("action" IN ('organisation_created', 'agreement_recorded', 'owner_invitation_issued',
      'owner_invitation_resent', 'owner_invitation_revoked', 'organisation_name_corrected',
      'account_deactivated', 'account_reactivated',
      'member_invited', 'member_joined', 'member_role_changed', 'member_removed', 'member_left')),
  "targetUserId"       TEXT,
  "targetInvitationId" TEXT,
  "reason"             TEXT,
  "requestReference"   TEXT,
  "previousValue"      TEXT,
  "at"                 TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "organisation_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organisation_events_orgId_fkey" FOREIGN KEY ("orgId")
    REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "organisation_events_orgId_at_idx" ON "organisation_events"("orgId", "at");

-- The insert rules of the contract's OrganisationEvent row (finding R2-15; obligation S20),
-- for every role: a member action names its member as targetUserId (the former-member rule
-- of views.ts reads exactly those rows); and the app lane may write only the four membership
-- changes it performs, never as platform_admin, so it cannot forge an administrator or a
-- join row.
CREATE FUNCTION organisation_event_check_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."action" IN ('member_joined', 'member_role_changed', 'member_removed', 'member_left')
     AND NEW."targetUserId" IS NULL THEN
    RAISE EXCEPTION 'organisation_events: % needs targetUserId', NEW."action";
  END IF;
  IF current_user = 'makrai_app'
     AND (NEW."action" NOT IN ('member_invited', 'member_role_changed', 'member_removed', 'member_left')
          OR NEW."actorRole" = 'platform_admin') THEN
    RAISE EXCEPTION 'organisation_events: % as % refused for the app lane', NEW."action", NEW."actorRole";
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------
-- evidence, extended (SRS 5.1 line 1210, 9.5 line 3645): a project, a kind, link fields with
-- salts and the request columns; the v0.5.0 columns become nullable. Every v0.5.0 write still
-- succeeds: kind defaults to 'file', the new columns are nullable, and the two replaced
-- constraints are relaxations it meets (contract, "Evidence constraints", exact DDL below).
ALTER TABLE "evidence"
  ADD COLUMN "projectId"     TEXT,
  ADD COLUMN "kind"          TEXT NOT NULL DEFAULT 'file'
    CONSTRAINT "evidence_kind_check" CHECK ("kind" IN ('file', 'link')),
  ADD COLUMN "filenameSalt"  BYTEA DEFAULT substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4),
  ADD COLUMN "url"           TEXT,
  ADD COLUMN "urlSalt"       BYTEA DEFAULT substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4),
  ADD COLUMN "label"         TEXT,
  ADD COLUMN "labelSalt"     BYTEA DEFAULT substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4),
  ADD COLUMN "requestId"     UUID,
  ADD COLUMN "requestDigest" TEXT,
  ALTER COLUMN "assessmentId"       DROP NOT NULL,
  ALTER COLUMN "frameworkVersionId" DROP NOT NULL,
  ALTER COLUMN "filename"           DROP NOT NULL,
  ALTER COLUMN "mimeType"           DROP NOT NULL,
  ALTER COLUMN "byteSize"           DROP NOT NULL,
  ALTER COLUMN "sha256"             DROP NOT NULL;

ALTER TABLE "evidence" ADD CONSTRAINT "evidence_orgId_projectId_fkey"
  FOREIGN KEY ("orgId", "projectId") REFERENCES "projects"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "evidence_orgId_projectId_idx" ON "evidence"("orgId", "projectId");
-- Nulls are distinct: v0.5.0 rows carry no request id.
CREATE UNIQUE INDEX "evidence_orgId_requestId_key" ON "evidence"("orgId", "requestId");

-- Exactly 00-contract.md, Data model, "Evidence constraints" (finding R2-13; E-19 T3).
ALTER TABLE "evidence" DROP CONSTRAINT "evidence_attach_target_check";
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_attach_target_check"
  CHECK ("projectId" IS NOT NULL OR num_nonnulls("questionId", "remediationItemId") = 1);
ALTER TABLE "evidence" DROP CONSTRAINT "evidence_dedup_key";
CREATE UNIQUE INDEX "evidence_dedup_key" ON "evidence" ("assessmentId", "sha256", "questionId", "remediationItemId")
  NULLS NOT DISTINCT WHERE "assessmentId" IS NOT NULL;

-- ---------------------------------------------------------------------------------------
-- decision_versions (SRS 5.1 line 1209, 9.5 line 3643). The DB does not know a question's
-- type, so 9.5's "CHECK on status and scope answer by question type" is the type-free part:
-- every version carries exactly one of the two (a withdrawal is status 'withdrawn').
CREATE TABLE "decision_versions" (
  "id"                TEXT NOT NULL,
  "orgId"             TEXT NOT NULL,
  "projectId"         TEXT NOT NULL,
  "stage"             TEXT NOT NULL
    CONSTRAINT "decision_versions_stage_check" CHECK ("stage" IN ('pre-processing', 'in-processing', 'post-processing')),
  "questionId"        TEXT NOT NULL,
  "contentVersionId"  TEXT NOT NULL,
  "versionNumber"     INTEGER NOT NULL CONSTRAINT "decision_versions_versionNumber_check" CHECK ("versionNumber" >= 1),
  "baseVersionNumber" INTEGER,
  "status"            TEXT
    CONSTRAINT "decision_versions_status_check" CHECK ("status" IN ('done', 'partly', 'not_yet', 'not_applicable', 'withdrawn')),
  "scopeAnswer"       TEXT
    CONSTRAINT "decision_versions_scopeAnswer_check" CHECK ("scopeAnswer" IN ('yes', 'no', 'not_sure')),
  "optionsInPlace"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "reasonCode"        TEXT,
  "reason"            TEXT,
  "reasonSalt"        BYTEA DEFAULT substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4),
  "decidedByUserId"   TEXT,
  "decidedByRole"     TEXT
    CONSTRAINT "decision_versions_decidedByRole_check" CHECK ("decidedByRole" IN ('principal_investigator', 'supervisor',
      'ethics_committee', 'data_access_committee', 'institutional_dpo', 'funder', 'other')),
  "declaredOn"        DATE,
  "declaredPrecision" TEXT
    CONSTRAINT "decision_versions_declaredPrecision_check" CHECK ("declaredPrecision" IN ('day', 'month', 'year')),
  "withdrawalCode"    TEXT
    CONSTRAINT "decision_versions_withdrawalCode_check" CHECK ("withdrawalCode" IN ('entered_in_error', 'wrong_project', 'duplicate', 'test_entry')),
  "enteredById"       TEXT NOT NULL,
  "enteredByRole"     "OrgRole" NOT NULL,
  "receivedAt"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestId"         UUID NOT NULL,
  "requestDigest"     TEXT NOT NULL,
  CONSTRAINT "decision_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "decision_versions_answer_check" CHECK (num_nonnulls("status", "scopeAnswer") = 1),
  CONSTRAINT "decision_versions_declared_check" CHECK (("declaredOn" IS NULL) = ("declaredPrecision" IS NULL)),
  CONSTRAINT "decision_versions_decider_check" CHECK (num_nonnulls("decidedByUserId", "decidedByRole") <= 1),
  CONSTRAINT "decision_versions_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId")
    REFERENCES "projects"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "decision_versions_contentVersionId_fkey" FOREIGN KEY ("contentVersionId")
    REFERENCES "framework_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "decision_versions_orgId_id_key" ON "decision_versions"("orgId", "id");
CREATE UNIQUE INDEX "decision_versions_orgId_projectId_questionId_versionNumber_key"
  ON "decision_versions"("orgId", "projectId", "questionId", "versionNumber");
CREATE UNIQUE INDEX "decision_versions_orgId_requestId_key" ON "decision_versions"("orgId", "requestId");
CREATE INDEX "decision_versions_orgId_projectId_stage_questionId_versionNumber_idx"
  ON "decision_versions"("orgId", "projectId", "stage", "questionId", "versionNumber" DESC);
CREATE INDEX "decision_versions_contentVersionId_idx" ON "decision_versions"("contentVersionId");

CREATE TABLE "decision_evidence" (
  "orgId"      TEXT NOT NULL,
  "versionId"  TEXT NOT NULL,
  "evidenceId" TEXT NOT NULL,
  CONSTRAINT "decision_evidence_pkey" PRIMARY KEY ("orgId", "versionId", "evidenceId"),
  CONSTRAINT "decision_evidence_orgId_versionId_fkey" FOREIGN KEY ("orgId", "versionId")
    REFERENCES "decision_versions"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "decision_evidence_orgId_evidenceId_fkey" FOREIGN KEY ("orgId", "evidenceId")
    REFERENCES "evidence"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "decision_evidence_orgId_evidenceId_idx" ON "decision_evidence"("orgId", "evidenceId");

-- ---------------------------------------------------------------------------------------
-- findings and their events (SRS 5.1 lines 1213-1214, 9.5 lines 3646-3647). A shortfall
-- names the question and the version that raised it (FR-FND-01); a team finding may name
-- neither (FR-FND-02).
CREATE TABLE "findings" (
  "id"                TEXT NOT NULL,
  "orgId"             TEXT NOT NULL,
  "projectId"         TEXT NOT NULL,
  "stage"             TEXT NOT NULL
    CONSTRAINT "findings_stage_check" CHECK ("stage" IN ('pre-processing', 'in-processing', 'post-processing')),
  "source"            TEXT NOT NULL CONSTRAINT "findings_source_check" CHECK ("source" IN ('shortfall', 'team')),
  "questionId"        TEXT,
  "decisionVersionId" TEXT,
  "riskArea"          TEXT,
  "title"             TEXT,
  "titleSalt"         BYTEA DEFAULT substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4),
  "description"       TEXT,
  "descriptionSalt"   BYTEA DEFAULT substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4),
  "raisedById"        TEXT NOT NULL,
  "raisedAt"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestId"         UUID NOT NULL,
  "requestDigest"     TEXT NOT NULL,
  CONSTRAINT "findings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "findings_shortfall_check"
    CHECK ("source" <> 'shortfall' OR ("questionId" IS NOT NULL AND "decisionVersionId" IS NOT NULL)),
  CONSTRAINT "findings_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId")
    REFERENCES "projects"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "findings_orgId_decisionVersionId_fkey" FOREIGN KEY ("orgId", "decisionVersionId")
    REFERENCES "decision_versions"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "findings_orgId_id_key" ON "findings"("orgId", "id");
CREATE UNIQUE INDEX "findings_orgId_requestId_key" ON "findings"("orgId", "requestId");
CREATE INDEX "findings_orgId_projectId_stage_idx" ON "findings"("orgId", "projectId", "stage");
CREATE INDEX "findings_orgId_decisionVersionId_idx" ON "findings"("orgId", "decisionVersionId");
CREATE INDEX "findings_shortfall_question_idx" ON "findings"("orgId", "questionId") WHERE "source" = 'shortfall';

CREATE TABLE "finding_events" (
  "id"            TEXT NOT NULL,
  "orgId"         TEXT NOT NULL,
  "findingId"     TEXT NOT NULL,
  "kind"          TEXT NOT NULL CONSTRAINT "finding_events_kind_check" CHECK ("kind" IN ('reopened', 'withdrawn')),
  "eventCode"     TEXT,
  "reason"        TEXT,
  "reasonSalt"    BYTEA DEFAULT substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4),
  "byId"          TEXT NOT NULL,
  "at"            TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "findingSeq"    INTEGER NOT NULL,
  "requestId"     UUID NOT NULL,
  "requestDigest" TEXT NOT NULL,
  CONSTRAINT "finding_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "finding_events_orgId_findingId_fkey" FOREIGN KEY ("orgId", "findingId")
    REFERENCES "findings"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "finding_events_orgId_findingId_findingSeq_key" ON "finding_events"("orgId", "findingId", "findingSeq");
CREATE UNIQUE INDEX "finding_events_orgId_requestId_key" ON "finding_events"("orgId", "requestId");
CREATE INDEX "finding_events_findingId_at_idx" ON "finding_events"("findingId", "at");

-- ---------------------------------------------------------------------------------------
-- mitigation versions and their evidence (SRS 5.1 lines 1212, 1215; 9.5 lines 3644, 3648).
CREATE TABLE "mitigation_versions" (
  "id"                       TEXT NOT NULL,
  "orgId"                    TEXT NOT NULL,
  "findingId"                TEXT NOT NULL,
  "mitigationId"             TEXT NOT NULL,
  "versionNumber"            INTEGER NOT NULL CONSTRAINT "mitigation_versions_versionNumber_check" CHECK ("versionNumber" >= 1),
  "baseVersionNumber"        INTEGER,
  "what"                     TEXT,
  "whatSalt"                 BYTEA DEFAULT substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4),
  "changeNote"               TEXT,
  "changeNoteSalt"           BYTEA DEFAULT substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4),
  "ownerUserId"              TEXT NOT NULL,
  "dueDate"                  DATE NOT NULL,
  "status"                   TEXT NOT NULL
    CONSTRAINT "mitigation_versions_status_check" CHECK ("status" IN ('planned', 'in_progress', 'done', 'cancelled')),
  "kind"                     TEXT NOT NULL
    CONSTRAINT "mitigation_versions_kind_check" CHECK ("kind" IN ('action', 'decision_changed', 'decision_withdrawn')),
  "followsControl"           TEXT,
  "closureNote"              TEXT,
  "closureNoteSalt"          BYTEA DEFAULT substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4),
  "closureDecisionVersionId" TEXT,
  "cancelReason"             TEXT,
  "cancelReasonSalt"         BYTEA DEFAULT substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4),
  "enteredById"              TEXT NOT NULL,
  "enteredByRole"            "OrgRole" NOT NULL,
  "findingSeq"               INTEGER NOT NULL,
  "receivedAt"               TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestId"                UUID NOT NULL,
  "requestDigest"            TEXT NOT NULL,
  CONSTRAINT "mitigation_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mitigation_versions_orgId_findingId_fkey" FOREIGN KEY ("orgId", "findingId")
    REFERENCES "findings"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "mitigation_versions_orgId_closureDecisionVersionId_fkey" FOREIGN KEY ("orgId", "closureDecisionVersionId")
    REFERENCES "decision_versions"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "mitigation_versions_orgId_id_key" ON "mitigation_versions"("orgId", "id");
-- FR-FND-03's base-version check relies on this (9.5 line 3648).
CREATE UNIQUE INDEX "mitigation_versions_orgId_mitigationId_versionNumber_key"
  ON "mitigation_versions"("orgId", "mitigationId", "versionNumber");
CREATE UNIQUE INDEX "mitigation_versions_orgId_findingId_findingSeq_key" ON "mitigation_versions"("orgId", "findingId", "findingSeq");
CREATE UNIQUE INDEX "mitigation_versions_orgId_requestId_key" ON "mitigation_versions"("orgId", "requestId");
CREATE INDEX "mitigation_versions_orgId_ownerUserId_dueDate_idx" ON "mitigation_versions"("orgId", "ownerUserId", "dueDate");
CREATE INDEX "mitigation_versions_orgId_closureDecisionVersionId_idx" ON "mitigation_versions"("orgId", "closureDecisionVersionId");

CREATE TABLE "mitigation_evidence" (
  "orgId"      TEXT NOT NULL,
  "versionId"  TEXT NOT NULL,
  "evidenceId" TEXT NOT NULL,
  CONSTRAINT "mitigation_evidence_pkey" PRIMARY KEY ("orgId", "versionId", "evidenceId"),
  CONSTRAINT "mitigation_evidence_orgId_versionId_fkey" FOREIGN KEY ("orgId", "versionId")
    REFERENCES "mitigation_versions"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "mitigation_evidence_orgId_evidenceId_fkey" FOREIGN KEY ("orgId", "evidenceId")
    REFERENCES "evidence"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "mitigation_evidence_orgId_evidenceId_idx" ON "mitigation_evidence"("orgId", "evidenceId");

-- ---------------------------------------------------------------------------------------
-- accepted risks (SRS 5.1 line 1216, 9.5 line 3649). Accepted by a member or an outside
-- role, never both.
CREATE TABLE "accepted_risks" (
  "id"                TEXT NOT NULL,
  "orgId"             TEXT NOT NULL,
  "findingId"         TEXT NOT NULL,
  "acceptedByUserId"  TEXT,
  "acceptedByRole"    TEXT
    CONSTRAINT "accepted_risks_acceptedByRole_check" CHECK ("acceptedByRole" IN ('principal_investigator', 'supervisor',
      'ethics_committee', 'data_access_committee', 'institutional_dpo', 'funder', 'other')),
  "accepterRole"      "OrgRole",
  "reason"            TEXT,
  "reasonSalt"        BYTEA DEFAULT substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4),
  "lookAgainNote"     TEXT,
  "lookAgainNoteSalt" BYTEA DEFAULT substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4),
  "lookAgainOn"       DATE,
  "enteredById"       TEXT NOT NULL,
  "enteredByRole"     "OrgRole" NOT NULL,
  "findingSeq"        INTEGER NOT NULL,
  "receivedAt"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestId"         UUID NOT NULL,
  "requestDigest"     TEXT NOT NULL,
  CONSTRAINT "accepted_risks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "accepted_risks_accepted_by_check" CHECK (num_nonnulls("acceptedByUserId", "acceptedByRole") <= 1),
  CONSTRAINT "accepted_risks_orgId_findingId_fkey" FOREIGN KEY ("orgId", "findingId")
    REFERENCES "findings"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "accepted_risks_orgId_findingId_findingSeq_key" ON "accepted_risks"("orgId", "findingId", "findingSeq");
CREATE UNIQUE INDEX "accepted_risks_orgId_requestId_key" ON "accepted_risks"("orgId", "requestId");

-- findingSeq (SRS 5.3 item 11, line 1268): 1, 2, 3 within a finding across finding_events,
-- mitigation_versions and accepted_risks. One unique index cannot span three tables, so this
-- trigger enforces it: it takes the per-finding transaction lock FND-a's services take
-- (hashtextextended('finding:' || findingId, 0), so the two compose), reads the largest number
-- in use across the three tables, and assigns the next one when the writer passes none, or
-- refuses with SQLSTATE 23505 a number that is not the next one. Each table's own unique index
-- is the backstop within a table. The read runs at READ COMMITTED, where each statement sees
-- every commit made before the lock was granted; under a snapshot (REPEATABLE READ or
-- SERIALIZABLE) a concurrent commit would be invisible, so those levels are refused here
-- rather than allowed to number two rows alike.
CREATE FUNCTION finding_seq_assign() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cur integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '%: findingSeq is assigned only at READ COMMITTED (this transaction is %)',
      TG_TABLE_NAME, current_setting('transaction_isolation')
      USING ERRCODE = 'feature_not_supported';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('finding:' || NEW."findingId", 0));
  SELECT coalesce(max(s), 0) INTO cur FROM (
    SELECT "findingSeq" AS s FROM public."finding_events" WHERE "orgId" = NEW."orgId" AND "findingId" = NEW."findingId"
    UNION ALL
    SELECT "findingSeq" FROM public."mitigation_versions" WHERE "orgId" = NEW."orgId" AND "findingId" = NEW."findingId"
    UNION ALL
    SELECT "findingSeq" FROM public."accepted_risks" WHERE "orgId" = NEW."orgId" AND "findingId" = NEW."findingId"
  ) AS x;
  IF NEW."findingSeq" IS NULL THEN
    NEW."findingSeq" := cur + 1;
  ELSIF NEW."findingSeq" <> cur + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'unique_violation',
      MESSAGE = format('%s: findingSeq %s of finding %s is not the next number (%s)',
                       TG_TABLE_NAME, NEW."findingSeq", NEW."findingId", cur + 1);
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------
-- stage reviews and seals (SRS 5.1 lines 1217-1218, 9.5 lines 3650-3651).
CREATE TABLE "stage_reviews" (
  "id"              TEXT NOT NULL,
  "orgId"           TEXT NOT NULL,
  "projectId"       TEXT NOT NULL,
  "stage"           TEXT NOT NULL
    CONSTRAINT "stage_reviews_stage_check" CHECK ("stage" IN ('pre-processing', 'in-processing', 'post-processing')),
  "numberInStage"   INTEGER NOT NULL CONSTRAINT "stage_reviews_numberInStage_check" CHECK ("numberInStage" >= 1),
  "preparedFor"     TEXT,
  "preparedForSalt" BYTEA DEFAULT substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4),
  "openedById"      TEXT NOT NULL,
  "openedAt"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestId"       UUID NOT NULL,
  "requestDigest"   TEXT NOT NULL,
  CONSTRAINT "stage_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stage_reviews_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId")
    REFERENCES "projects"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "stage_reviews_orgId_id_key" ON "stage_reviews"("orgId", "id");
CREATE UNIQUE INDEX "stage_reviews_orgId_projectId_stage_numberInStage_key"
  ON "stage_reviews"("orgId", "projectId", "stage", "numberInStage");
CREATE UNIQUE INDEX "stage_reviews_orgId_requestId_key" ON "stage_reviews"("orgId", "requestId");

CREATE TABLE "seals" (
  "id"               TEXT NOT NULL,
  "orgId"            TEXT NOT NULL,
  "stageReviewId"    TEXT NOT NULL,
  "sealNumber"       INTEGER NOT NULL CONSTRAINT "seals_sealNumber_check" CHECK ("sealNumber" >= 1),
  "format"           TEXT NOT NULL CONSTRAINT "seals_format_check" CHECK ("format" ~ '^makrai\.seal/[1-9][0-9]*$'),
  "contentVersionId" TEXT NOT NULL,
  "manifest"         BYTEA NOT NULL,
  "fingerprint"      TEXT NOT NULL CONSTRAINT "seals_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  "sealedById"       TEXT NOT NULL,
  "sealedByRole"     "OrgRole" NOT NULL,
  "sealedAt"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestId"        UUID NOT NULL,
  "requestDigest"    TEXT NOT NULL,
  CONSTRAINT "seals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seals_orgId_stageReviewId_fkey" FOREIGN KEY ("orgId", "stageReviewId")
    REFERENCES "stage_reviews"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "seals_contentVersionId_fkey" FOREIGN KEY ("contentVersionId")
    REFERENCES "framework_versions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "seals_orgId_id_key" ON "seals"("orgId", "id");
CREATE UNIQUE INDEX "seals_orgId_stageReviewId_sealNumber_key" ON "seals"("orgId", "stageReviewId", "sealNumber");
CREATE UNIQUE INDEX "seals_orgId_requestId_key" ON "seals"("orgId", "requestId");
CREATE INDEX "seals_contentVersionId_idx" ON "seals"("contentVersionId");

-- ---------------------------------------------------------------------------------------
-- issued documents, their seals, sources and events (SRS 5.1 lines 1219-1221, 5.6 line 1308;
-- 9.5 lines 3652-3654, 3661). issuedAt is written by DOC-a, the database second it read before
-- rendering (gap G065): a whole second, no more than 120 s before the database clock and never
-- after it, unique per seal and type (FR-DOC-04). The bytes are present at issue; only the
-- operator's erasure nulls them later.
CREATE TABLE "issued_documents" (
  "id"              TEXT NOT NULL,
  "orgId"           TEXT NOT NULL,
  "projectId"       TEXT NOT NULL,
  "stageReviewId"   TEXT NOT NULL,
  "sealId"          TEXT NOT NULL,
  "documentType"    TEXT NOT NULL
    CONSTRAINT "issued_documents_documentType_check" CHECK ("documentType" IN ('data_card', 'model_card', 'mitigation_plan')),
  "templateVersion" TEXT NOT NULL,
  "typedFields"     JSONB NOT NULL DEFAULT '[]'
    CONSTRAINT "issued_documents_typedFields_check" CHECK (jsonb_typeof("typedFields") = 'array'),
  "pdf"             BYTEA,
  "plainText"       TEXT,
  "sha256"          TEXT NOT NULL CONSTRAINT "issued_documents_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  "byteSize"        INTEGER NOT NULL CONSTRAINT "issued_documents_byteSize_check" CHECK ("byteSize" >= 0),
  "issuedById"      TEXT NOT NULL,
  "issuedAt"        TIMESTAMPTZ(3) NOT NULL
    CONSTRAINT "issued_documents_issuedAt_whole_second_check" CHECK ("issuedAt" = date_trunc('second', "issuedAt")),
  "requestId"       UUID NOT NULL,
  "requestDigest"   TEXT NOT NULL,
  CONSTRAINT "issued_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "issued_documents_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId")
    REFERENCES "projects"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "issued_documents_orgId_stageReviewId_fkey" FOREIGN KEY ("orgId", "stageReviewId")
    REFERENCES "stage_reviews"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "issued_documents_orgId_sealId_fkey" FOREIGN KEY ("orgId", "sealId")
    REFERENCES "seals"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "issued_documents_orgId_id_key" ON "issued_documents"("orgId", "id");
CREATE UNIQUE INDEX "issued_documents_second_key" ON "issued_documents"("orgId", "sealId", "documentType", "issuedAt");
CREATE UNIQUE INDEX "issued_documents_orgId_requestId_key" ON "issued_documents"("orgId", "requestId");
CREATE INDEX "issued_documents_orgId_projectId_idx" ON "issued_documents"("orgId", "projectId");
CREATE INDEX "issued_documents_orgId_stageReviewId_idx" ON "issued_documents"("orgId", "stageReviewId");

CREATE FUNCTION issued_document_check_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  now_ts timestamptz := clock_timestamp();
BEGIN
  IF NEW."issuedAt" > now_ts OR NEW."issuedAt" < now_ts - interval '120 seconds' THEN
    RAISE EXCEPTION 'issued_documents: issuedAt % is not within the 120 seconds up to the database clock (%)',
      NEW."issuedAt", now_ts;
  END IF;
  IF NEW."pdf" IS NULL OR NEW."plainText" IS NULL THEN
    RAISE EXCEPTION 'issued_documents: pdf and plainText are written at issue';
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE "issued_document_seals" (
  "orgId"      TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "sealId"     TEXT NOT NULL,
  CONSTRAINT "issued_document_seals_pkey" PRIMARY KEY ("orgId", "documentId", "sealId"),
  CONSTRAINT "issued_document_seals_orgId_documentId_fkey" FOREIGN KEY ("orgId", "documentId")
    REFERENCES "issued_documents"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "issued_document_seals_orgId_sealId_fkey" FOREIGN KEY ("orgId", "sealId")
    REFERENCES "seals"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "issued_document_seals_orgId_sealId_idx" ON "issued_document_seals"("orgId", "sealId");

-- One row per record field and evidence file a document prints (5.6 line 1308); the erasure
-- functions follow these rows, never a text search (call R-48). "field" is the digest field
-- name of Types, "Digest field names" (or the column name), null for an evidence file.
CREATE TABLE "issued_document_sources" (
  "id"          TEXT NOT NULL,
  "orgId"       TEXT NOT NULL,
  "documentId"  TEXT NOT NULL,
  "sourceTable" TEXT NOT NULL,
  "sourceId"    TEXT NOT NULL,
  "field"       TEXT,
  CONSTRAINT "issued_document_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "issued_document_sources_orgId_documentId_fkey" FOREIGN KEY ("orgId", "documentId")
    REFERENCES "issued_documents"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "issued_document_sources_orgId_sourceTable_sourceId_idx" ON "issued_document_sources"("orgId", "sourceTable", "sourceId");
CREATE INDEX "issued_document_sources_orgId_documentId_idx" ON "issued_document_sources"("orgId", "documentId");

CREATE TABLE "document_events" (
  "id"            TEXT NOT NULL,
  "orgId"         TEXT NOT NULL,
  "documentId"    TEXT NOT NULL,
  "kind"          TEXT NOT NULL CONSTRAINT "document_events_kind_check" CHECK ("kind" IN ('withdrawn')),
  "reason"        TEXT NOT NULL,
  "byId"          TEXT NOT NULL,
  "at"            TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestId"     UUID NOT NULL,
  "requestDigest" TEXT NOT NULL,
  CONSTRAINT "document_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_events_orgId_documentId_fkey" FOREIGN KEY ("orgId", "documentId")
    REFERENCES "issued_documents"("orgId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "document_events_orgId_requestId_key" ON "document_events"("orgId", "requestId");
CREATE INDEX "document_events_orgId_documentId_idx" ON "document_events"("orgId", "documentId");

-- ---------------------------------------------------------------------------------------
-- document draft fields (SRS 5.1 line 1223, 9.5 line 3655): last values, not append-only;
-- a draft is not a record, so it goes with its project.
CREATE TABLE "document_draft_fields" (
  "id"           TEXT NOT NULL,
  "orgId"        TEXT NOT NULL,
  "projectId"    TEXT NOT NULL,
  "documentType" TEXT NOT NULL
    CONSTRAINT "document_draft_fields_documentType_check" CHECK ("documentType" IN ('data_card', 'model_card', 'mitigation_plan')),
  "fieldValues"  JSONB NOT NULL DEFAULT '{}'
    CONSTRAINT "document_draft_fields_fieldValues_check" CHECK (jsonb_typeof("fieldValues") = 'object'),
  "updatedById"  TEXT NOT NULL,
  "updatedAt"    TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "document_draft_fields_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_draft_fields_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId")
    REFERENCES "projects"("orgId", "id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "document_draft_fields_orgId_projectId_documentType_key"
  ON "document_draft_fields"("orgId", "projectId", "documentType");

-- ---------------------------------------------------------------------------------------
-- reminder log (SRS 5.1 line 1224, 9.5 line 3656), reached only through systemContext. The
-- full key carries outcome (gap G091; owner question 8), so a claim and its sent, failed or
-- opted-out row share an attempt; the two partial indexes are 9.5's: at most one success, and
-- two runs cannot claim one attempt (E-19 T9).
CREATE TABLE "reminder_log" (
  "id"           TEXT NOT NULL,
  "orgId"        TEXT NOT NULL,
  "mitigationId" TEXT NOT NULL,
  "dueDate"      DATE NOT NULL,
  "kind"         TEXT NOT NULL CONSTRAINT "reminder_log_kind_check" CHECK ("kind" IN ('due', 'overdue')),
  "attempt"      INTEGER NOT NULL CONSTRAINT "reminder_log_attempt_check" CHECK ("attempt" >= 1),
  "outcome"      TEXT NOT NULL
    CONSTRAINT "reminder_log_outcome_check" CHECK ("outcome" IN ('claimed', 'sent', 'failed', 'opted_out')),
  "failureCode"  TEXT,
  "at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reminder_log_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reminder_log_orgId_fkey" FOREIGN KEY ("orgId")
    REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "reminder_log_orgId_mitigationId_dueDate_kind_attempt_outcome_key"
  ON "reminder_log"("orgId", "mitigationId", "dueDate", "kind", "attempt", "outcome");
CREATE UNIQUE INDEX "reminder_log_one_sent_key"
  ON "reminder_log"("orgId", "mitigationId", "dueDate", "kind") WHERE "outcome" = 'sent';
CREATE UNIQUE INDEX "reminder_log_one_claim_key"
  ON "reminder_log"("orgId", "mitigationId", "dueDate", "kind", "attempt") WHERE "outcome" = 'claimed';

-- ---------------------------------------------------------------------------------------
-- tombstones (SRS 5.1 line 1225, 9.5 line 3657): written only by the operator's erasure
-- functions; makrai_app reads them and cannot insert one, so no app-lane bug can forge
-- "erased" for a tampered field (obligation S16, finding F05).
CREATE TABLE "tombstones" (
  "id"                   TEXT NOT NULL,
  "orgId"                TEXT NOT NULL,
  "targetTable"          TEXT NOT NULL,
  "targetId"             TEXT NOT NULL,
  "field"                TEXT,
  "digest"               TEXT,
  "erasureCode"          TEXT NOT NULL,
  "instructionReference" TEXT NOT NULL,
  "at"                   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tombstones_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tombstones_orgId_fkey" FOREIGN KEY ("orgId")
    REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "tombstones_orgId_targetTable_targetId_idx" ON "tombstones"("orgId", "targetTable", "targetId");

-- ---------------------------------------------------------------------------------------
-- request receipts (owner answer A1; contract New models row RequestReceipt, round 9): one per
-- (organisation, request id) for the routes whose effect is not an IdempotentTable row (rows
-- 21 to 29). Written by idempotentWrite's receipt mode under its transaction-scoped advisory
-- lock; "result" holds only non-secret response fields, as an object; there is no status
-- column (routes answer by `replayed`).
CREATE TABLE "request_receipts" (
  "id"            TEXT NOT NULL,
  "orgId"         TEXT NOT NULL,
  "requestId"     UUID NOT NULL,
  "requestDigest" TEXT NOT NULL,
  "actorUserId"   TEXT NOT NULL,
  "route"         TEXT NOT NULL,
  "rowId"         TEXT,
  "result"        JSONB CONSTRAINT "request_receipts_result_check" CHECK ("result" IS NULL OR jsonb_typeof("result") = 'object'),
  "createdAt"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "request_receipts_orgId_fkey" FOREIGN KEY ("orgId")
    REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "request_receipts_orgId_requestId_key" ON "request_receipts"("orgId", "requestId");

-- ---------------------------------------------------------------------------------------
-- Row-level security. The DDL event trigger already enabled and forced RLS on each new table
-- (each has "orgId"); stated here so the file reads complete (9.5 rule 6), with the policy on
-- the pinned predicate of 20260803074244 and no TO clause, so it binds every role that is not
-- a superuser, the definer and operator roles included.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organisation_events', 'decision_versions', 'decision_evidence', 'findings',
    'finding_events', 'mitigation_versions', 'mitigation_evidence', 'accepted_risks', 'stage_reviews', 'seals',
    'issued_documents', 'issued_document_seals', 'issued_document_sources', 'document_events',
    'document_draft_fields', 'reminder_log', 'tombstones', 'request_receipts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY "org_isolation" ON %I
      USING ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
      WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))$p$, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------
-- Triggers, every one ENABLE ALWAYS (a replica-mode session does not silence them).
DO $$
DECLARE
  t text;
  r record;
BEGIN
  -- The append-only refusal (step 1), statement and row, on every append-only table here.
  FOREACH t IN ARRAY ARRAY['organisation_events', 'decision_versions', 'decision_evidence', 'findings',
    'finding_events', 'mitigation_versions', 'mitigation_evidence', 'accepted_risks', 'stage_reviews', 'seals',
    'issued_documents', 'issued_document_seals', 'issued_document_sources', 'document_events',
    'reminder_log', 'tombstones', 'request_receipts']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION record_refuse_change()', t || '_refuse_row', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION record_refuse_change()', t || '_refuse_statement', t);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I, ENABLE ALWAYS TRIGGER %I', t, t || '_refuse_row', t || '_refuse_statement');
  END LOOP;

  -- The database clock on every "(db)" time column (step 1).
  FOR r IN SELECT * FROM (VALUES
    ('organisation_events', 'at', NULL), ('decision_versions', 'receivedAt', NULL), ('findings', 'raisedAt', NULL),
    ('finding_events', 'at', NULL), ('mitigation_versions', 'receivedAt', NULL), ('accepted_risks', 'receivedAt', NULL),
    ('stage_reviews', 'openedAt', NULL), ('seals', 'sealedAt', 'transaction'), ('document_events', 'at', NULL),
    ('reminder_log', 'at', NULL), ('tombstones', 'at', NULL), ('request_receipts', 'createdAt', NULL)
  ) AS v(tbl, col, clock)
  LOOP
    IF r.clock IS NULL THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION record_set_db_time(%L)', r.tbl || '_db_time', r.tbl, r.col);
    ELSE
      EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION record_set_db_time(%L, %L)', r.tbl || '_db_time', r.tbl, r.col, r.clock);
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', r.tbl, r.tbl || '_db_time');
  END LOOP;

  -- findingSeq across the three finding-sequenced tables.
  FOREACH t IN ARRAY ARRAY['finding_events', 'mitigation_versions', 'accepted_risks']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION finding_seq_assign()', t || '_finding_seq', t);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', t, t || '_finding_seq');
  END LOOP;
END $$;

CREATE TRIGGER "issued_documents_check_insert" BEFORE INSERT ON "issued_documents"
  FOR EACH ROW EXECUTE FUNCTION issued_document_check_insert();
ALTER TABLE "issued_documents" ENABLE ALWAYS TRIGGER "issued_documents_check_insert";

CREATE TRIGGER "organisation_events_check_insert" BEFORE INSERT ON "organisation_events"
  FOR EACH ROW EXECUTE FUNCTION organisation_event_check_insert();
ALTER TABLE "organisation_events" ENABLE ALWAYS TRIGGER "organisation_events_check_insert";

-- ---------------------------------------------------------------------------------------
-- Grants: 00-contract.md, Data model, "Grants".
GRANT SELECT, INSERT ON "organisation_events", "decision_versions", "decision_evidence", "findings",
  "finding_events", "mitigation_versions", "mitigation_evidence", "accepted_risks", "stage_reviews", "seals",
  "issued_documents", "issued_document_seals", "issued_document_sources", "document_events",
  "reminder_log", "request_receipts" TO makrai_app;
GRANT SELECT, INSERT, UPDATE ON "document_draft_fields" TO makrai_app;
GRANT SELECT ON "tombstones" TO makrai_app;

-- The definer functions write organisation_events in the same transaction as their action.
GRANT INSERT ON "organisation_events" TO makrai_definer;

-- The operator role (step 5's erasure functions): SELECT, and UPDATE of exactly the erasable
-- columns, on the tables that hold them; INSERT on tombstones; SELECT on
-- issued_document_sources, which the erasure functions follow to the documents that printed a
-- field or file (5.6 line 1305). The refusal trigger admits only the nulling of these columns.
GRANT SELECT, UPDATE ("reason", "reasonSalt") ON "decision_versions" TO makrai_operator_fn;
GRANT SELECT, UPDATE ("filename", "filenameSalt", "url", "urlSalt", "label", "labelSalt") ON "evidence" TO makrai_operator_fn;
GRANT SELECT, UPDATE ("title", "titleSalt", "description", "descriptionSalt") ON "findings" TO makrai_operator_fn;
GRANT SELECT, UPDATE ("reason", "reasonSalt") ON "finding_events" TO makrai_operator_fn;
GRANT SELECT, UPDATE ("what", "whatSalt", "changeNote", "changeNoteSalt", "closureNote", "closureNoteSalt",
  "cancelReason", "cancelReasonSalt") ON "mitigation_versions" TO makrai_operator_fn;
GRANT SELECT, UPDATE ("reason", "reasonSalt", "lookAgainNote", "lookAgainNoteSalt") ON "accepted_risks" TO makrai_operator_fn;
GRANT SELECT, UPDATE ("preparedFor", "preparedForSalt") ON "stage_reviews" TO makrai_operator_fn;
GRANT SELECT, UPDATE ("pdf", "plainText", "typedFields") ON "issued_documents" TO makrai_operator_fn;
GRANT SELECT, UPDATE ("fieldValues") ON "document_draft_fields" TO makrai_operator_fn;
GRANT SELECT ON "issued_document_sources" TO makrai_operator_fn;
GRANT INSERT ON "tombstones" TO makrai_operator_fn;

-- ---------------------------------------------------------------------------------------
-- The membership lock (NFR-SEC-04 (d), SRS line 2920; NFR-SEC-19, line 3003; obligation S10):
-- an account with the platform role holds no membership, and an account with a membership
-- cannot be given the platform role. Each trigger locks the user row FOR SHARE before it
-- checks: the membership insert's lock and the role update's row lock conflict, so of two
-- racing transactions the second waits for the first to commit and then sees its row (at READ
-- COMMITTED every statement takes a fresh snapshot). SECURITY INVOKER: the check runs with the
-- writer's rights, so a writer needs UPDATE on at least one users column for FOR SHARE
-- (makrai_identity has it; makrai_definer gets "isActive" and "sessionEpoch" in step 5;
-- executed claim E-19 T1). ENABLE ALWAYS, so replica mode does not silence either.
CREATE FUNCTION membership_lock_on_membership() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  r "UserRole";
BEGIN
  SELECT u."role" INTO r FROM public."users" u WHERE u."id" = NEW."userId" FOR SHARE;
  IF r = 'admin' THEN
    RAISE EXCEPTION 'membership refused for a platform administrator (NFR-SEC-04)';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION membership_lock_on_user_role() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1 FROM public."users" u WHERE u."id" = NEW."id" FOR SHARE;
  IF EXISTS (SELECT 1 FROM public."memberships" m WHERE m."userId" = NEW."id") THEN
    RAISE EXCEPTION 'platform role refused for an account with a membership (NFR-SEC-04)';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "memberships_platform_admin_lock" BEFORE INSERT OR UPDATE OF "userId" ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION membership_lock_on_membership();
CREATE TRIGGER "users_platform_admin_lock" BEFORE INSERT OR UPDATE OF "role" ON "users"
  FOR EACH ROW WHEN (NEW."role" = 'admin') EXECUTE FUNCTION membership_lock_on_user_role();
ALTER TABLE "memberships" ENABLE ALWAYS TRIGGER "memberships_platform_admin_lock";
ALTER TABLE "users" ENABLE ALWAYS TRIGGER "users_platform_admin_lock";
