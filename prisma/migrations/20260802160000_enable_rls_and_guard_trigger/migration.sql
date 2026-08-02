-- Enable and FORCE Row Level Security on every tenant table (ADR-0001, control 1).
--
-- CORRECTED 2026-08-02 (Task-5 review, Important 1): the paragraph this replaced
-- claimed FORCE closes the makrai bypass. It does not, and this was verified
-- live: with FORCE on, `makrai` owning `projects`, and no GUC set, `makrai`
-- still saw every row. Superuser/BYPASSRLS bypass is unconditional and is
-- checked BEFORE the table-owner exemption FORCE removes -- FORCE cannot touch
-- it. What actually contains `makrai` is role separation (ADR-0001 control 2):
-- the app connects as `makrai_app`, which is NOSUPERUSER NOBYPASSRLS and is not
-- the table owner, so both the owner exemption and the superuser bypass are
-- irrelevant to it. FORCE's real job here is narrower but still worth having:
-- it binds a non-superuser table OWNER (defence-in-depth if a future role ever
-- owns one of these tables instead of just querying it), and it is required for
-- ENABLE to have any effect at all on such an owner. Keep it for that reason,
-- not the one originally stated.
--
-- Six tables, not four: `memberships` and `invitations` also carry `orgId`, and
-- `makrai_app` currently holds SELECT on both with no policy -- member emails
-- and roles are readable across tenants until this migration lands.
-- `organizations` is deliberately excluded: it has no `orgId` column, and
-- slug -> org resolution is a pre-context read by definition
-- (see docs/DEFERRED_REGISTER.md D-062).
ALTER TABLE "projects"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"          FORCE  ROW LEVEL SECURITY;
ALTER TABLE "project_metadata"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_metadata"  FORCE  ROW LEVEL SECURITY;
ALTER TABLE "assessments"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assessments"       FORCE  ROW LEVEL SECURITY;
ALTER TABLE "remediation_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "remediation_items" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "memberships"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships"       FORCE  ROW LEVEL SECURITY;
ALTER TABLE "invitations"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations"       FORCE  ROW LEVEL SECURITY;

-- NULLIF is mandatory: after a SET LOCAL transaction the GUC retains an empty
-- string. Without NULLIF an empty string is compared literally (and, with the
-- ::uuid cast this plan originally carried, ERRORED outright -> intermittent
-- 500s). With NULLIF it yields NULL -> zero rows, cleanly failing closed.
--
-- DROP POLICY IF EXISTS precedes each CREATE (Task-5 review, Minor 4): unlike
-- the ALTERs above and the CREATE OR REPLACE FUNCTION below, bare CREATE POLICY
-- is not re-runnable. Without this, replaying this file against a database
-- that already has it applied would die at the first CREATE POLICY having
-- already re-applied the (idempotent) ALTERs, leaving a confusing partial state.
DROP POLICY IF EXISTS org_isolation ON "projects";
CREATE POLICY org_isolation ON "projects"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

DROP POLICY IF EXISTS org_isolation ON "project_metadata";
CREATE POLICY org_isolation ON "project_metadata"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

DROP POLICY IF EXISTS org_isolation ON "assessments";
CREATE POLICY org_isolation ON "assessments"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

DROP POLICY IF EXISTS org_isolation ON "remediation_items";
CREATE POLICY org_isolation ON "remediation_items"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

DROP POLICY IF EXISTS org_isolation ON "memberships";
CREATE POLICY org_isolation ON "memberships"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

DROP POLICY IF EXISTS org_isolation ON "invitations";
CREATE POLICY org_isolation ON "invitations"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

-- Event trigger (ADR-0001, control 4): auto-enable RLS on any new `public`
-- table that carries an `orgId` column, so a forgotten policy on a future
-- tenant table is structurally impossible rather than merely tested.
--
-- Documented limitation: this only binds tables created AFTER installation.
-- The six tables above are handled explicitly because they already existed.
-- Task 6's T1 enumeration test is the backstop for anything this trigger
-- cannot reach (control 5).
CREATE OR REPLACE FUNCTION enforce_rls_on_tenant_tables()
RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE
  obj record;
  has_org_id boolean;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  WHERE command_tag = 'CREATE TABLE' AND schema_name = 'public'
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = split_part(obj.object_identity, '.', 2)
        AND column_name = 'orgId'
    ) INTO has_org_id;

    IF has_org_id THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
      EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',  obj.object_identity);
      RAISE NOTICE 'RLS auto-enabled on tenant table %', obj.object_identity;
    END IF;
  END LOOP;
END $$;

DROP EVENT TRIGGER IF EXISTS trg_enforce_rls_on_tenant_tables;
CREATE EVENT TRIGGER trg_enforce_rls_on_tenant_tables
  ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
  EXECUTE FUNCTION enforce_rls_on_tenant_tables();
