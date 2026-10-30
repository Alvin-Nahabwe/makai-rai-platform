-- v0.6.0 step 7 (SRS 9.5 step 7, line 3691): data steps. A pending invitation whose expiry
-- has passed is marked expired, so the state a person sees is the stored one (FR-ORG-02,
-- FR-MEM-02; the membership step ran first, as step 0).
--
-- invitations."expiresAt" is TIMESTAMP(3) without a time zone, written by Prisma in UTC, so
-- it is compared with the current time in UTC whatever the session's TimeZone is.
-- Rerunnable: a second run finds no pending invitation past its expiry.
UPDATE "invitations"
SET "status" = 'expired'
WHERE "status" = 'pending'
  AND "expiresAt" < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
