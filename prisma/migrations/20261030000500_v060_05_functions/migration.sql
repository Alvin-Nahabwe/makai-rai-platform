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

-- =========================================================================================
-- Definer part (SRS 9.5 grant table line 3673 and "Operator role" line 3681; FR-ORG-01, 02, 05,
-- 06, 07, 09, 10; FR-ACC-01): one SECURITY DEFINER function per platform-administrator action,
-- and accept_invitation, each owned by the NOLOGIN role makrai_definer, search_path pinned and
-- tables schema-qualified (obligation S3), EXECUTE revoked from PUBLIC and granted to
-- makrai_identity only, each writing its FR-ORG-09 row in the same transaction as the action.
--
-- Errors the caller is meant to see are raised as SQLSTATE P0001 with the message
-- `makrai:<code>`; lib/data/definer.ts maps the code to AppError(status, code). Anything else
-- (a bad argument, a constraint) propagates as it is.
--
-- Every administrator function first checks that its actor is an active account with the
-- platform role admin (obligation S4). The database cannot know who is signed in: the identity
-- lane passes the session's account, and these checks bound what any caller can do with it.
--
-- Organisation context. Every table written here is forced under org_isolation, which binds
-- this role too, so each function sets app.current_org_id to the organisation it acts in before
-- touching that organisation's rows, and restores the earlier value before it returns (the GUC
-- is transaction-local, and accept_invitation runs inside the caller's own transaction). A
-- function that acts on an existing invitation or on an account's memberships is told the
-- organisation ids by its wrapper, which reads them on the identity lane (whose identity_lane
-- policies already show it every invitation and membership); the function re-reads its target
-- under that organisation's context, so a wrong id can only give "not found", never another
-- organisation's row.

