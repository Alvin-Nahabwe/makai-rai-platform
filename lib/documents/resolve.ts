/**
 * Field resolution for the data card and the model card (FR-DOC-02, FR-DOC-03, FR-DOC-05; SRS 10.3.1). The copy below is
 * fixed by the SRS; the document tests import these constants rather than repeat the text.
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
