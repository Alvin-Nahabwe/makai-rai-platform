-- v0.6.0 step 0, the owner check (SRS 9.5 step 0, line 3684; FR-ORG-04, line 553). It runs
-- before any other v0.6.0 change, in the first v0.6.0 migration file.
--
-- 1. Every membership held by an account with the platform role `admin` is removed: the
--    platform administrator holds no membership (FR-ORG-03, NFR-SEC-04, NFR-SEC-19).
-- 2. An organisation that step 1 leaves with no owner is archived (its existing
--    `deletedAt` is set, so no list or sign-in lookup shows it) when it has no project;
--    when it has a project, the migration aborts naming it, and nothing of v0.6.0 is
--    applied (13.8 step 7 gives the recovery).
--
-- Only organisations that lost a membership here are considered: an organisation that
-- had no owner before v0.6.0 is not this step's concern. Every removal and archive is
-- raised as a WARNING, not a NOTICE, because PostgreSQL's default log_min_messages is
-- `warning`: a WARNING reaches the server log ("listed in the migration log", line 553)
-- while `prisma migrate deploy` surfaces no server message of either level.
--
-- Rerunnable: a second run finds no administrator membership and changes nothing.
-- `organisation_events` does not exist yet, so nothing is written there (line 553).
DO $$
DECLARE
  m record;
  o record;
  affected text[] := '{}';
BEGIN
  FOR m IN
    DELETE FROM "memberships" ms
    USING "users" u
    WHERE ms."userId" = u."id" AND u."role" = 'admin'
    RETURNING ms."orgId", ms."userId", ms."role"
  LOOP
    RAISE WARNING 'v0.6.0 step 0: removed the % membership of platform administrator % in organisation %',
      m."role", m."userId", m."orgId";
    affected := array_append(affected, m."orgId");
  END LOOP;

  FOR o IN
    SELECT org."id", org."name"
    FROM "organizations" org
    WHERE org."id" = ANY (affected)
      AND org."deletedAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "memberships" x WHERE x."orgId" = org."id" AND x."role" = 'owner')
    ORDER BY org."id"
  LOOP
    IF EXISTS (SELECT 1 FROM "projects" p WHERE p."orgId" = o."id") THEN
      RAISE EXCEPTION 'v0.6.0 step 0: organisation "%" (%) has no owner once the platform administrator''s membership is removed, and it has a project; give it an owner before migrating (SRS 13.8 step 7)',
        o."name", o."id";
    END IF;
    UPDATE "organizations" SET "deletedAt" = now() WHERE "id" = o."id";
    RAISE WARNING 'v0.6.0 step 0: archived organisation "%" (%), left with no owner and no project',
      o."name", o."id";
  END LOOP;
END $$;
