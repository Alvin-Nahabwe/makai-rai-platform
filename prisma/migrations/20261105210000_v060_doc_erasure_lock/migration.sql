-- DOC-a C4 fix round 2, I1: an erasure and a document issue that overlap must not miss each other.
-- erase_text_field and erase_evidence_bytes take an exclusive transaction-level advisory lock keyed by the
-- organisation before they read or write anything; the issue write of lib/data/documents.ts takes the
-- shared form of the same key just before its check for newer erasures. Whichever holds the lock first,
-- the other sees its committed result (READ COMMITTED: each later statement has a fresh snapshot).
-- Expand-only: the bodies are those of 20261030000500 with one added statement; signatures, owner, grants
-- and SECURITY DEFINER are unchanged (CREATE OR REPLACE keeps owner and grants).
-- erase_typed_field edits an issued document in place and does not null by source, so it needs no lock;
-- the two functions here are the only ones that null issued_documents by source.

CREATE OR REPLACE FUNCTION erase_text_field(org_id text, target_table text, target_id text, field text,
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
  v_digest  text;
  t         text;
  prior_org text := current_setting('app.current_org_id', true);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('makrai.erasure:' || org_id::text, 0));
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

  EXECUTE format('SELECT %I, %I, "requestDigest" FROM public.%I WHERE "orgId" = $1 AND "id" = $2 FOR UPDATE',
                 text_col, salt_col, target_table)
    INTO v_text, v_salt, v_digest USING org_id, target_id;
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

  -- The request digest of every row of the same request in this organisation (rows made under
  -- derived request ids carry the same digest), replaced by 'erased'.
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

CREATE OR REPLACE FUNCTION erase_evidence_bytes(org_id text, evidence_id text, erasure_code text, instruction_reference text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n         bigint;
  v_digest  text;
  t         text;
  prior_org text := current_setting('app.current_org_id', true);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('makrai.erasure:' || org_id::text, 0));
  IF org_id IS NULL OR btrim(org_id) = '' THEN
    RAISE EXCEPTION 'erase_evidence_bytes: an organisation id is required';
  END IF;
  IF erasure_code IS NULL OR btrim(erasure_code) = '' OR instruction_reference IS NULL OR btrim(instruction_reference) = '' THEN
    RAISE EXCEPTION 'erase_evidence_bytes: an erasure code and an instruction reference are required';
  END IF;

  PERFORM set_config('app.current_org_id', org_id, true);

  SELECT count(*), max(e."requestDigest") INTO n, v_digest FROM public."evidence" e WHERE e."orgId" = org_id AND e."id" = evidence_id;
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

  -- As erase_text_field: the upload request's digest, on every row of that request here.
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
