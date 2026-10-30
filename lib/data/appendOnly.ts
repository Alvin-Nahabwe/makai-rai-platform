/**
 * The one registry of append-only tables in the schema code (NFR-INT-01 target, SRS line
 * 3074): exactly 00-contract.md's Data model "APPEND_ONLY_TABLES" list. Each refuses UPDATE,
 * DELETE and TRUNCATE for every role, the owner included, also in replica mode, through the
 * refusal triggers of the v0.6.0 migrations (`record_refuse_change()`), or, for
 * `integrity_log`, its own `integrity_log_append_only` trigger.
 *
 * `__tests__/integration/v060-append-only.test.ts` diffs this list against the contract's
 * list and against the triggers pg_trigger holds, so a table cannot be added to one and not
 * the others. `resetDb()` (`__tests__/helpers/db.ts`) and AUTHZ's FR-AUTHZ-03 test read it.
 * Not `framework_versions`: its `status` may move to deprecated (SRS 5.1 line 1208).
 */
export const APPEND_ONLY_TABLES: readonly string[] = Object.freeze([
  'organization_agreements',
  'platform_events',
  'organisation_events',
  'decision_versions',
  'decision_evidence',
  'mitigation_evidence',
  'findings',
  'finding_events',
  'mitigation_versions',
  'accepted_risks',
  'stage_reviews',
  'seals',
  'issued_documents',
  'issued_document_seals',
  'issued_document_sources',
  'document_events',
  'reminder_log',
  'tombstones',
  'request_receipts',
  'evidence',
  'evidence_blobs',
  'consent_records',
  'integrity_log',
]);
