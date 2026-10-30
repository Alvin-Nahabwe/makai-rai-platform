-- v0.6.0 step 1 (SRS 9.5 step 1, line 3685): the two NOLOGIN roles and the two record
-- trigger functions every later step uses. No extension is installed (00-contract.md, Data
-- model "Salts"; finding F02): the salt default is the core expression written on each salt
-- column in steps 2 and 3.
--
-- makrai_operator_fn owns the erasure functions (SRS 5.6, line 1304) and is the one role the
-- refusal triggers let null an erasable column or delete an evidence blob (SRS 5.3 item 1,
-- line 1258). makrai_definer owns the administrator functions and accept_invitation (SRS
-- line 3681). Both are NOLOGIN, and no role is a member of either: only a superuser can
-- SET ROLE to them, and the application roles reach them only through the functions they
-- own (SECURITY DEFINER).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'makrai_operator_fn') THEN
    CREATE ROLE makrai_operator_fn NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'makrai_definer') THEN
    CREATE ROLE makrai_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;

-- Idempotent if a role pre-existed with other attributes (as 20261008000100 does for
-- makrai_identity).
ALTER ROLE makrai_operator_fn NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE makrai_definer     NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

-- No role may hold membership IN either role (a member could SET ROLE to it). Since
-- PostgreSQL 16 a REVOKE removes only the named grantor's grant, so each is revoked
-- GRANTED BY its grantor.
DO $$
DECLARE
  m record;
BEGIN
  FOR m IN
    SELECT g.rolname AS granted, r.rolname AS member, gr.rolname AS grantor
    FROM pg_auth_members a
    JOIN pg_roles g ON g.oid = a.roleid
    JOIN pg_roles r ON r.oid = a.member
    LEFT JOIN pg_roles gr ON gr.oid = a.grantor
    WHERE g.rolname IN ('makrai_operator_fn', 'makrai_definer')
  LOOP
    IF m.grantor IS NULL THEN
      EXECUTE format('REVOKE %I FROM %I', m.granted, m.member);
    ELSE
      EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', m.granted, m.member, m.grantor);
    END IF;
  END LOOP;
END $$;

-- A function owner must be able to resolve the schema's objects; table rights are granted
-- table by table in the later steps.
GRANT USAGE ON SCHEMA public TO makrai_operator_fn, makrai_definer;

-- The append-only refusal (SRS 5.3 item 1; NFR-INT-01). Attached to every append-only table
-- twice, both ENABLE ALWAYS so session_replication_role = replica does not silence them:
--   * BEFORE UPDATE OR DELETE OR TRUNCATE, FOR EACH STATEMENT: refuses every statement,
--     including one that would touch no row and INSERT ... ON CONFLICT DO UPDATE, except
--     an UPDATE or DELETE by makrai_operator_fn on a table that has an operator exception,
--     whose rows the row trigger then checks;
--   * BEFORE UPDATE OR DELETE, FOR EACH ROW: lets through only the operator's exception,
--     row by row.
-- The operator exception is exactly SRS 5.3 item 1 and 5.6: nulling an erasable free-text
-- column together with its salt; nulling an issued document's bytes or plain-text copy, or
-- one typed field's value and salt together; nulling consent_records."ipAddress" (gap
-- G099); deleting an evidence_blobs row. Nothing else changes, and no value is rewritten.
-- It is recognised by current_user only: this function reads no setting (obligation S15),
-- so no session variable can switch it off.
CREATE FUNCTION record_refuse_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pairs text[];
  o jsonb;
  n jsonb;
  k text;
  p text[];
  ot jsonb;
  nt jsonb;
  oe jsonb;
  ne jsonb;
  i int;
  ok boolean;
