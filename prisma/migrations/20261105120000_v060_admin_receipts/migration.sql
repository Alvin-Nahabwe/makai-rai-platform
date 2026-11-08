-- v0.6.0: routes 43 and 45 retry-safe by request id (NFR-INT-02, owner answer A1; controller ruling on ORG
-- round 1105, option (a)).
--
-- The administrator's routes write through SECURITY DEFINER functions on the identity lane, so idempotentWrite's
-- receipt mode (a tenant-lane transaction under an OrgContext) cannot serve them: the administrator is a member of
-- no organisation. These two functions keep the receipt themselves, with idempotentWrite's semantics
-- (lib/data/idempotency.ts, receiptWrite): the same transaction-scoped advisory lock on (organisation, request
-- id); a receipt in "request_receipts" keyed on ("orgId", "requestId"), replayed only when the actor, the route
-- and the request digest all match and answered 409 request_id_reused otherwise; no receipt, the write and then the
-- receipt in the same transaction. "rowId" is the row the route answers with; "result" is NULL (the routes keep no
-- other field: never a token or a link).
--
-- Expand-only (NFR-REL-07): the earlier signatures are not dropped; makrai_identity loses EXECUTE on them, so every
-- call goes through a receipt. makrai_definer gains SELECT and INSERT on request_receipts, nothing more (ADR-0009,
-- "Function-owner grants"); the table's org_isolation policy binds it, so each function sets app.current_org_id.

GRANT SELECT, INSERT ON public."request_receipts" TO makrai_definer;

CREATE FUNCTION public.admin_record_agreement(actor_user_id text, org_id text, agreement_version text,
    agreement_text_hash text, accepted_on date, controller_legal_name text, dp_contact_email text,
    request_id uuid, request_digest text)
RETURNS TABLE (agreement_id text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_route   constant text := 'app/api/admin/organisations/[orgId]/agreements/route.ts::POST';
  prior_org text := pg_catalog.current_setting('app.current_org_id', true);
  v_found   record;
  v_id      text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."users" u WHERE u."id" = actor_user_id AND u."role" = 'admin' AND u."isActive") THEN
    RAISE EXCEPTION 'makrai:not_platform_admin';
  END IF;
  IF request_id IS NULL OR request_digest IS NULL OR request_digest = '' THEN
    RAISE EXCEPTION 'admin_record_agreement: a request id and a request digest are required';
  END IF;
  PERFORM pg_catalog.set_config('app.current_org_id', org_id, true);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(org_id || ':' || pg_catalog.lower(request_id::text), 0));
  SELECT r."actorUserId", r."route", r."requestDigest", r."rowId" INTO v_found
  FROM public."request_receipts" r WHERE r."orgId" = admin_record_agreement.org_id AND r."requestId" = admin_record_agreement.request_id;
  IF FOUND THEN
    IF v_found."actorUserId" <> actor_user_id OR v_found."route" <> c_route OR v_found."requestDigest" <> request_digest THEN
      RAISE EXCEPTION 'makrai:request_id_reused';
    END IF;
    PERFORM pg_catalog.set_config('app.current_org_id', coalesce(prior_org, ''), true);
    RETURN QUERY SELECT v_found."rowId", true;
    RETURN;
  END IF;
  v_id := public.admin_record_agreement(actor_user_id, org_id, agreement_version, agreement_text_hash, accepted_on,
    controller_legal_name, dp_contact_email);
  PERFORM pg_catalog.set_config('app.current_org_id', org_id, true);
  INSERT INTO public."request_receipts" ("id", "orgId", "requestId", "requestDigest", "actorUserId", "route", "rowId", "result")
  VALUES (pg_catalog.gen_random_uuid()::text, org_id, request_id, request_digest, actor_user_id, c_route, v_id, NULL);
  PERFORM pg_catalog.set_config('app.current_org_id', coalesce(prior_org, ''), true);
  RETURN QUERY SELECT v_id, false;
END
$$;

CREATE FUNCTION public.admin_resend_invitation(actor_user_id text, org_id text, invitation_id text,
    token_hash text, expires_at timestamptz, link_shown boolean, request_id uuid, request_digest text)
RETURNS TABLE (new_invitation_id text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_route   constant text := 'app/api/admin/organisations/[orgId]/owner-invitations/[invitationId]/resend/route.ts::POST';
  prior_org text := pg_catalog.current_setting('app.current_org_id', true);
  v_found   record;
  v_id      text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."users" u WHERE u."id" = actor_user_id AND u."role" = 'admin' AND u."isActive") THEN
    RAISE EXCEPTION 'makrai:not_platform_admin';
  END IF;
  IF request_id IS NULL OR request_digest IS NULL OR request_digest = '' THEN
    RAISE EXCEPTION 'admin_resend_invitation: a request id and a request digest are required';
  END IF;
  PERFORM pg_catalog.set_config('app.current_org_id', org_id, true);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(org_id || ':' || pg_catalog.lower(request_id::text), 0));
  -- Before the invitation's state is checked: a replay of a resend whose old row is now revoked answers as the
  -- first call did (as MEM's resend does), not 409 invitation_not_pending.
  SELECT r."actorUserId", r."route", r."requestDigest", r."rowId" INTO v_found
  FROM public."request_receipts" r WHERE r."orgId" = admin_resend_invitation.org_id AND r."requestId" = admin_resend_invitation.request_id;
  IF FOUND THEN
    IF v_found."actorUserId" <> actor_user_id OR v_found."route" <> c_route OR v_found."requestDigest" <> request_digest THEN
      RAISE EXCEPTION 'makrai:request_id_reused';
    END IF;
    PERFORM pg_catalog.set_config('app.current_org_id', coalesce(prior_org, ''), true);
    RETURN QUERY SELECT v_found."rowId", true;
    RETURN;
  END IF;
  v_id := public.admin_resend_invitation(actor_user_id, org_id, invitation_id, token_hash, expires_at, link_shown);
  PERFORM pg_catalog.set_config('app.current_org_id', org_id, true);
  INSERT INTO public."request_receipts" ("id", "orgId", "requestId", "requestDigest", "actorUserId", "route", "rowId", "result")
  VALUES (pg_catalog.gen_random_uuid()::text, org_id, request_id, request_digest, actor_user_id, c_route, v_id, NULL);
  PERFORM pg_catalog.set_config('app.current_org_id', coalesce(prior_org, ''), true);
  RETURN QUERY SELECT v_id, false;
END
$$;

ALTER FUNCTION public.admin_record_agreement(text, text, text, text, date, text, text, uuid, text) OWNER TO makrai_definer;
ALTER FUNCTION public.admin_resend_invitation(text, text, text, text, timestamptz, boolean, uuid, text) OWNER TO makrai_definer;

REVOKE ALL ON FUNCTION public.admin_record_agreement(text, text, text, text, date, text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_resend_invitation(text, text, text, text, timestamptz, boolean, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_record_agreement(text, text, text, text, date, text, text, uuid, text) TO makrai_identity;
GRANT EXECUTE ON FUNCTION public.admin_resend_invitation(text, text, text, text, timestamptz, boolean, uuid, text) TO makrai_identity;

-- The receipt-less signatures stay (expand-only) and remain callable by their owner, which the two functions above
-- call; no lane may call them directly any more.
REVOKE EXECUTE ON FUNCTION public.admin_record_agreement(text, text, text, text, date, text, text) FROM makrai_identity;
REVOKE EXECUTE ON FUNCTION public.admin_resend_invitation(text, text, text, text, timestamptz, boolean) FROM makrai_identity;