-- The definer role's rights (00-contract.md, Data model "Grants"): invitations SELECT, INSERT,
-- UPDATE; memberships SELECT, INSERT; organizations SELECT, INSERT, UPDATE ("name"); users
-- SELECT and UPDATE ("isActive", "sessionEpoch") only, never "role" (finding R2-07; the
-- membership lock's FOR SHARE needs UPDATE on some users column, E-19 T1). Step 2 and step 3
-- gave it INSERT on organization_agreements, platform_events and organisation_events and UPDATE
-- ("voidedAt") on password_reset_tokens; voiding an account's open tokens also reads three
-- columns in its WHERE, which needs SELECT on them.
GRANT SELECT, INSERT, UPDATE ON "invitations" TO makrai_definer;
GRANT SELECT, INSERT ON "memberships" TO makrai_definer;
GRANT SELECT, INSERT ON "organizations" TO makrai_definer;
GRANT UPDATE ("name") ON "organizations" TO makrai_definer;
GRANT SELECT ON "users" TO makrai_definer;
GRANT UPDATE ("isActive", "sessionEpoch") ON "users" TO makrai_definer;
GRANT SELECT ("userId", "usedAt", "voidedAt") ON "password_reset_tokens" TO makrai_definer;

-- FR-ORG-01: the organisation, its agreement record and its first-owner invitation, in one
-- transaction (a failure leaves none); one organisation_created row.
CREATE FUNCTION admin_create_organisation(actor_user_id text, org_name text, org_slug text,
    agreement_version text, agreement_text_hash text, accepted_on date, controller_legal_name text,
    dp_contact_email text, owner_email text, token_hash text, expires_at timestamptz, link_shown boolean)
RETURNS TABLE (org_id text, invitation_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_org       text := gen_random_uuid()::text;
  v_inv       text := gen_random_uuid()::text;
  prior_org   text := current_setting('app.current_org_id', true);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."users" u WHERE u."id" = actor_user_id AND u."role" = 'admin' AND u."isActive") THEN
    RAISE EXCEPTION 'makrai:not_platform_admin';
  END IF;
  PERFORM set_config('app.current_org_id', v_org, true);
  BEGIN
    INSERT INTO public."organizations" ("id", "name", "slug", "updatedAt")
    VALUES (v_org, org_name, org_slug, now() AT TIME ZONE 'UTC');
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'makrai:slug_taken';
  END;
  INSERT INTO public."organization_agreements" ("id", "orgId", "agreementVersion", "textHash", "acceptedOn",
    "controllerLegalName", "dpContactEmail", "recordedById")
  VALUES (gen_random_uuid()::text, v_org, agreement_version, agreement_text_hash, accepted_on,
    controller_legal_name, dp_contact_email, actor_user_id);
  INSERT INTO public."invitations" ("id", "orgId", "email", "role", "tokenHash", "invitedById", "expiresAt", "kind", "linkShownAt")
  VALUES (v_inv, v_org, owner_email, 'owner', token_hash, actor_user_id, expires_at AT TIME ZONE 'UTC', 'first_owner',
    CASE WHEN link_shown THEN date_trunc('milliseconds', clock_timestamp()) END);
  INSERT INTO public."organisation_events" ("id", "orgId", "actorId", "actorRole", "action", "targetInvitationId")
  VALUES (gen_random_uuid()::text, v_org, actor_user_id, 'platform_admin', 'organisation_created', v_inv);
  PERFORM set_config('app.current_org_id', coalesce(prior_org, ''), true);
  org_id := v_org;
  invitation_id := v_inv;
  RETURN NEXT;
END
$$;

-- FR-ORG-05, 06, 10: a newer agreement record; earlier ones are kept (append-only).
CREATE FUNCTION admin_record_agreement(actor_user_id text, org_id text, agreement_version text,
    agreement_text_hash text, accepted_on date, controller_legal_name text, dp_contact_email text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_id      text := gen_random_uuid()::text;
  prior_org text := current_setting('app.current_org_id', true);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."users" u WHERE u."id" = actor_user_id AND u."role" = 'admin' AND u."isActive") THEN
    RAISE EXCEPTION 'makrai:not_platform_admin';
  END IF;
  PERFORM set_config('app.current_org_id', org_id, true);
  IF NOT EXISTS (SELECT 1 FROM public."organizations" o WHERE o."id" = admin_record_agreement.org_id) THEN
    RAISE EXCEPTION 'makrai:not_found';
  END IF;
  INSERT INTO public."organization_agreements" ("id", "orgId", "agreementVersion", "textHash", "acceptedOn",
    "controllerLegalName", "dpContactEmail", "recordedById")
  VALUES (v_id, org_id, agreement_version, agreement_text_hash, accepted_on, controller_legal_name, dp_contact_email, actor_user_id);
  INSERT INTO public."organisation_events" ("id", "orgId", "actorId", "actorRole", "action")
  VALUES (gen_random_uuid()::text, org_id, actor_user_id, 'platform_admin', 'agreement_recorded');
  PERFORM set_config('app.current_org_id', coalesce(prior_org, ''), true);
  RETURN v_id;
END
$$;

-- FR-ORG-02: a new first-owner invitation, only while the organisation has no owner with an
-- active account and no pending first-owner invitation, with the controller's request reference.
CREATE FUNCTION admin_issue_owner_invitation(actor_user_id text, org_id text, owner_email text,
    token_hash text, expires_at timestamptz, request_reference text, link_shown boolean)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_inv     text := gen_random_uuid()::text;
  prior_org text := current_setting('app.current_org_id', true);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."users" u WHERE u."id" = actor_user_id AND u."role" = 'admin' AND u."isActive") THEN
    RAISE EXCEPTION 'makrai:not_platform_admin';
  END IF;
  PERFORM set_config('app.current_org_id', org_id, true);
  -- Serialise issuers for one organisation (two concurrent issues cannot both see "none pending").
  PERFORM 1 FROM public."organizations" o WHERE o."id" = admin_issue_owner_invitation.org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'makrai:not_found';
  END IF;
  IF EXISTS (SELECT 1 FROM public."memberships" m JOIN public."users" u ON u."id" = m."userId"
             WHERE m."orgId" = admin_issue_owner_invitation.org_id AND m."role" = 'owner' AND u."isActive") THEN
    RAISE EXCEPTION 'makrai:active_owner_exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public."invitations" i
             WHERE i."orgId" = admin_issue_owner_invitation.org_id AND i."kind" = 'first_owner' AND i."status" = 'pending'
               AND i."expiresAt" > (now() AT TIME ZONE 'UTC')) THEN
    RAISE EXCEPTION 'makrai:pending_owner_invitation_exists';
  END IF;
  INSERT INTO public."invitations" ("id", "orgId", "email", "role", "tokenHash", "invitedById", "expiresAt", "kind",
    "linkShownAt", "requestReference")
  VALUES (v_inv, org_id, owner_email, 'owner', token_hash, actor_user_id, expires_at AT TIME ZONE 'UTC', 'first_owner',
    CASE WHEN link_shown THEN date_trunc('milliseconds', clock_timestamp()) END, request_reference);
  INSERT INTO public."organisation_events" ("id", "orgId", "actorId", "actorRole", "action", "targetInvitationId", "requestReference")
  VALUES (gen_random_uuid()::text, org_id, actor_user_id, 'platform_admin', 'owner_invitation_issued', v_inv, request_reference);
  PERFORM set_config('app.current_org_id', coalesce(prior_org, ''), true);
  RETURN v_inv;
