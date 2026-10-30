-- v0.6.0 (ACC-a): consent_records never stores a client address (SRS 9.5 step 6, line 3690), whoever inserts.
-- A trigger, not a CHECK: a CHECK on a table v0.5.0 writes breaks NFR-REL-07 (SRS line 3166).
CREATE OR REPLACE FUNCTION consent_records_null_ip() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW."ipAddress" := NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_records_null_ip BEFORE INSERT ON "consent_records"
  FOR EACH ROW EXECUTE FUNCTION consent_records_null_ip();
ALTER TABLE "consent_records" ENABLE ALWAYS TRIGGER consent_records_null_ip;
