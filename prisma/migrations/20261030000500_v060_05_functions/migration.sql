-- v0.6.0 step 5 (SRS 9.5 step 5, line 3689): functions that run with other rights.
--
-- Operator part (SRS 5.6, lines 1302-1310; 00-contract.md, Further cross-unit symbols): the two
-- erasure procedures and makrai_clear_consent_ip_addresses() (gap G099). Each is SECURITY
-- DEFINER and owned by the NOLOGIN role makrai_operator_fn, so inside it current_user is that
-- role, which is what the refusal trigger's operator exception recognises; each sets
-- search_path = pg_catalog, public, pg_temp and schema-qualifies its tables, so a temporary
-- table cannot stand in for one (9.5 rule 6, obligation S3); EXECUTE is revoked from PUBLIC
-- and granted to no role: only the owner role `makrai` (a superuser) runs them, outside any AI
-- session and on a controller's written instruction (ruling 13; obligation S5).
--
-- Each erasure function takes the organisation id, sets the organisation context from it (so
-- org_isolation scopes every read and write to that organisation, obligation S6), refuses
-- unless exactly one target row matches, writes one tombstone, and follows
-- issued_document_sources to null the bytes and plain-text copy of every document that printed
-- the erased field or file, keeping the document row and its sha256.

-- The rights the operator role needs beyond step 3's: removing a blob (DELETE, and SELECT for
-- the WHERE clause), and clearing consent IP addresses (SELECT, UPDATE ("ipAddress")).
GRANT SELECT, DELETE ON "evidence_blobs" TO makrai_operator_fn;
GRANT SELECT, UPDATE ("ipAddress") ON "consent_records" TO makrai_operator_fn;

