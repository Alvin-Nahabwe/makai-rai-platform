-- The application connects as this role. It is NOT the table owner and has
-- NOBYPASSRLS, so Task 5's policies actually constrain it. Containing the
-- superuser owner (makrai) is role separation, not something RLS can do:
-- superusers bypass RLS unconditionally and FORCE does not apply to them.
--
-- NO PASSWORD IS SET HERE. Migrations run in every environment, so a literal
-- here would publish production's app-role credential in git. The password is
-- provisioned per environment by scripts/provision-app-db-role.sh.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'makrai_app') THEN
    CREATE ROLE makrai_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- Idempotent even if the role pre-existed from an earlier attempt.
ALTER ROLE makrai_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO makrai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO makrai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO makrai_app;

-- Least privilege. The blanket grant above is convenient but over-broad:
--   _prisma_migrations : an app-role compromise could rewrite migration history
--   users              : holds passwordHash, and will carry NO RLS policy, so
--                        the app role could read or overwrite every credential
--   consent_records    : non-tenant identity data, served by identityDb (owner)
-- Nothing in Plan 1a reaches these through makrai_app. Plan 1b grants back
-- deliberately, column-by-column, if the identity path moves to this role.
REVOKE ALL ON "_prisma_migrations" FROM makrai_app;
REVOKE ALL ON "users"              FROM makrai_app;
REVOKE ALL ON "consent_records"    FROM makrai_app;