BEGIN
  IF current_user = 'makrai_operator_fn' AND TG_OP IN ('UPDATE', 'DELETE') THEN
    IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'evidence_blobs' THEN
      IF TG_LEVEL = 'STATEMENT' THEN RETURN NULL; END IF;
      RETURN OLD;
    END IF;

    -- Each erasable column with the salt that is nulled with it ({col, col} when the
    -- column has no salt).
    pairs := CASE TG_TABLE_NAME
      WHEN 'decision_versions'   THEN ARRAY[['reason', 'reasonSalt']]
      WHEN 'evidence'            THEN ARRAY[['filename', 'filenameSalt'], ['url', 'urlSalt'], ['label', 'labelSalt']]
      WHEN 'findings'            THEN ARRAY[['title', 'titleSalt'], ['description', 'descriptionSalt']]
      WHEN 'finding_events'      THEN ARRAY[['reason', 'reasonSalt']]
      WHEN 'mitigation_versions' THEN ARRAY[['what', 'whatSalt'], ['changeNote', 'changeNoteSalt'],
                                            ['closureNote', 'closureNoteSalt'], ['cancelReason', 'cancelReasonSalt']]
      WHEN 'accepted_risks'      THEN ARRAY[['reason', 'reasonSalt'], ['lookAgainNote', 'lookAgainNoteSalt']]
      WHEN 'stage_reviews'       THEN ARRAY[['preparedFor', 'preparedForSalt']]
      WHEN 'issued_documents'    THEN ARRAY[['pdf', 'pdf'], ['plainText', 'plainText']]
      WHEN 'consent_records'     THEN ARRAY[['ipAddress', 'ipAddress']]
    END;

    IF TG_OP = 'UPDATE' AND pairs IS NOT NULL THEN
      IF TG_LEVEL = 'STATEMENT' THEN RETURN NULL; END IF;

      o := to_jsonb(OLD);
      n := to_jsonb(NEW);
      ok := true;

      -- Every changed column must be an erasable one, changed to null; typedFields may
      -- change only element by element, as below.
      FOR k IN SELECT jsonb_object_keys(o) LOOP
        CONTINUE WHEN (o -> k) IS NOT DISTINCT FROM (n -> k);
        IF k = 'typedFields' AND TG_TABLE_NAME = 'issued_documents' THEN
          ot := o -> k;
          nt := n -> k;
          IF jsonb_typeof(ot) <> 'array' OR jsonb_typeof(nt) <> 'array'
             OR jsonb_array_length(ot) <> jsonb_array_length(nt) THEN
            ok := false;
          ELSE
            FOR i IN 0 .. jsonb_array_length(ot) - 1 LOOP
              oe := ot -> i;
              ne := nt -> i;
              CONTINUE WHEN oe IS NOT DISTINCT FROM ne;
              -- Only "value" and "salt" may change, both to null, and both keys stay.
              IF jsonb_typeof(oe) <> 'object' OR jsonb_typeof(ne) <> 'object'
                 OR (oe - 'value' - 'salt') IS DISTINCT FROM (ne - 'value' - 'salt')
                 OR NOT (ne ? 'value' AND ne ? 'salt')
                 OR jsonb_typeof(ne -> 'value') <> 'null' OR jsonb_typeof(ne -> 'salt') <> 'null' THEN
                ok := false;
              END IF;
            END LOOP;
          END IF;
        ELSIF NOT EXISTS (SELECT 1 FROM unnest(pairs) AS c WHERE c = k)
              OR jsonb_typeof(n -> k) <> 'null' THEN
          ok := false;
        END IF;
        EXIT WHEN NOT ok;
      END LOOP;

      -- A text and its salt are erased together (SRS line 1306).
      IF ok THEN
        FOREACH p SLICE 1 IN ARRAY pairs LOOP
          IF ((o -> p[1]) IS DISTINCT FROM (n -> p[1]) OR (o -> p[2]) IS DISTINCT FROM (n -> p[2]))
             AND (jsonb_typeof(n -> p[1]) <> 'null' OR jsonb_typeof(n -> p[2]) <> 'null') THEN
            ok := false;
          END IF;
        END LOOP;
      END IF;

      IF ok THEN RETURN NEW; END IF;
    END IF;
  END IF;

  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP;
END
$$;

-- The database clock for a "(db)" time column (SRS 5.3 item 5; FR-DEC-09; NFR-INT-04): a
-- BEFORE INSERT row trigger that overwrites the column named by its first argument with
-- clock_timestamp() cut to milliseconds, whatever the writer sent. With 'transaction' as
-- the second argument it writes transaction_timestamp() instead, so a seal builder that
-- reads `SELECT date_trunc('milliseconds', transaction_timestamp())` earlier in its
-- transaction writes the same instant into the manifest (gap G012; executed claim E-19
-- T5).
CREATE FUNCTION record_set_db_time() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ts timestamptz;
BEGIN
  IF TG_NARGS > 1 AND TG_ARGV[1] = 'transaction' THEN
    ts := date_trunc('milliseconds', transaction_timestamp());
  ELSE
    ts := date_trunc('milliseconds', clock_timestamp());
  END IF;
  NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], ts));
  RETURN NEW;
END
$$;
