-- The identity lane: the role lib/data/identity.ts and lib/data/preauth.ts connect as
-- (ADR-0009). Until now both connected as the schema owner, `makrai`, a SUPERUSER that
-- ignores row-level security and every grant below. That made the web process hold the
-- one credential that can read every organisation's rows and rewrite the schema.
--
-- makrai_identity is a plain login. It can do exactly what the pre-organisation paths
-- need -- sign-in, registration, invitation acceptance, organisation creation, the
-- account export and deactivation -- and nothing else. It holds no grant on any tenant
-- record table (projects, assessments, evidence, ...) and cannot create objects:
-- PostgreSQL 15+ gives PUBLIC no CREATE on schema public, and this role is given none.
--
-- NO PASSWORD IS SET HERE. Migrations run in every environment, so a literal here would
-- publish production's credential in git. scripts/provision-app-db-role.sh sets it per
-- environment, reading it from IDENTITY_DB_PASSWORD on stdin.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'makrai_identity') THEN
    CREATE ROLE makrai_identity LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Idempotent even if the role pre-existed from an earlier attempt.
ALTER ROLE makrai_identity LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- A pre-existing role may carry grants nobody reviewed. Start from none, so what
-- follows is the whole of it -- __tests__/integration/role-grants.test.ts compares the
-- catalog against ADR-0009's table.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM makrai_identity;

GRANT USAGE ON SCHEMA public TO makrai_identity;

-- Each grant is the operation set the lane's code performs (ADR-0009 maps every call):
--   users            sign-in reads, lockout and password updates, registration
--   consent_records  registration writes, account export reads, deactivation deletes
--   organizations    slug and membership lookups, organisation creation
--   memberships      "which organisations am I in", acceptance and creation inserts
--   invitations      lookup by token hash, the single-use status transition
-- No DELETE on users: a user delete cascades into memberships (ON DELETE CASCADE),
-- which is why identityDb exposes no delete (lib/data/identity.ts EXPOSED_OPERATIONS).
GRANT SELECT, INSERT, UPDATE ON "users"           TO makrai_identity;
GRANT SELECT, INSERT, DELETE ON "consent_records" TO makrai_identity;
GRANT SELECT, INSERT         ON "organizations"   TO makrai_identity;
GRANT SELECT, INSERT         ON "memberships"     TO makrai_identity;
GRANT SELECT, UPDATE         ON "invitations"     TO makrai_identity;

-- organizations, memberships and invitations have RLS enabled AND forced, with
-- org_isolation as their only policy: rows are visible only where id/orgId equals the
-- app.current_org_id GUC. The lane's lookups run BEFORE any organisation is known
-- ("which organisations am I in", "whose invitation is this token"), so no GUC can scope
-- them. These policies let the lane see every row of the three tables, as it did on the
-- owner connection; the trade-off is recorded in ADR-0009. They are TO makrai_identity,
-- so makrai_app is still bound by org_isolation alone. Permissive policies OR together
-- per role, which is what makes that true.
DROP POLICY IF EXISTS identity_lane ON "organizations";
CREATE POLICY identity_lane ON "organizations" FOR ALL TO makrai_identity USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS identity_lane ON "memberships";
CREATE POLICY identity_lane ON "memberships" FOR ALL TO makrai_identity USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS identity_lane ON "invitations";
CREATE POLICY identity_lane ON "invitations" FOR ALL TO makrai_identity USING (true) WITH CHECK (true);
