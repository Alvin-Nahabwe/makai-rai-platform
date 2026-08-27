-- Framework content version 4.0.0 -- flat question weights.
--
-- ADR-0003 makes a published row's contentHash immutable, so this publishes a
-- successor rather than editing 3.0.1.
--
-- MAJOR, not PATCH or MINOR. No question changed, but identical answers now
-- produce different scores, which is a breaking change in meaning. The
-- preceding 3.0.1 was a PATCH precisely because its mapping removal was
-- measured to change zero score cells; this changes them by design.
--
-- What changed:
--   - all 77 non-gate question weights set to 1. They previously correlated
--     with question id at r = -0.538/-0.544/-0.570 by stage -- assigned in
--     document order, never derived from risk. Measured: substituting equal
--     weights moves an area score 2.15 points on average (median 2, p90 5,
--     max 15) while changing the band label in 10.5% of 4,200 sampled scores.
--   - scoringConfig.maturityLevels deleted: a fourth copy of the band ladder
--     that no code read (D-219). It had also gone stale -- its ladder was
--     0/25/50/75 while the live bands are 37.5/62.5/87.5
--     (lib/report/maturityBands.ts BAND_MINIMUMS).
--
-- contentHash below is computeBundleHash()'s output over the four files in
-- lib/framework/bundleHash.ts BUNDLE_FILES, taken AFTER the last content edit
-- and confirmed three ways, the third not sharing a lens with the first two:
-- the compiled module via tsx, framework-hash.test.ts's reported "Received",
-- and an independent coreutils re-derivation of the documented algorithm
-- (sha256 of "<path>:<sha256(bytes)>" joined by newlines).
--
-- SECURITY (derived fresh for this task, AGENTS.md §7.1):
--   - No GRANT/REVOKE here. framework_versions carries no RLS by design
--     (ADR-0003 third lane, no orgId) and makrai_app must keep SELECT ONLY:
--     `status` is the sole gate deciding what new assessments pin to
--     (lib/data/framework.ts:103), so write access for the app role would let
--     an app-level compromise publish an arbitrary content version.
--   - No DELETE and no write to "assessments". The FK is ON DELETE RESTRICT,
--     so deprecating 3.0.1 is a status change that leaves every existing pin
--     intact and resolvable; a pin must never silently vanish.
--   - No ON CONFLICT. _prisma_migrations is the idempotency mechanism; a
--     swallowed conflict here would mask an unexpected re-application of the
--     one migration on this branch that cannot be reverted.
--   - Both statements are in one migration file, hence one transaction, so
--     there is no window in which zero rows are 'published' for the current
--     declared content version.
UPDATE "framework_versions" SET "status" = 'deprecated' WHERE "semver" = '3.0.1';

INSERT INTO "framework_versions" ("id", "semver", "contentHash", "publishedAt", "status")
VALUES (
  'fv_4_0_0',
  '4.0.0',
  'aaf811faf8a094200eddd62977cca58fab04f07e833a18d9e25e4f8bc5b3fa06',
  '2026-08-26T00:00:00Z',
  'published'
);
