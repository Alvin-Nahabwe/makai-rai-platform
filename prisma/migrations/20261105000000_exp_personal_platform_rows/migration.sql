-- The rows of the personal export (FR-EXP-02, NFR-PRIV-08) that no application lane can read:
-- platform_events (written only by admin_set_account_active; no application role holds SELECT on
-- it), and the organisation_events a platform administrator acted in outside any membership
-- (actorRole 'platform_admin'; makrai_identity holds no SELECT on organisation_events). The
-- personal export reads a member's rows per membership on the app lane; a platform administrator
-- holds no membership (NFR-SEC-04), so without this their own rows never reach their export (C4
-- EXP-1 SC-1, controller ruling). organization_agreements are not read here: makrai_identity
-- reads every agreement through its identity_lane policy, so lib/data/definer.ts reads them on
-- that lane and makrai_definer stays INSERT-only on them (C4 EXP re-review N-1).
--
-- It trusts p_user, as the other definer functions trust their actor argument ("the database
-- cannot know who is signed in", migration 20261030000500): any makrai_identity session can read
-- the platform rows of any account it names. Its one caller is route 38, with the session's own
-- id (ADR-0009, Definer functions; __tests__/lint/personal-platform-rows-caller.test.ts).
--
-- Written as the definer functions of migration 20261030000500_v060_05_functions are: SECURITY
-- DEFINER, owned by the NOLOGIN role makrai_definer, search_path pinned, every table
-- schema-qualified, EXECUTE revoked from PUBLIC and granted to makrai_identity only (the lane
-- lib/data/definer.ts calls through). It reads only. The organisation-scoped tables are forced
-- under org_isolation, which binds this role too, so it sets app.current_org_id to each
-- organisation the caller names (read on the identity lane, as admin_set_account_active's
-- wrapper does) and restores the earlier value before it returns.
--
-- Each row carries its source, id, organisation (null for a platform row), kind or action, time
-- and the person's role in it: never another person's id or address, a reason or a reference.
CREATE FUNCTION personal_platform_rows(p_user text, p_org_ids text[])
RETURNS TABLE ("source" text, "id" text, "orgId" text, "organisation" text, "kind" text, "at" timestamptz, "role" text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  o         text;
  prior_org text := current_setting('app.current_org_id', true);
BEGIN
  IF p_user IS NULL OR btrim(p_user) = '' THEN
    RAISE EXCEPTION 'personal_platform_rows: a user id is required';
  END IF;

  RETURN QUERY
    SELECT 'platform_event'::text, e."id", NULL::text, NULL::text, e."action", e."at", 'acted'::text
    FROM public."platform_events" e WHERE e."actorId" = p_user
    UNION ALL
    SELECT 'platform_event'::text, e."id", NULL::text, NULL::text, e."action", e."at", 'named'::text
    FROM public."platform_events" e WHERE e."targetUserId" = p_user;

  FOREACH o IN ARRAY ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_org_ids, '{}'::text[])) AS x ORDER BY 1) LOOP
    PERFORM set_config('app.current_org_id', o, true);
    RETURN QUERY
      SELECT 'organisation_event'::text, v."id", v."orgId", g."name", v."action", v."at", 'acted'::text
      FROM public."organisation_events" v JOIN public."organizations" g ON g."id" = v."orgId"
      WHERE v."orgId" = o AND v."actorId" = p_user AND v."actorRole" = 'platform_admin';
  END LOOP;

  PERFORM set_config('app.current_org_id', coalesce(prior_org, ''), true);
END
$$;

-- Its reads (ADR-0009, "Function-owner grants": makrai_definer held INSERT only on these two).
GRANT SELECT ON "platform_events" TO makrai_definer;
GRANT SELECT ON "organisation_events" TO makrai_definer;

ALTER FUNCTION personal_platform_rows(text, text[]) OWNER TO makrai_definer;
REVOKE ALL ON FUNCTION personal_platform_rows(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION personal_platform_rows(text, text[]) TO makrai_identity;