END
$$;

-- FR-ORG-02: resend a pending first-owner invitation: a new row with a new token, the old one
-- revoked, so the old link stops working.
CREATE FUNCTION admin_resend_invitation(actor_user_id text, org_id text, invitation_id text,
    token_hash text, expires_at timestamptz, link_shown boolean)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_old     record;
  v_inv     text := gen_random_uuid()::text;
  prior_org text := current_setting('app.current_org_id', true);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."users" u WHERE u."id" = actor_user_id AND u."role" = 'admin' AND u."isActive") THEN
    RAISE EXCEPTION 'makrai:not_platform_admin';
  END IF;
  PERFORM set_config('app.current_org_id', org_id, true);
  SELECT i.* INTO v_old FROM public."invitations" i
  WHERE i."orgId" = admin_resend_invitation.org_id AND i."id" = admin_resend_invitation.invitation_id FOR UPDATE;
  IF NOT FOUND OR v_old."kind" <> 'first_owner' OR v_old."status" <> 'pending'
     OR v_old."expiresAt" <= (now() AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'makrai:invitation_not_pending';
  END IF;
  UPDATE public."invitations" SET "status" = 'revoked' WHERE "id" = v_old."id";
  INSERT INTO public."invitations" ("id", "orgId", "email", "role", "tokenHash", "invitedById", "expiresAt", "kind",
    "linkShownAt", "requestReference")
  VALUES (v_inv, org_id, v_old."email", v_old."role", token_hash, actor_user_id, expires_at AT TIME ZONE 'UTC', 'first_owner',
    CASE WHEN link_shown THEN date_trunc('milliseconds', clock_timestamp()) END, v_old."requestReference");
  INSERT INTO public."organisation_events" ("id", "orgId", "actorId", "actorRole", "action", "targetInvitationId", "requestReference")
  VALUES (gen_random_uuid()::text, org_id, actor_user_id, 'platform_admin', 'owner_invitation_resent', v_inv, v_old."requestReference");
  PERFORM set_config('app.current_org_id', coalesce(prior_org, ''), true);
  RETURN v_inv;
END
$$;

-- FR-ORG-02: revoke a pending first-owner invitation.
CREATE FUNCTION admin_revoke_invitation(actor_user_id text, org_id text, invitation_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_old     record;
  prior_org text := current_setting('app.current_org_id', true);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."users" u WHERE u."id" = actor_user_id AND u."role" = 'admin' AND u."isActive") THEN
    RAISE EXCEPTION 'makrai:not_platform_admin';
  END IF;
  PERFORM set_config('app.current_org_id', org_id, true);
  SELECT i.* INTO v_old FROM public."invitations" i
  WHERE i."orgId" = admin_revoke_invitation.org_id AND i."id" = admin_revoke_invitation.invitation_id FOR UPDATE;
  IF NOT FOUND OR v_old."kind" <> 'first_owner' OR v_old."status" <> 'pending'
     OR v_old."expiresAt" <= (now() AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'makrai:invitation_not_pending';
  END IF;
  UPDATE public."invitations" SET "status" = 'revoked' WHERE "id" = v_old."id";
  INSERT INTO public."organisation_events" ("id", "orgId", "actorId", "actorRole", "action", "targetInvitationId", "requestReference")
  VALUES (gen_random_uuid()::text, org_id, actor_user_id, 'platform_admin', 'owner_invitation_revoked', v_old."id", v_old."requestReference");
  PERFORM set_config('app.current_org_id', coalesce(prior_org, ''), true);
END
$$;

-- FR-ORG-07, FR-ACC-06, FR-ORG-09: deactivate or reactivate an account other than the actor's.
-- Deactivation raises sessionEpoch (every session ends at once) and voids the account's open
-- reset tokens; reactivation restores sign-in and no earlier session. Deactivating the only
-- active owner of an organisation needs the controller's request reference. One
-- organisation_events row per organisation the account belongs to (`org_ids`, read by the
-- wrapper on the identity lane and each checked here), or one platform_events row when it
-- belongs to none. Returns the organisations affected.
CREATE FUNCTION admin_set_account_active(actor_user_id text, target_user_id text, make_active boolean,
    request_reference text, org_ids text[])
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_orgs    text[] := ARRAY(SELECT DISTINCT x FROM unnest(coalesce(org_ids, '{}'::text[])) AS x ORDER BY 1);
  o         text;
  v_action  text := CASE WHEN make_active THEN 'account_reactivated' ELSE 'account_deactivated' END;
  prior_org text := current_setting('app.current_org_id', true);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."users" u WHERE u."id" = actor_user_id AND u."role" = 'admin' AND u."isActive") THEN
    RAISE EXCEPTION 'makrai:not_platform_admin';
  END IF;
  IF target_user_id = actor_user_id THEN
    RAISE EXCEPTION 'makrai:self_deactivation';
  END IF;
  PERFORM 1 FROM public."users" u WHERE u."id" = target_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'makrai:not_found';
  END IF;

  FOREACH o IN ARRAY v_orgs LOOP
    PERFORM set_config('app.current_org_id', o, true);
    IF NOT EXISTS (SELECT 1 FROM public."memberships" m WHERE m."orgId" = o AND m."userId" = target_user_id) THEN
      RAISE EXCEPTION 'admin_set_account_active: account % holds no membership in organisation %', target_user_id, o;
    END IF;
    IF NOT make_active AND (request_reference IS NULL OR btrim(request_reference) = '')
       AND EXISTS (SELECT 1 FROM public."memberships" m WHERE m."orgId" = o AND m."userId" = target_user_id AND m."role" = 'owner')
       AND NOT EXISTS (SELECT 1 FROM public."memberships" m JOIN public."users" u ON u."id" = m."userId"
                       WHERE m."orgId" = o AND m."role" = 'owner' AND m."userId" <> target_user_id AND u."isActive") THEN
      RAISE EXCEPTION 'makrai:request_reference_required';
    END IF;
  END LOOP;

  IF make_active THEN
    UPDATE public."users" SET "isActive" = true WHERE "id" = target_user_id;
  ELSE
    UPDATE public."users" SET "isActive" = false, "sessionEpoch" = "sessionEpoch" + 1 WHERE "id" = target_user_id;
    UPDATE public."password_reset_tokens" SET "voidedAt" = date_trunc('milliseconds', clock_timestamp())
    WHERE "userId" = target_user_id AND "usedAt" IS NULL AND "voidedAt" IS NULL;
  END IF;

  IF cardinality(v_orgs) = 0 THEN
    INSERT INTO public."platform_events" ("id", "actorId", "action", "targetUserId", "requestReference")
    VALUES (gen_random_uuid()::text, actor_user_id, v_action, target_user_id, request_reference);
  ELSE
    FOREACH o IN ARRAY v_orgs LOOP
      PERFORM set_config('app.current_org_id', o, true);
      INSERT INTO public."organisation_events" ("id", "orgId", "actorId", "actorRole", "action", "targetUserId", "requestReference")
      VALUES (gen_random_uuid()::text, o, actor_user_id, 'platform_admin', v_action, target_user_id, request_reference);
    END LOOP;
  END IF;
  PERFORM set_config('app.current_org_id', coalesce(prior_org, ''), true);
  RETURN v_orgs;
END
$$;

-- FR-ORG-10: correct the organisation's name; the earlier name is kept in the change's row.
-- Documents already issued keep the name they printed (their bytes are never regenerated).
CREATE FUNCTION admin_correct_org_name(actor_user_id text, org_id text, new_name text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_previous text;
  prior_org  text := current_setting('app.current_org_id', true);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."users" u WHERE u."id" = actor_user_id AND u."role" = 'admin' AND u."isActive") THEN
    RAISE EXCEPTION 'makrai:not_platform_admin';
  END IF;
  PERFORM set_config('app.current_org_id', org_id, true);
  SELECT o."name" INTO v_previous FROM public."organizations" o WHERE o."id" = admin_correct_org_name.org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'makrai:not_found';
  END IF;
  UPDATE public."organizations" SET "name" = new_name WHERE "id" = org_id;
  INSERT INTO public."organisation_events" ("id", "orgId", "actorId", "actorRole", "action", "previousValue")
  VALUES (gen_random_uuid()::text, org_id, actor_user_id, 'platform_admin', 'organisation_name_corrected', v_previous);
  PERFORM set_config('app.current_org_id', coalesce(prior_org, ''), true);
  RETURN v_previous;
END
$$;

-- FR-ACC-01, FR-ORG-09: accept an invitation: the membership and its member_joined row (actorId
-- and targetUserId the joining account, targetInvitationId the invitation; gap G006) in the
-- caller's transaction. Every refusal is the same `invitation_unusable` (M-23): unknown,
-- used, expired or revoked token, a different account's email, an inactive account, a
-- platform administrator (NFR-SEC-04; the membership lock refuses it too), or an existing
-- membership.
CREATE FUNCTION accept_invitation(org_id text, token_hash text, accepting_user_id text)
RETURNS TABLE (accepted_org_id text, accepted_role "OrgRole")
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_inv     record;
  v_user    record;
  prior_org text := current_setting('app.current_org_id', true);
BEGIN
  PERFORM set_config('app.current_org_id', coalesce(org_id, ''), true);
  SELECT i.* INTO v_inv FROM public."invitations" i
  WHERE i."orgId" = accept_invitation.org_id AND i."tokenHash" = accept_invitation.token_hash FOR UPDATE;
  IF NOT FOUND OR v_inv."status" <> 'pending' OR v_inv."expiresAt" <= (now() AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'makrai:invitation_unusable';
  END IF;
  SELECT u."email", u."role", u."isActive" INTO v_user FROM public."users" u WHERE u."id" = accepting_user_id;
  IF NOT FOUND OR lower(v_user."email") <> lower(v_inv."email") OR v_user."role" = 'admin' OR NOT v_user."isActive" THEN
    RAISE EXCEPTION 'makrai:invitation_unusable';
  END IF;
  UPDATE public."invitations" SET "status" = 'accepted', "acceptedAt" = now() AT TIME ZONE 'UTC' WHERE "id" = v_inv."id";
  BEGIN
    INSERT INTO public."memberships" ("id", "orgId", "userId", "role")
    VALUES (gen_random_uuid()::text, v_inv."orgId", accepting_user_id, v_inv."role");
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'makrai:invitation_unusable';
  END;
  INSERT INTO public."organisation_events" ("id", "orgId", "actorId", "actorRole", "action", "targetUserId", "targetInvitationId")
  VALUES (gen_random_uuid()::text, v_inv."orgId", accepting_user_id, v_inv."role"::text, 'member_joined', accepting_user_id, v_inv."id");
  PERFORM set_config('app.current_org_id', coalesce(prior_org, ''), true);
  accepted_org_id := v_inv."orgId";
  accepted_role := v_inv."role";
  RETURN NEXT;
END
$$;

ALTER FUNCTION admin_create_organisation(text, text, text, text, text, date, text, text, text, text, timestamptz, boolean) OWNER TO makrai_definer;
ALTER FUNCTION admin_record_agreement(text, text, text, text, date, text, text) OWNER TO makrai_definer;
ALTER FUNCTION admin_issue_owner_invitation(text, text, text, text, timestamptz, text, boolean) OWNER TO makrai_definer;
ALTER FUNCTION admin_resend_invitation(text, text, text, text, timestamptz, boolean) OWNER TO makrai_definer;
ALTER FUNCTION admin_revoke_invitation(text, text, text) OWNER TO makrai_definer;
ALTER FUNCTION admin_set_account_active(text, text, boolean, text, text[]) OWNER TO makrai_definer;
ALTER FUNCTION admin_correct_org_name(text, text, text) OWNER TO makrai_definer;
ALTER FUNCTION accept_invitation(text, text, text) OWNER TO makrai_definer;

REVOKE ALL ON FUNCTION admin_create_organisation(text, text, text, text, text, date, text, text, text, text, timestamptz, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_record_agreement(text, text, text, text, date, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_issue_owner_invitation(text, text, text, text, timestamptz, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_resend_invitation(text, text, text, text, timestamptz, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_revoke_invitation(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_set_account_active(text, text, boolean, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_correct_org_name(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION accept_invitation(text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION admin_create_organisation(text, text, text, text, text, date, text, text, text, text, timestamptz, boolean) TO makrai_identity;
GRANT EXECUTE ON FUNCTION admin_record_agreement(text, text, text, text, date, text, text) TO makrai_identity;
GRANT EXECUTE ON FUNCTION admin_issue_owner_invitation(text, text, text, text, timestamptz, text, boolean) TO makrai_identity;
GRANT EXECUTE ON FUNCTION admin_resend_invitation(text, text, text, text, timestamptz, boolean) TO makrai_identity;
GRANT EXECUTE ON FUNCTION admin_revoke_invitation(text, text, text) TO makrai_identity;
GRANT EXECUTE ON FUNCTION admin_set_account_active(text, text, boolean, text, text[]) TO makrai_identity;
GRANT EXECUTE ON FUNCTION admin_correct_org_name(text, text, text) TO makrai_identity;
GRANT EXECUTE ON FUNCTION accept_invitation(text, text, text) TO makrai_identity;