-- Erase one free-text field (FR-REV-08). `field` is the digest field name of 00-contract.md,
-- Types, "Digest field names" (the manifest key that carries the digest): the column name,
-- except `fileName` for evidence."filename". The digest is the contract's core SQL expression
-- (executed claim E-14), so it equals the digest the sealed manifest holds and the seal check
-- reads the field as erased, not as a mismatch.
CREATE FUNCTION erase_text_field(org_id text, target_table text, target_id text, field text,
                                 erasure_code text, instruction_reference text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  text_col  text;
  salt_col  text;
  n         bigint;
  v_text    text;
  v_salt    bytea;
  prior_org text := current_setting('app.current_org_id', true);
BEGIN
  IF org_id IS NULL OR btrim(org_id) = '' THEN
    RAISE EXCEPTION 'erase_text_field: an organisation id is required';
  END IF;
  IF erasure_code IS NULL OR btrim(erasure_code) = '' OR instruction_reference IS NULL OR btrim(instruction_reference) = '' THEN
    RAISE EXCEPTION 'erase_text_field: an erasure code and an instruction reference are required';
  END IF;

  SELECT c.text_col, c.salt_col INTO text_col, salt_col
  FROM (VALUES
    ('decision_versions',   'reason',        'reason',        'reasonSalt'),
    ('evidence',            'fileName',      'filename',      'filenameSalt'),
    ('evidence',            'url',           'url',           'urlSalt'),
    ('evidence',            'label',         'label',         'labelSalt'),
    ('findings',            'title',         'title',         'titleSalt'),
    ('findings',            'description',   'description',   'descriptionSalt'),
    ('finding_events',      'reason',        'reason',        'reasonSalt'),
    ('mitigation_versions', 'what',          'what',          'whatSalt'),
    ('mitigation_versions', 'changeNote',    'changeNote',    'changeNoteSalt'),
    ('mitigation_versions', 'closureNote',   'closureNote',   'closureNoteSalt'),
    ('mitigation_versions', 'cancelReason',  'cancelReason',  'cancelReasonSalt'),
    ('accepted_risks',      'reason',        'reason',        'reasonSalt'),
    ('accepted_risks',      'lookAgainNote', 'lookAgainNote', 'lookAgainNoteSalt'),
    ('stage_reviews',       'preparedFor',   'preparedFor',   'preparedForSalt')
  ) AS c(tbl, key, text_col, salt_col)
  WHERE c.tbl = target_table AND c.key = field;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'erase_text_field: % is not an erasable field of %', field, target_table;
  END IF;

  PERFORM set_config('app.current_org_id', org_id, true);

  EXECUTE format('SELECT count(*) FROM public.%I WHERE "orgId" = $1 AND "id" = $2', target_table)
    INTO n USING org_id, target_id;
  IF n <> 1 THEN
    RAISE EXCEPTION 'erase_text_field: % rows of % match % in organisation %; exactly one is required',
      n, target_table, target_id, org_id;
  END IF;

  EXECUTE format('SELECT %I, %I FROM public.%I WHERE "orgId" = $1 AND "id" = $2 FOR UPDATE',
                 text_col, salt_col, target_table)
    INTO v_text, v_salt USING org_id, target_id;
  IF v_text IS NULL THEN
    RAISE EXCEPTION 'erase_text_field: %.% of % is already erased or was never written', target_table, field, target_id;
  END IF;
  IF v_salt IS NULL THEN
    RAISE EXCEPTION 'erase_text_field: %.% of % has no salt to digest with', target_table, field, target_id;
  END IF;

  EXECUTE format('UPDATE public.%I SET %I = NULL, %I = NULL WHERE "orgId" = $1 AND "id" = $2',
                 target_table, text_col, salt_col)
    USING org_id, target_id;

  INSERT INTO public."tombstones" ("id", "orgId", "targetTable", "targetId", "field", "digest", "erasureCode", "instructionReference")
  VALUES (gen_random_uuid()::text, org_id, target_table, target_id, field,
          encode(sha256(v_salt || '\x00'::bytea || convert_to(field, 'UTF8') || '\x00'::bytea
                        || convert_to(normalize(v_text, NFC), 'UTF8')), 'hex'),
          erasure_code, instruction_reference);

  UPDATE public."issued_documents" d SET "pdf" = NULL, "plainText" = NULL
  WHERE d."orgId" = org_id
    AND (d."pdf" IS NOT NULL OR d."plainText" IS NOT NULL)
    AND d."id" IN (SELECT s."documentId" FROM public."issued_document_sources" s
                   WHERE s."orgId" = org_id AND s."sourceTable" = target_table AND s."sourceId" = target_id
                     AND s."field" IN (erase_text_field.field, text_col));

  PERFORM set_config('app.current_org_id', coalesce(prior_org, ''), true);
END
$$;

-- Erase an evidence file's bytes (FR-EVD-05): the blob goes, the evidence row and its sha256
-- stay, so the seal still verifies and the file reads as erased.
CREATE FUNCTION erase_evidence_bytes(org_id text, evidence_id text, erasure_code text, instruction_reference text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n         bigint;
  prior_org text := current_setting('app.current_org_id', true);
BEGIN
  IF org_id IS NULL OR btrim(org_id) = '' THEN
    RAISE EXCEPTION 'erase_evidence_bytes: an organisation id is required';
  END IF;
  IF erasure_code IS NULL OR btrim(erasure_code) = '' OR instruction_reference IS NULL OR btrim(instruction_reference) = '' THEN
    RAISE EXCEPTION 'erase_evidence_bytes: an erasure code and an instruction reference are required';
  END IF;

  PERFORM set_config('app.current_org_id', org_id, true);

  SELECT count(*) INTO n FROM public."evidence" e WHERE e."orgId" = org_id AND e."id" = evidence_id;
  IF n <> 1 THEN
    RAISE EXCEPTION 'erase_evidence_bytes: % evidence rows match % in organisation %; exactly one is required',
      n, evidence_id, org_id;
  END IF;

  DELETE FROM public."evidence_blobs" b WHERE b."orgId" = org_id AND b."evidenceId" = evidence_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'erase_evidence_bytes: evidence % has no bytes to erase (already erased, or a link)', evidence_id;
  END IF;

  INSERT INTO public."tombstones" ("id", "orgId", "targetTable", "targetId", "field", "digest", "erasureCode", "instructionReference")
  VALUES (gen_random_uuid()::text, org_id, 'evidence', evidence_id, NULL, NULL, erasure_code, instruction_reference);

  UPDATE public."issued_documents" d SET "pdf" = NULL, "plainText" = NULL
  WHERE d."orgId" = org_id
    AND (d."pdf" IS NOT NULL OR d."plainText" IS NOT NULL)
    AND d."id" IN (SELECT s."documentId" FROM public."issued_document_sources" s
                   WHERE s."orgId" = org_id AND s."sourceTable" = 'evidence' AND s."sourceId" = evidence_id
                     AND s."field" IS NULL);

  PERFORM set_config('app.current_org_id', coalesce(prior_org, ''), true);
END
$$;

-- Clear every consent_records."ipAddress" (gap G099; the 13.8 rollback rule, SRS line 5532):
-- step 6 clears them once, and this lets the owner do it again after a rollback to v0.5.x,
-- whose code still writes the column. Returns the number of rows cleared.
CREATE FUNCTION makrai_clear_consent_ip_addresses()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public."consent_records" SET "ipAddress" = NULL WHERE "ipAddress" IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

ALTER FUNCTION erase_text_field(text, text, text, text, text, text) OWNER TO makrai_operator_fn;
ALTER FUNCTION erase_evidence_bytes(text, text, text, text) OWNER TO makrai_operator_fn;
ALTER FUNCTION makrai_clear_consent_ip_addresses() OWNER TO makrai_operator_fn;
REVOKE ALL ON FUNCTION erase_text_field(text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION erase_evidence_bytes(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION makrai_clear_consent_ip_addresses() FROM PUBLIC;
