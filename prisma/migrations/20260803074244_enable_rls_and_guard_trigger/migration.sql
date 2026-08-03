-- Six orgId-bearing tables, not four: memberships and invitations also carry
-- orgId, and makrai_app holds SELECT on both. Task 6's T1 test enumerates every
-- table with an orgId column, and the event trigger below encodes the same rule
-- -- protect only four and the guard permanently contradicts the migration that
-- installed it.
--
-- FORCE removes the owner exemption for a NON-SUPERUSER owner. It does nothing
-- to a superuser: `makrai` owns these tables and has BYPASSRLS, so it still sees
-- every row. Containing it is role separation -- the app connects as makrai_app
-- (ADR-0001 control 2) -- not something FORCE achieves.
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

-- organizations is the seventh, and it is keyed on "id" because it IS the
-- tenant -- it has no "orgId" column. D-062 originally deferred this on the
-- grounds that slug->org resolution is a before-context read no GUC can scope.
-- That was true when written and is no longer: Task 4's lib/data/preauth.ts
-- runs every before-context read (orgBySlug, membershipsForUser,
-- invitationByToken) on the OWNER connection, which bypasses RLS entirely. So
-- this policy constrains only withOrg/makrai_app, where scoping to the current
-- org is exactly right. Without it, `tx.organization.findMany()` through
-- withOrg lists every organization on the platform.
--
-- CONSEQUENCE, deliberate: creating an organization cannot go through withOrg,
-- because WITH CHECK requires id = the current GUC and a new org is not yet the
-- current org. Org creation is a before-context WRITE and needs a sanctioned
-- path in Plan 1b -- the same kind of forced checkpoint as D-061.
ALTER TABLE "organizations"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations"     FORCE  ROW LEVEL SECURITY;

-- NULLIF is mandatory: after a transaction-scoped set_config the GUC reads as
-- '' rather than being absent, and '' would otherwise be compared literally.
-- NULLIF turns it into NULL, which matches no row -- failing closed.
--
-- No ::uuid cast. "orgId" is a text column and Postgres has no text = uuid
-- operator, so the cast makes CREATE POLICY fail outright (D-064).
--
-- LIMIT OF THIS CONTROL, verified live 2026-08-03: makrai_app can call
-- set_config('app.current_org_id', ...) itself -- it must, because that is how
-- withOrg works. RLS therefore contains a FORGOTTEN FILTER, not INJECTED SQL.
-- Parameterised queries stay load-bearing (D-077).
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

-- Keyed on "id", not "orgId" -- see the note above.
DROP POLICY IF EXISTS org_isolation ON "organizations";
CREATE POLICY org_isolation ON "organizations"
  USING      ("id" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("id" = NULLIF(current_setting('app.current_org_id', true), ''));

-- ADR-0001 control 4: auto-enable RLS on any new public table carrying an
-- orgId column, so a forgotten policy is structurally impossible rather than
-- merely tested.
--
-- Column lookup goes through pg_attribute keyed on obj.objid. It must NOT
-- reconstruct the table name from object_identity: that string is QUOTED for
-- mixed-case identifiers, so a table like "ProjectTag" yields '"ProjectTag"'
-- (with quotes), matches nothing in information_schema, and ships with RLS
-- silently off -- no error, no notice (D-064).
--
-- THREE TAGS, not one. Verified live 2026-08-03 by an event-trigger probe:
--   CREATE TABLE t (...)            -> command_tag 'CREATE TABLE'
--   CREATE TABLE t AS SELECT ...    -> command_tag 'CREATE TABLE AS'
--   SELECT ... INTO t               -> command_tag 'SELECT INTO'
-- all three with object_type='table'. Firing only on the first would let a
-- tenant table created by the other two ship unprotected and silent -- the same
-- fail-open shape as D-064. We filter on object_type instead of re-checking the
-- tag, because CREATE INDEX also arrives here (object_type='index').
--
-- This enables RLS but does NOT create a policy. RLS with no policy denies all
-- rows to makrai_app, which is the safe direction, but the new table will read
-- empty with no visible cause -- and `prisma migrate deploy` does not surface
-- server NOTICEs. Add an org_isolation policy for any new tenant table.
--
-- The ALTER runs with the DDL executor's privileges, not the function owner's
-- (this is not SECURITY DEFINER). A non-owner creating a tenant table therefore
-- aborts its own CREATE. That is fail-closed, and intended.
--
-- DEPLOYMENT REQUIREMENT, verified live 2026-08-03: CREATE EVENT TRIGGER is
-- superuser-only ("ERROR: permission denied to create event trigger ... HINT:
-- Must be superuser to create an event trigger." raised as makrai_app). This
-- migration therefore has to be applied by a superuser role, which constrains
-- how migrations are run in any hosted environment (D-018 hosting, D-079).
--
-- Documented limits: binds only tables created AFTER installation, and does not
-- fire on ALTER TABLE ... ADD COLUMN "orgId" (which is exactly how the existing
-- tables were ported). Task 6's T1 enumeration test is the backstop for both.
CREATE OR REPLACE FUNCTION enforce_rls_on_tenant_tables()
RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE
  obj record;
  has_org_id boolean;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  WHERE object_type = 'table' AND schema_name = 'public'
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = obj.objid AND attname = 'orgId'
        AND attnum > 0 AND NOT attisdropped
    ) INTO has_org_id;

    IF has_org_id THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
      EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',  obj.object_identity);
      RAISE NOTICE 'RLS auto-enabled on tenant table % (no policy created — add org_isolation)',
        obj.object_identity;
    END IF;
  END LOOP;
END $$;

DROP EVENT TRIGGER IF EXISTS trg_enforce_rls_on_tenant_tables;
CREATE EVENT TRIGGER trg_enforce_rls_on_tenant_tables
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION enforce_rls_on_tenant_tables();
