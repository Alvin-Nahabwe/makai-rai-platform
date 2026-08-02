-- Fix Task-5 review Important 2: enforce_rls_on_tenant_tables() used
-- split_part(obj.object_identity, '.', 2) to recover the bare table name for
-- an information_schema.columns lookup. object_identity is already correctly
-- quoted (e.g. public."ProjectTag"), so split_part returned '"ProjectTag"'
-- WITH the quotes -- which matches nothing in information_schema.columns.
-- A future CREATE TABLE "ProjectTag" (..., "orgId" text NOT NULL) would
-- therefore get has_org_id = false, skip the IF body entirely, and ship with
-- RLS off -- no error, no NOTICE, silently open. Every current model happens
-- to map to snake_case via @@map, but nothing enforces that going forward,
-- and this is exactly the failure mode the trigger exists to make impossible.
--
-- Fixed by keying off the DDL command's own OID (obj.objid) against
-- pg_attribute instead of reconstructing and re-parsing the table name.
-- pg_attribute is immune to quoting/case entirely: it matches on the catalog
-- object identity, not a string derived from a display-formatted identifier.
--
-- Only the function body changes. CREATE OR REPLACE is sufficient -- the event
-- trigger object (trg_enforce_rls_on_tenant_tables) does not need to be
-- dropped and recreated, since it dispatches to the function by name and picks
-- up the new body automatically. The six org_isolation policies are unchanged
-- and are not restated here (they already exist; duplicating them across two
-- migration files would itself be a defect).
--
-- Also documents Task-5 review Minor 6: this trigger enables + forces RLS on
-- a qualifying new table but does NOT create a policy for it. With FORCE and
-- zero policies, the table is deny-by-default for every non-owner role --
-- correct fail-closed behaviour, but it means a developer who adds a tenant
-- table sees their own reads/writes return nothing, with no obvious cause.
-- `prisma migrate deploy` does not surface server-side NOTICEs, so the
-- `RAISE NOTICE` below is visible only via `psql` or Postgres logs, not in a
-- normal migration run. Anyone hitting this must add their own
-- `CREATE POLICY org_isolation ON "<table>" USING (...) WITH CHECK (...)`
-- (see the six above for the exact predicate) -- the trigger does not and
-- cannot do this for them, because it has no way to know the policy is
-- correct without a human confirming the isolation predicate is right.
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
      SELECT 1 FROM pg_attribute
      WHERE attrelid = obj.objid AND attname = 'orgId'
        AND attnum > 0 AND NOT attisdropped
    ) INTO has_org_id;

    IF has_org_id THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
      EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',  obj.object_identity);
      RAISE NOTICE 'RLS auto-enabled on tenant table % (no policy created -- add org_isolation yourself, see migration comment)', obj.object_identity;
    END IF;
  END LOOP;
END $$;
