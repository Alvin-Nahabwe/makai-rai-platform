-- v0.6.1: the institution's legal name is recorded on the organisation, not in an agreement record (FR-ORG-01, 06, 10).
--
-- Expand-only (NFR-REL-07; precedent 20261105130000_v060_org_create_receipt): this migration runs before the new
-- image serves, so the old image must keep working against it. Nothing is revoked or dropped, no existing function
-- is replaced, and the widened action CHECK still admits every old value. The old 15-argument
-- admin_create_organisation, admin_record_agreement and admin_correct_org_name stay callable by makrai_identity;
-- a later contract migration revokes them.
--
-- No write to consent_records or organization_agreements: the only data change is the backfill below, which copies
-- values onto organizations and overwrites nothing.

-- The column. Nullable: an organisation from before this release may have no agreement to copy from. The 200 is
-- MAX_LEGAL_NAME (lib/data/admin.ts), the limit the TypeScript validation applies. Adding a nullable column with no
-- default rewrites nothing; the org_isolation and identity_lane policies cover every column of the table.
ALTER TABLE "organizations" ADD COLUMN "legalName" TEXT;
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_legalName_chk"
  CHECK ("legalName" IS NULL OR pg_catalog.length(pg_catalog.btrim("legalName")) BETWEEN 1 AND 200);

-- The backfill: each organisation takes the controller legal name of its newest agreement record. Copies only, fills
-- empty values only (so it is safe to repeat after a rollback of the image), and an organisation with no agreement
-- keeps NULL. Records with the same recordedAt go to the larger id, the order the administrator read shows them in
-- (newestAgreementFirst in lib/data/admin.ts).
UPDATE "organizations" o SET "legalName" = a."controllerLegalName" FROM (SELECT DISTINCT ON ("orgId") "orgId", "controllerLegalName" FROM "organization_agreements" ORDER BY "orgId", "recordedAt" DESC, "id" DESC) a WHERE o."id" = a."orgId" AND o."legalName" IS NULL;

-- Only the definer functions write the column, beside its existing UPDATE ("name"). No application role gains UPDATE.
GRANT UPDATE ("legalName") ON "organizations" TO makrai_definer;

-- The event action of a legal-name correction. Every existing value stays allowed, so the old image is unaffected.
ALTER TABLE "organisation_events" DROP CONSTRAINT "organisation_events_action_check";
ALTER TABLE "organisation_events" ADD CONSTRAINT "organisation_events_action_check"
  CHECK ("action" IN ('organisation_created', 'agreement_recorded', 'owner_invitation_issued',
    'owner_invitation_resent', 'owner_invitation_revoked', 'organisation_name_corrected',
    'account_deactivated', 'account_reactivated',
    'member_invited', 'member_joined', 'member_role_changed', 'member_removed', 'member_left',
    'organisation_legal_name_corrected'));

-- FR-ORG-01: the organisation with its legal name, its first-owner invitation and organisation_created, and no
-- agreement record: the body of the 15-argument function of 20261105130000, with the agreement INSERT removed and
-- legal_name written in the organisation INSERT. Same c_route, lock and replay rules. An overload: no existing
-- signature has these argument types.
CREATE FUNCTION public.admin_create_organisation(actor_user_id text, new_org_id text, org_name text, org_slug text,
    legal_name text, owner_email text, token_hash text, expires_at timestamptz, link_shown boolean,
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
  IF legal_name IS NULL OR pg_catalog.btrim(legal_name) = '' THEN
    RAISE EXCEPTION 'admin_create_organisation: a legal name is required';
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
    INSERT INTO public."organizations" ("id", "name", "slug", "legalName", "updatedAt")
    VALUES (new_org_id, org_name, org_slug, pg_catalog.btrim(legal_name), pg_catalog.now() AT TIME ZONE 'UTC');
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'makrai:slug_taken';
  END;
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

ALTER FUNCTION public.admin_create_organisation(text, text, text, text, text, text, text, timestamptz, boolean, uuid, text) OWNER TO makrai_definer;
REVOKE ALL ON FUNCTION public.admin_create_organisation(text, text, text, text, text, text, text, timestamptz, boolean, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_organisation(text, text, text, text, text, text, text, timestamptz, boolean, uuid, text) TO makrai_identity;

-- FR-ORG-10: correct the institution's legal name; the earlier value (null when there was none) is kept in the
-- change's row. The body of admin_correct_org_name (20261030000500), on "legalName", refusing a blank value.
CREATE FUNCTION public.admin_correct_org_legal_name(actor_user_id text, org_id text, new_legal_name text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_previous text;
  prior_org  text := pg_catalog.current_setting('app.current_org_id', true);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."users" u WHERE u."id" = actor_user_id AND u."role" = 'admin' AND u."isActive") THEN
    RAISE EXCEPTION 'makrai:not_platform_admin';
  END IF;
  IF new_legal_name IS NULL OR pg_catalog.btrim(new_legal_name) = '' THEN
    RAISE EXCEPTION 'admin_correct_org_legal_name: a legal name is required';
  END IF;
  PERFORM pg_catalog.set_config('app.current_org_id', org_id, true);
  SELECT o."legalName" INTO v_previous FROM public."organizations" o WHERE o."id" = admin_correct_org_legal_name.org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'makrai:not_found';
  END IF;
  UPDATE public."organizations" SET "legalName" = pg_catalog.btrim(new_legal_name) WHERE "id" = org_id;
  INSERT INTO public."organisation_events" ("id", "orgId", "actorId", "actorRole", "action", "previousValue")
  VALUES (pg_catalog.gen_random_uuid()::text, org_id, actor_user_id, 'platform_admin', 'organisation_legal_name_corrected', v_previous);
  PERFORM pg_catalog.set_config('app.current_org_id', coalesce(prior_org, ''), true);
  RETURN v_previous;
END
$$;

ALTER FUNCTION public.admin_correct_org_legal_name(text, text, text) OWNER TO makrai_definer;
REVOKE ALL ON FUNCTION public.admin_correct_org_legal_name(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_correct_org_legal_name(text, text, text) TO makrai_identity;
