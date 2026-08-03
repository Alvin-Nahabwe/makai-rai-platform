-- Two fail-opens found by the final C6 security review, both reproduced live
-- before this migration was written.
--
-- 1. A VIEW over a tenant table bypassed RLS completely.
--
--    ADR-0001 control 4 claims a forgotten policy is "structurally impossible".
--    That was true only for object_type='table'. `CREATE VIEW` raises
--    object_type='view', so the DDL guard skipped it; `ALTER DEFAULT PRIVILEGES
--    ... ON TABLES` auto-granted the new view to makrai_app (default privileges
--    on TABLES cover views); and because the view is owned by the superuser
--    `makrai` and PostgreSQL's security_invoker defaults to FALSE, the base
--    table's RLS is evaluated with the VIEW OWNER's rights — i.e. bypassed.
--
--    Verified on makrai_test before the fix, as makrai_app with NO org context:
--      SELECT count(*) FROM projects     -> 0   (RLS correct, fails closed)
--      SELECT count(*) FROM zz_summary   -> 2   (two organizations, fail OPEN)
--    That inverts the branch's central invariant, which is that forgetting
--    withOrg fails CLOSED.
--
-- 2. ALTER DEFAULT PRIVILEGES silently re-widened least privilege for every
--    future relation. D-090 recorded this as a risk whose pick-up trigger was
--    "the first non-tenant table Plan 1b adds"; the view above is the concrete
--    exploit that makes it a defect now rather than later.

-- Stop granting makrai_app rights on relations nobody has reviewed. Existing
-- per-table grants are untouched; only the automatic future grant is withdrawn.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM makrai_app;

-- Refuse any view in `public` that would run with its owner's rights.
--
-- `security_invoker = true` makes the base table's RLS apply to the *querying*
-- role, which is the only setting under which a view is safe here. This raises
-- rather than silently fixing the view: a view over tenant data is a design
-- decision, and the author should make it deliberately. Views outside `public`
-- and views whose reloptions already set security_invoker are unaffected.
CREATE OR REPLACE FUNCTION enforce_security_invoker_on_views()
RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE
  obj record;
  opts text[];
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  WHERE object_type IN ('view', 'materialized view') AND schema_name = 'public'
  LOOP
    SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = obj.objid;

    IF opts IS NULL OR NOT ('security_invoker=true' = ANY(opts)) THEN
      RAISE EXCEPTION
        'view % must be created WITH (security_invoker = true)', obj.object_identity
        USING HINT = 'Without it the view runs with its owner''s rights and bypasses '
                     'row-level security on any tenant table it reads. See ADR-0001.';
    END IF;
  END LOOP;
END $$;

DROP EVENT TRIGGER IF EXISTS trg_enforce_security_invoker_on_views;
CREATE EVENT TRIGGER trg_enforce_security_invoker_on_views
  ON ddl_command_end
  WHEN TAG IN ('CREATE VIEW', 'CREATE MATERIALIZED VIEW')
  EXECUTE FUNCTION enforce_security_invoker_on_views();
