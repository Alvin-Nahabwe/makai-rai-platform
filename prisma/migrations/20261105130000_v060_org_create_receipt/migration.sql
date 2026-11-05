-- v0.6.0: route 41 (create an organisation) retry-safe by request id (NFR-INT-02, owner answer A1; C4 ORG fix round
-- 1, item 1, controller ruling option (A)).
--
-- request_receipts is keyed on ("orgId", "requestId") and its org_isolation policy shows a definer only the rows of
-- the organisation it has set as current, so a receipt cannot be found before its organisation exists. The route
-- therefore derives the new organisation's id from the request: a version-5 UUID of a fixed namespace and
-- "<actorUserId>:<requestId>" (lib/data/definer.ts, organisationIdFor). The same request always names the same
-- organisation, and two actors' request ids never name the same one. This function takes that id and keeps the
-- receipt with idempotentWrite's semantics, as 20261105120000_v060_admin_receipts does for routes 43 and 45: the
-- transaction-scoped advisory lock on (organisation, request id); a receipt replayed only when actor, route and
-- digest all match, 409 request_id_reused otherwise; an organisation that already has the derived id but no
-- matching receipt, 409 request_id_reused too (never slug_taken, which the insert's unique violation would give);
-- otherwise the organisation, agreement, first-owner invitation and event of 20261030000500's function, then the
-- receipt ("rowId" the invitation, "result" NULL: never a token or a link), in one transaction.
--
-- Expand-only (NFR-REL-07): the receipt-less signature stays; makrai_identity loses EXECUTE on it.

CREATE FUNCTION public.admin_create_organisation(actor_user_id text, new_org_id text, org_name text, org_slug text,
    agreement_version text, agreement_text_hash text, accepted_on date, controller_legal_name text,
    dp_contact_email text, owner_email text, token_hash text, expires_at timestamptz, link_shown boolean,
    request_id uuid, request_digest text)
RETURNS TABLE (org_id text, invitation_id text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_route   constant text := 'app/api/admin/organisations/route.ts::POST';
  v_inv     text := pg_catalog.gen_random_uuid()::text;
  prior_org text := pg_catalog.current_setting('app.current_org_id', true);
  v_found   record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."users" u WHERE u."id" = actor_user_id AND u."role" = 'admin' AND u."isActive") THEN
    RAISE EXCEPTION 'makrai:not_platform_admin';
  END IF;
  IF new_org_id IS NULL OR new_org_id = '' OR request_id IS NULL OR request_digest IS NULL OR request_digest = '' THEN
    RAISE EXCEPTION 'admin_create_organisation: an organisation id, a request id and a request digest are required';
  END IF;
  PERFORM pg_catalog.set_config('app.current_org_id', new_org_id, true);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new_org_id || ':' || pg_catalog.lower(request_id::text), 0));
  SELECT r."actorUserId", r."route", r."requestDigest", r."rowId" INTO v_found
  FROM public."request_receipts" r WHERE r."orgId" = new_org_id AND r."requestId" = admin_create_organisation.request_id;
  IF FOUND THEN
    IF v_found."actorUserId" <> actor_user_id OR v_found."route" <> c_route OR v_found."requestDigest" <> request_digest THEN
      RAISE EXCEPTION 'makrai:request_id_reused';
    END IF;
    PERFORM pg_catalog.set_config('app.current_org_id', coalesce(prior_org, ''), true);
    org_id := new_org_id;
    invitation_id := v_found."rowId";
    replayed := true;
    RETURN NEXT;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public."organizations" o WHERE o."id" = new_org_id) THEN
    RAISE EXCEPTION 'makrai:request_id_reused';
  END IF;
  BEGIN
    INSERT INTO public."organizations" ("id", "name", "slug", "updatedAt")
    VALUES (new_org_id, org_name, org_slug, pg_catalog.now() AT TIME ZONE 'UTC');
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'makrai:slug_taken';
  END;
  INSERT INTO public."organization_agreements" ("id", "orgId", "agreementVersion", "textHash", "acceptedOn",
    "controllerLegalName", "dpContactEmail", "recordedById")
  VALUES (pg_catalog.gen_random_uuid()::text, new_org_id, agreement_version, agreement_text_hash, accepted_on,
    controller_legal_name, dp_contact_email, actor_user_id);
  INSERT INTO public."invitations" ("id", "orgId", "email", "role", "tokenHash", "invitedById", "expiresAt", "kind", "linkShownAt")
  VALUES (v_inv, new_org_id, owner_email, 'owner', token_hash, actor_user_id, expires_at AT TIME ZONE 'UTC', 'first_owner',
    CASE WHEN link_shown THEN pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp()) END);
  INSERT INTO public."organisation_events" ("id", "orgId", "actorId", "actorRole", "action", "targetInvitationId")
  VALUES (pg_catalog.gen_random_uuid()::text, new_org_id, actor_user_id, 'platform_admin', 'organisation_created', v_inv);
  INSERT INTO public."request_receipts" ("id", "orgId", "requestId", "requestDigest", "actorUserId", "route", "rowId", "result")
  VALUES (pg_catalog.gen_random_uuid()::text, new_org_id, request_id, request_digest, actor_user_id, c_route, v_inv, NULL);
  PERFORM pg_catalog.set_config('app.current_org_id', coalesce(prior_org, ''), true);
  org_id := new_org_id;
  invitation_id := v_inv;
  replayed := false;
  RETURN NEXT;
END
$$;

ALTER FUNCTION public.admin_create_organisation(text, text, text, text, text, text, date, text, text, text, text, timestamptz, boolean, uuid, text) OWNER TO makrai_definer;
REVOKE ALL ON FUNCTION public.admin_create_organisation(text, text, text, text, text, text, date, text, text, text, text, timestamptz, boolean, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_organisation(text, text, text, text, text, text, date, text, text, text, text, timestamptz, boolean, uuid, text) TO makrai_identity;

REVOKE EXECUTE ON FUNCTION public.admin_create_organisation(text, text, text, text, text, date, text, text, text, text, timestamptz, boolean) FROM makrai_identity;
