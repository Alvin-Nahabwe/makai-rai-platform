/**
 * The copy the SRS fixes for documents, and the date helper (FR-DOC-02, FR-DOC-03, FR-DOC-05; 7.5.8). Imports only the pure date formatter: S-18's client
 * component imports these words, and `resolve.ts` (which reads content files) cannot go into a browser bundle. `resolve.ts`
 * re-exports them, so the tests and the renderers name them there.
 */

import { formatDay } from '@/lib/format/dates';

export const STATEMENT = 'Generated from this team\'s own records in the MAK-AI RAI Platform. Not an ethics approval, audit, certification or compliance statement.'; // FR-DOC-02, SRS line 1025
export const SEALED_NOTE = 'Sealed by the platform; not independently time-stamped.';   // 6.5, D8, R-56
export const NOT_RECORDED = 'Not recorded';                                           // FR-DOC-02, D1
export const NOT_RECORDED_AT_ISSUE = 'Not recorded at the time of issue';             // FR-DOC-05, D3
export const PROJECT_MARK = 'From the project description when this document was issued; not part of the sealed record'; // FR-DOC-02
export const TYPED_MARK = 'Typed for this document; not part of the sealed record';   // FR-DOC-03
export const NO_EVIDENCE = 'Evidence: none attached';                                 // FR-DOC-02, D9

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** 7.5.8 "2 Nov 2026" from the UTC date of `iso`. A fixed month list: `Intl` prints "Sept" for September on this Node. */
export function formatUtcDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new TypeError('formatUtcDay: not a date');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}


/** The names of the three documents (FR-DOC-01), in S-18's fixed order. */
export const DOCUMENT_TITLES = { data_card: 'Data card', model_card: 'Model card', mitigation_plan: 'Mitigation plan' } as const;

/** The values the data card's ethics review (DC-15, CG-10) takes, and the words S-18 shows for them. */
export const ETHICS_APPROVED = 'approved';
export const ETHICS_SUBMITTED = 'submitted';
export const ETHICS_NOT_REQUIRED = 'not_required';
export const ETHICS_STATES: ReadonlyArray<[value: string, word: string]> = [[ETHICS_APPROVED, 'Approval granted'], [ETHICS_SUBMITTED, 'Submitted, awaiting decision'], [ETHICS_NOT_REQUIRED, 'Not required']];

/** S-18's label on a seal whose stored bytes no longer match its fingerprint (NFR-INT-05); the seal cannot be chosen. */
export const SEAL_CHECK_FAILED = 'Seal check failed';

/** The `ProjectMetadata` columns a document can print, in schema order (ids and `updatedAt` are not fields). */
export const METADATA_KEYS = [
  'aiSystemType', 'aiSystemTypeOther', 'institution', 'department', 'country', 'developmentStage', 'deploymentSector', 'deploymentSectorOther',
  'targetPopulation', 'processesPersonalData', 'datasetSize', 'datasetType', 'datasetTypeOther', 'datasetDescription', 'teamSize',
  'fundingSource', 'regulatoryContext', 'projectStart', 'projectEnd',
] as const;
/** What a `project` source of a field map may name: the project's name and description, or a metadata column. */
export const PROJECT_FIELDS: readonly string[] = ['name', 'description', ...METADATA_KEYS];

// SRS 7.5.6, "Erased text field" and "Erased evidence file": the lines that stand in place of erased text.
export const FILE_NAME_ERASED = 'File name erased';
export const textErasedLine = (date: string): string => `Text erased on ${formatDay(date)} on the organisation's instruction.`;
export const fileErasedLine = (name: string, date: string): string =>
  `${name} . File erased on ${formatDay(date)} on the organisation's instruction. Its fingerprint is kept, so seals that include it still check.`;
/** The gate-derived line (SRS 7.5.6 "Gate-derived N/A", FR-CNT-04). */
export const GATE_DERIVED_NA = 'Not applicable (scope answer: no)';

/**
 * The erasable text fields as erase_text_field names them: [table, key, column] (migration 20261030000500_v060_05_functions, the VALUES
 * list at the top of the function). A tombstone carries the key; the function nulls a document through a source row whose field is the
 * key or the column. `__tests__/unit/document-field-maps.test.ts` reads the migration and fails when this list and the SQL differ.
 */
export const ERASABLE_FIELDS: ReadonlyArray<readonly [table: string, key: string, column: string]> = [
  ['decision_versions', 'reason', 'reason'],
  ['evidence', 'fileName', 'filename'],
  ['evidence', 'url', 'url'],
  ['evidence', 'label', 'label'],
  ['findings', 'title', 'title'],
  ['findings', 'description', 'description'],
  ['finding_events', 'reason', 'reason'],
  ['mitigation_versions', 'what', 'what'],
  ['mitigation_versions', 'changeNote', 'changeNote'],
  ['mitigation_versions', 'closureNote', 'closureNote'],
  ['mitigation_versions', 'cancelReason', 'cancelReason'],
  ['accepted_risks', 'reason', 'reason'],
  ['accepted_risks', 'lookAgainNote', 'lookAgainNote'],
  ['stage_reviews', 'preparedFor', 'preparedFor'],
];

/** The words of the S-18 failure lines (queued for the owner; used as written until the owner rules). Free of any claim about the device. */
export const MSG_PREVIEW_SERVER = 'Not generated: the server had a problem. Try again.';
export const MSG_ISSUE_NO_REPLY = 'Not issued yet: no reply from the server. It may have arrived. Retry is safe: it will not issue twice.';
export const MSG_ROLE_CHANGED = 'Not generated: your role in this organisation no longer allows this. Ask an owner or admin.';
export const MSG_SEAL_CHECK_FAILED = 'This seal cannot be used: its check failed.';

/** One "<day> hh:mm:ss UTC" for an instant (FR-DOC-02: UTC, to the second). */
export function utcSecond(iso: string): string {
  return `${formatUtcDay(iso)} ${new Date(iso).toISOString().slice(11, 19)} UTC`;
}
