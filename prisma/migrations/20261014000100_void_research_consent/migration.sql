-- Task 15 (G2-13 (b), G2-14 (b)): the per-user research tick box is withdrawn.
--
-- No approved research protocol exists (vision 5.6; owner decision D.4), so no consent to
-- research can be real. Stored values are KEPT, because a consent record is audit evidence
-- of what the person was shown and clicked, and marked VOID so nothing reads them as live.
-- The two CHECK constraints keep it that way: the previous application image writes a
-- research row when the box is ticked, and the CHECK refuses that sign-up (rollback caveat).
--
-- Terms of service and privacy policy rows are untouched.
ALTER TABLE "consent_records" ADD COLUMN "voidedAt" TIMESTAMP(3), ADD COLUMN "voidReason" TEXT;
ALTER TABLE "users" ADD COLUMN "researchConsentVoidedAt" TIMESTAMP(3);
UPDATE "consent_records" SET "voidedAt" = CURRENT_TIMESTAMP,
  "voidReason" = 'Per-user research tick box withdrawn at M0: no approved research protocol existed (vision §5.6; owner decision D.4).'
  WHERE "consentType" = 'research_data_usage' AND "voidedAt" IS NULL;
UPDATE "users" SET "researchConsentVoidedAt" = CURRENT_TIMESTAMP WHERE "researchConsentVoidedAt" IS NULL;
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_research_void_chk"
  CHECK ("consentType" <> 'research_data_usage' OR "voidedAt" IS NOT NULL);
ALTER TABLE "users" ADD CONSTRAINT "users_research_consent_void_chk"
  CHECK (NOT "researchConsent" OR "researchConsentVoidedAt" IS NOT NULL);
