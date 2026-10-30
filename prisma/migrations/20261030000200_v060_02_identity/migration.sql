-- v0.6.0 step 2 (SRS 9.5 step 2, line 3686): identity-lane tables and columns. Every column
-- added to a table v0.5.0 writes is nullable or has a default (NFR-REL-07); the one new CHECK
-- on such a table, invitations_kind_check, is on the contract's allow-list (its column
-- defaults to a value inside it).
--
-- Grants are 00-contract.md's "Grants" rows for these tables. makrai_definer's grants on the
-- existing identity tables (users, invitations, memberships, organizations) come with the
-- definer functions in step 5.

-- Acceptances (FR-ACC-03): the cross-border storage consent and the hash of the text shown.
-- The new enum value is not used in this file, so it may be added inside the migration's
-- transaction (PostgreSQL 12+; contract assumption A-2).
ALTER TYPE "ConsentType" ADD VALUE IF NOT EXISTS 'cross_border_storage';
ALTER TABLE "consent_records" ADD COLUMN "textHash" TEXT;

-- The reminder preference (FR-FUP-06), on by default.
ALTER TABLE "users" ADD COLUMN "reminderEmails" BOOLEAN NOT NULL DEFAULT true;

-- First-owner invitations (FR-ORG-02), the copy-link mark (FR-ACC-10) and the reference of
-- the controller's written request. Status sets are text with a CHECK (9.5 rule 3).
ALTER TABLE "invitations"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'member'
    CONSTRAINT "invitations_kind_check" CHECK ("kind" IN ('member', 'first_owner')),
  ADD COLUMN "linkShownAt" TIMESTAMPTZ(3),
  ADD COLUMN "requestReference" TEXT;

-- Password reset tokens (FR-ACC-06): only the hash of the emailed token is stored, unique;
-- usedAt and voidedAt are set once (9.5 line 3662).
CREATE TABLE "password_reset_tokens" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt"    TIMESTAMPTZ(3),
  "voidedAt"  TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");
CREATE INDEX "password_reset_tokens_userId_idx" ON "password_reset_tokens"("userId");

CREATE FUNCTION password_reset_token_set_once() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."usedAt" IS NOT NULL AND NEW."usedAt" IS DISTINCT FROM OLD."usedAt" THEN
    RAISE EXCEPTION 'password_reset_tokens."usedAt" is set once';
  END IF;
  IF OLD."voidedAt" IS NOT NULL AND NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt" THEN
    RAISE EXCEPTION 'password_reset_tokens."voidedAt" is set once';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "password_reset_tokens_set_once" BEFORE UPDATE ON "password_reset_tokens"
  FOR EACH ROW EXECUTE FUNCTION password_reset_token_set_once();
ALTER TABLE "password_reset_tokens" ENABLE ALWAYS TRIGGER "password_reset_tokens_set_once";

GRANT SELECT, INSERT ON "password_reset_tokens" TO makrai_identity;
GRANT UPDATE ("usedAt", "voidedAt") ON "password_reset_tokens" TO makrai_identity;
GRANT UPDATE ("voidedAt") ON "password_reset_tokens" TO makrai_definer;

-- Known devices (FR-ACC-05, call R-49): a browser with a valid known-device cookie has its
-- own failure count for the account.
CREATE TABLE "known_devices" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMPTZ(3),
  "lastSeenAt"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "known_devices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "known_devices_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "known_devices_userId_idx" ON "known_devices"("userId");
GRANT SELECT, INSERT, UPDATE ON "known_devices" TO makrai_identity;

-- Administrator actions on an account that belongs to no organisation (FR-ORG-09, call
-- R-47). Append-only (FR-ORG-09 line 577), written only by admin_set_account_active.
CREATE TABLE "platform_events" (
  "id"               TEXT NOT NULL,
  "actorId"          TEXT NOT NULL,
  "action"           TEXT NOT NULL
    CONSTRAINT "platform_events_action_check" CHECK ("action" IN ('account_deactivated', 'account_reactivated')),
  "targetUserId"     TEXT NOT NULL,
  "requestReference" TEXT,
  "at"               TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "platform_events_at_idx" ON "platform_events"("at");
CREATE TRIGGER "platform_events_db_time" BEFORE INSERT ON "platform_events"
  FOR EACH ROW EXECUTE FUNCTION record_set_db_time('at');
CREATE TRIGGER "platform_events_refuse_row" BEFORE UPDATE OR DELETE ON "platform_events"
  FOR EACH ROW EXECUTE FUNCTION record_refuse_change();
CREATE TRIGGER "platform_events_refuse_statement" BEFORE UPDATE OR DELETE OR TRUNCATE ON "platform_events"
  FOR EACH STATEMENT EXECUTE FUNCTION record_refuse_change();
ALTER TABLE "platform_events"
  ENABLE ALWAYS TRIGGER "platform_events_db_time",
  ENABLE ALWAYS TRIGGER "platform_events_refuse_row",
  ENABLE ALWAYS TRIGGER "platform_events_refuse_statement";
GRANT INSERT ON "platform_events" TO makrai_definer;

-- Organisation agreements (FR-ORG-01, 05, 06, 10; 9.5 line 3658): append-only, written by
-- the definer functions (with the organisation context set to the row's organisation, so
-- org_isolation's WITH CHECK admits it), read by the app lane under org_isolation (S-30,
-- line 3674) and by the identity lane for every organisation (S-23, S-24).
CREATE TABLE "organization_agreements" (
  "id"                  TEXT NOT NULL,
  "orgId"               TEXT NOT NULL,
  "agreementVersion"    TEXT NOT NULL,
  "textHash"            TEXT NOT NULL,
  "acceptedOn"          DATE NOT NULL,
  "controllerLegalName" TEXT NOT NULL,
  "dpContactEmail"      TEXT NOT NULL,
  "recordedById"        TEXT NOT NULL,
  "recordedAt"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "organization_agreements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_agreements_orgId_fkey" FOREIGN KEY ("orgId")
    REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "organization_agreements_orgId_recordedAt_idx" ON "organization_agreements"("orgId", "recordedAt" DESC);

-- The DDL event trigger already forced RLS on the new table (it has "orgId"); stated here
-- so this file reads complete on its own (9.5 rule 6).
ALTER TABLE "organization_agreements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_agreements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation" ON "organization_agreements"
  USING ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));
-- Read only: the identity lane never writes this table directly.
CREATE POLICY "identity_lane" ON "organization_agreements" FOR SELECT TO makrai_identity USING (true);

CREATE TRIGGER "organization_agreements_db_time" BEFORE INSERT ON "organization_agreements"
  FOR EACH ROW EXECUTE FUNCTION record_set_db_time('recordedAt');
CREATE TRIGGER "organization_agreements_refuse_row" BEFORE UPDATE OR DELETE ON "organization_agreements"
  FOR EACH ROW EXECUTE FUNCTION record_refuse_change();
CREATE TRIGGER "organization_agreements_refuse_statement" BEFORE UPDATE OR DELETE OR TRUNCATE ON "organization_agreements"
  FOR EACH STATEMENT EXECUTE FUNCTION record_refuse_change();
ALTER TABLE "organization_agreements"
  ENABLE ALWAYS TRIGGER "organization_agreements_db_time",
  ENABLE ALWAYS TRIGGER "organization_agreements_refuse_row",
  ENABLE ALWAYS TRIGGER "organization_agreements_refuse_statement";

GRANT SELECT ON "organization_agreements" TO makrai_app;
GRANT SELECT ON "organization_agreements" TO makrai_identity;
GRANT INSERT ON "organization_agreements" TO makrai_definer;
