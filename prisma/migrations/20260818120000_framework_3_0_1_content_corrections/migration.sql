-- Framework content version 3.0.1 -- citation and mapping corrections.
--
-- ADR-0003 makes a published row's contentHash immutable: "an operator who
-- publishes a bad contentHash needs a new migration to correct it, not a
-- one-line update". The 2026-08-18 content audit corrected content in all
-- three bundle files, so the bundle hash changed and 3.0.0 no longer
-- describes what ships. This publishes a successor rather than editing the
-- existing row.
--
-- What changed (docs/audits/2026-08-18-framework-content-audit.md):
--   - PP-03 carried PO-07's DOI; IP-07's DOI was unregistered
--   - four quoted figures did not match their sources
--   - the sole African Union link 404'd; three EU AI Act links pointed at an
--     unofficial mirror still serving the June 2024 text
--   - seven cross-stage rule citations named the wrong clause, or no source
--   - C-28 was reachable from no area
--   - nine backward cross-stage mappings contradicted the forward-only design
--
-- PATCH rather than MINOR: the mapping removal was measured against the
-- engine before and after and changed ZERO area or principle score cells,
-- confirming ENG-03's finding that backward mappings never reached the score.
-- They drove only which areas a report lists as gaps.

UPDATE "framework_versions" SET "status" = 'deprecated' WHERE "semver" = '3.0.0';

INSERT INTO "framework_versions" ("id", "semver", "contentHash", "publishedAt", "status")
VALUES (
  'fv_3_0_1',
  '3.0.1',
  'bed9e13c3958d5979322ba90565470e70f60af35c5689b12ff830baf03e615ed',
  '2026-08-18T00:00:00Z',
  'published'
);
