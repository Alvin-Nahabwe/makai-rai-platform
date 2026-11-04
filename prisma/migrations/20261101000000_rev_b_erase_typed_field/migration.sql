-- Erase one document-only value of an issued document (FR-REV-08, SRS line 1011: "erases a
-- document-only field value the same way (each has its own salt)"; SRS 5.6; 00-contract.md,
-- Further cross-unit symbols, gap G022 amended to a separate function).
--
-- A typed field is a value the team typed for one document (issued_documents."typedFields",
-- elements { fieldId, value, salt }, the salt 16 bytes as 32 lowercase hex characters). It is
-- erased as K0a's text-field erasure function (migration 20261030000500_v060_05_functions)
-- erases a free-text column, and with the same rights: SECURITY
-- DEFINER, owned by the NOLOGIN role makrai_operator_fn (so inside it current_user is that role,
-- which record_refuse_change's operator exception recognises), search_path pinned, every table
-- schema-qualified, EXECUTE revoked from PUBLIC and granted to no role. Only the owner role runs
-- it, on a controller's written instruction. K0a's grants already give the operator role
-- SELECT and UPDATE ("pdf", "plainText", "typedFields") on issued_documents, UPDATE
-- ("fieldValues") on document_draft_fields, INSERT on tombstones and UPDATE ("requestDigest") on
-- the eleven retry-keyed tables; this migration adds no grant.
--
-- In this order: the organisation context from org_id; the one document of that organisation,
-- locked; the one typed field of that id still holding a value; the value, its salt, the
-- document's bytes and plain-text copy nulled (the row and its sha256 kept, so a holder's copy
-- still matches); the equal value removed from the project's draft of that document type; one
-- tombstone with the digest of SRS line 1292 over the field name 'typedFields.<fieldId>'; and the
-- issue request's digest replaced by 'erased' on every row of that request in the organisation,
-- since it is SHA-256 of an issue body that held the typed values and would let a guess at one be
-- confirmed (WIO-1). Any refusal raises before anything is written, so it changes nothing.
CREATE FUNCTION erase_typed_field(org_id text, document_id text, field_id text,
                                  erasure_code text, instruction_reference text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n           bigint;
  v_project   text;
  v_type      text;
  v_fields    jsonb;
  v_digest    text;
  v_index     bigint;
  v_element   jsonb;
  v_value     text;
  v_salt      bytea;
  field_name  text;
  t           text;
  prior_org   text := current_setting('app.current_org_id', true);
BEGIN
  IF org_id IS NULL OR btrim(org_id) = '' THEN
    RAISE EXCEPTION 'erase_typed_field: an organisation id is required';
  END IF;
  IF field_id IS NULL OR btrim(field_id) = '' THEN
    RAISE EXCEPTION 'erase_typed_field: a field id is required';
  END IF;
  IF erasure_code IS NULL OR btrim(erasure_code) = '' OR instruction_reference IS NULL OR btrim(instruction_reference) = '' THEN
    RAISE EXCEPTION 'erase_typed_field: an erasure code and an instruction reference are required';
  END IF;
  field_name := 'typedFields.' || field_id;

  PERFORM set_config('app.current_org_id', org_id, true);

  SELECT count(*) INTO n FROM public."issued_documents" d WHERE d."orgId" = org_id AND d."id" = document_id;
  IF n <> 1 THEN
    RAISE EXCEPTION 'erase_typed_field: % documents match % in organisation %; exactly one is required', n, document_id, org_id;
  END IF;

  SELECT d."projectId", d."documentType", d."typedFields", d."requestDigest"
    INTO v_project, v_type, v_fields, v_digest
  FROM public."issued_documents" d WHERE d."orgId" = org_id AND d."id" = document_id
  FOR UPDATE;

  -- The one element with this field id that still holds a value: none means an unknown field id
  -- or one already erased, and two would make the erasure ambiguous.
  SELECT count(*) INTO n FROM jsonb_array_elements(v_fields) AS e(el)
  WHERE e.el ->> 'fieldId' = field_id AND jsonb_typeof(e.el -> 'value') = 'string';
  IF n <> 1 THEN
    RAISE EXCEPTION 'erase_typed_field: % typed fields % with a value in document %; exactly one is required', n, field_id, document_id;
  END IF;
  SELECT e.i - 1, e.el INTO v_index, v_element FROM jsonb_array_elements(v_fields) WITH ORDINALITY AS e(el, i)
  WHERE e.el ->> 'fieldId' = field_id AND jsonb_typeof(e.el -> 'value') = 'string';
  v_value := v_element ->> 'value';
  IF jsonb_typeof(v_element -> 'salt') IS DISTINCT FROM 'string' OR (v_element ->> 'salt') !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'erase_typed_field: typed field % of document % has no 16-byte hex salt to digest with', field_id, document_id;
  END IF;
  v_salt := decode(v_element ->> 'salt', 'hex');

  UPDATE public."issued_documents" d
  SET "typedFields" = jsonb_set(d."typedFields", ARRAY[v_index::text], v_element || '{"value": null, "salt": null}'::jsonb),
      "pdf" = NULL, "plainText" = NULL
  WHERE d."orgId" = org_id AND d."id" = document_id;

  -- The draft holds what the team last typed; it is removed only when it is the erased text.
  UPDATE public."document_draft_fields" f SET "fieldValues" = f."fieldValues" - field_id
  WHERE f."orgId" = org_id AND f."projectId" = v_project AND f."documentType" = v_type
    AND f."fieldValues" ->> field_id = v_value;

  INSERT INTO public."tombstones" ("id", "orgId", "targetTable", "targetId", "field", "digest", "erasureCode", "instructionReference")
  VALUES (gen_random_uuid()::text, org_id, 'issued_documents', document_id, field_name,
          encode(sha256(v_salt || '\x00'::bytea || convert_to(field_name, 'UTF8') || '\x00'::bytea
                        || convert_to(normalize(v_value, NFC), 'UTF8')), 'hex'),
          erasure_code, instruction_reference);

  IF v_digest IS NOT NULL AND v_digest <> 'erased' THEN
    FOREACH t IN ARRAY ARRAY['decision_versions', 'evidence', 'findings', 'finding_events', 'mitigation_versions',
                             'accepted_risks', 'stage_reviews', 'seals', 'issued_documents', 'document_events',
                             'request_receipts'] LOOP
      EXECUTE format('UPDATE public.%I SET "requestDigest" = ''erased'' WHERE "orgId" = $1 AND "requestDigest" = $2', t)
        USING org_id, v_digest;
    END LOOP;
  END IF;

  PERFORM set_config('app.current_org_id', coalesce(prior_org, ''), true);
END
$$;

ALTER FUNCTION erase_typed_field(text, text, text, text, text) OWNER TO makrai_operator_fn;
REVOKE ALL ON FUNCTION erase_typed_field(text, text, text, text, text) FROM PUBLIC;
