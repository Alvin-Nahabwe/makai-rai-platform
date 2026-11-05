/**
 * The copy the SRS fixes for documents, and the date helper (FR-DOC-02, FR-DOC-03, FR-DOC-05; 7.5.8). No imports: S-18's client
 * component imports these words, and `resolve.ts` (which reads content files) cannot go into a browser bundle. `resolve.ts`
 * re-exports them, so the tests and the renderers name them there.
 */

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
export const ETHICS_NOT_REQUIRED = 'not_required';
export const ETHICS_STATES: ReadonlyArray<[value: string, word: string]> = [['approved', 'Approved'], ['submitted', 'Submitted, awaiting decision'], ['not_required', 'Not required']];

/** S-18's label on a seal whose stored bytes no longer match its fingerprint (NFR-INT-05); the seal cannot be chosen. */
export const SEAL_CHECK_FAILED = 'Seal check failed';
