-- v0.6.0 step 8 (ORG): the identity lane's direct writes revoked (SRS 9.5, line 3673), and one platform administrator (NFR-SEC-19, SRS line 3003)
DO $$
BEGIN
  IF (SELECT count(*) FROM "users" WHERE "role" = 'admin') > 1 THEN
    RAISE EXCEPTION 'v0.6.0 identity revoke: % accounts hold the platform role admin; NFR-SEC-19 allows one. Set the others to assessor on v0.5.x /admin/users, then migrate again.',
      (SELECT count(*) FROM "users" WHERE "role" = 'admin');
  END IF;
END $$;

REVOKE INSERT ON TABLE "organizations", "memberships" FROM makrai_identity;
REVOKE UPDATE ON TABLE "invitations" FROM makrai_identity;

CREATE OR REPLACE FUNCTION users_one_platform_admin() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('users_one_platform_admin', 0));
  IF EXISTS (SELECT 1 FROM "users" WHERE "role" = 'admin' AND "id" <> NEW."id") THEN
    RAISE EXCEPTION 'one platform administrator (NFR-SEC-19): another account already holds the platform role admin';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_one_platform_admin BEFORE INSERT OR UPDATE OF "role" ON "users"
  FOR EACH ROW WHEN (NEW."role" = 'admin') EXECUTE FUNCTION users_one_platform_admin();
