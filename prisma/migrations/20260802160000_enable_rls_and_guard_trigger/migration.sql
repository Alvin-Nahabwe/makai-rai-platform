-- Enable and FORCE Row Level Security on every tenant table (ADR-0001, control 1).
--
-- FORCE is the part that actually matters: ENABLE alone is bypassed by the table
-- owner (and every role with BYPASSRLS), which in this database is `makrai` --
-- the role every migration and the dev DATABASE_URL connects as. Without FORCE,
-- RLS here would be decorative for the owner and only accidentally effective
-- because the app is expected to connect as `makrai_app` instead. FORCE closes
-- that gap structurally rather than by convention.
--
-- Six tables, not four: `memberships` and `invitations` also carry `orgId`, and
-- `makrai_app` currently holds SELECT on both with no policy -- member emails
-- and roles are readable across tenants until this migration lands.
-- `organizations` is deliberately excluded: it has no `orgId` column, and
-- slug -> org resolution is a pre-context read by definition (see D- register).
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
CREATE POLICY org_isolation ON "projects"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

CREATE POLICY org_isolation ON "project_metadata"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

CREATE POLICY org_isolation ON "assessments"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

CREATE POLICY org_isolation ON "remediation_items"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

CREATE POLICY org_isolation ON "memberships"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

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
