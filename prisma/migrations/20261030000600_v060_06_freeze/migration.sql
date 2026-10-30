-- v0.6.0 step 6 (SRS 9.5 step 6, line 3690). Each change here retires a v0.5.0 write path,
-- and lands only after the unit that removes that path (00-contract.md, "Revocations and the
-- green rule"): RM's `unit/rm` (assessments, remediation items), `unit/k0b`'s evidence DELETE
-- answering 404 and its consent-replay test, and this pull request's removal of the
-- acceptance-row delete from scrubUserOnDeactivation (lib/data/identity.ts).
--
-- A rolled-back v0.5.0 image therefore cannot create or save assessments or delete an
-- account (NFR-REL-07 accepts this; production holds no real v0.5.0 assessments, A-6).
--
-- Rerunnable, and free of DROP (the NFR-REL-07 lint): REVOKE and GRANT are idempotent, the
-- address clear goes through makrai_clear_consent_ip_addresses() (step 5), which the
-- consent_records refusal trigger's operator exception admits, and the triggers are created
-- with CREATE OR REPLACE.

-- The scored tables are frozen for the app lane (call: kept in v0.6.0, so no second, scored
-- data path stays alive). SELECT stays: the v0.5.0 image still lists projects.
REVOKE INSERT, UPDATE ON "assessments" FROM makrai_app;
REVOKE UPDATE ON "remediation_items" FROM makrai_app;

-- No application route deletes evidence (FR-AUTHZ-02, FR-EVD-06), and acceptance rows are kept
-- through account deletion (FR-EXP-04).
REVOKE DELETE ON "evidence" FROM makrai_app;
REVOKE DELETE ON "consent_records" FROM makrai_identity;

-- The IP address is cleared on every existing acceptance row and no code writes it again
-- (SRS 5.1 line 1200; FR-EXP-04).
SELECT makrai_clear_consent_ip_addresses();

-- The refusal triggers of SRS 5.3 item 1 on the three existing append-only tables, with the
-- operator exceptions of step 1 (erasable evidence text, the blob's removal, the address).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['evidence', 'evidence_blobs', 'consent_records']
  LOOP
    EXECUTE format('CREATE OR REPLACE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION record_refuse_change()', t || '_refuse_row', t);
    EXECUTE format('CREATE OR REPLACE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION record_refuse_change()', t || '_refuse_statement', t);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I, ENABLE ALWAYS TRIGGER %I', t, t || '_refuse_row', t || '_refuse_statement');
  END LOOP;
END $$;

-- No application role may create a temporary table (call R-46): a temporary table named like
-- a public one is the search_path hijack the definer functions defend against (obligation
-- S3). PUBLIC holds TEMPORARY by default; the two roles are named too in case either was
-- granted it directly. The database's name differs per environment, hence dynamic SQL.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM makrai_app, makrai_identity', current_database());
END $$;

-- Resend and revoke of a member invitation (FR-MEM-02) on the app lane: a column grant on
-- status only, which the 9.5 grant table lists among the grants v0.6.0 changes (line 3672),
-- and a trigger that lets makrai_app move a pending invitation to revoked or expired and
-- nothing else (obligation S11), so a revoked or expired invitation cannot be revived.
GRANT UPDATE ("status") ON "invitations" TO makrai_app;

CREATE OR REPLACE FUNCTION invitation_status_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user = 'makrai_app'
     AND NOT (OLD."status" = 'pending' AND NEW."status" IN ('revoked', 'expired')) THEN
    RAISE EXCEPTION 'invitations: makrai_app may only move a pending invitation to revoked or expired (% to %)',
      OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER "invitations_status_transition" BEFORE UPDATE OF "status" ON "invitations"
  FOR EACH ROW EXECUTE FUNCTION invitation_status_transition();
ALTER TABLE "invitations" ENABLE ALWAYS TRIGGER "invitations_status_transition";
