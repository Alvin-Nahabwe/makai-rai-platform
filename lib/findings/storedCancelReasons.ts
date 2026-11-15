/**
 * STORED: NEVER REWORD. The cancel reasons the platform itself writes into `mitigation_versions.cancel_reason` when an
 * accepted risk cancels open work (FR-FND-05, 5.3 item 11 rule 2). These are data, not copy: rows keep the value they
 * were written with, so editing one here would change what is stored from then on and leave the old rows unmatched.
 * What a person reads is the copy sentence `FINDINGS_COPY.mitigation.riskAcceptedCancel`, mapped from each value by
 * `cancelReasonText` (lib/findings/labels.ts). A new wording means a new key here, never an edit to an old one.
 *
 * Kept in a module with no imports, rather than in lib/data/findings.ts (the writer), because lib/findings/labels.ts is
 * imported by client components and must not pull the data layer into their bundle.
 */
export const STORED_CANCEL_REASONS = Object.freeze({
  /** Written by acceptances before LD-25 (F7). */
  riskAcceptedBeforeLd25: 'risk accepted',
  /** Written by acceptances from LD-25 on (lane 6, B4 F7). */
  riskAccepted: 'The risk was accepted, so this work was cancelled.',
} as const);
