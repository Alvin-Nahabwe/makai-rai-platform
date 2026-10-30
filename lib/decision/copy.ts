import type { DecisionStatus, OutsideRole, ScopeAnswer, WithdrawalCode } from '@/types/record';
import type { DecisionVersionView, DeciderView } from '@/types/api';

/**
 * The fixed texts of a decision (SRS 7.5.6, 7.5.7 M-03 and M-11, FR-DEC-01's outside roles, FR-DEC-08's
 * withdrawal codes), shared by the decision service and the S-12 form so each text has one copy. Imports
 * only `types/`, so a client component can import it (00-contract.md, "Further cross-unit symbols").
 *
 * Texts the SRS does not fix are the defaults of owner question B1 (`reviews/owner-questions.md`):
 * `M11.scopeAnswer`, `reasonCode`, `reasonCodeNotAllowed`, `reasonNul`, `dayWithoutMonth`, `monthRange`,
 * `yearFormat`, `unchanged`, `WITHDRAW_COPY.consequence`, and the `REQUEST_MESSAGES` below. An owner answer
 * changes this file and its test only.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** A whole number with a comma between thousands, as M-11 writes the limit ("4,000"). */
function count(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Days in a month of the proleptic Gregorian calendar; `month` is 1 to 12. */
function daysInMonth(month: number, year: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export const STATUS_OPTIONS: ReadonlyArray<{ value: DecisionStatus; label: string; help: string }> = Object.freeze([
  { value: 'done', label: 'Done', help: 'The expected practice is in place.' },
  { value: 'partly', label: 'Partly', help: 'Some of the expected practice is in place.' },
  { value: 'not_yet', label: 'Not yet', help: 'The expected practice is not in place yet.' },
  { value: 'not_applicable', label: 'Not applicable', help: 'The practice does not apply to this project. Say why in the reason.' },
]);

export const FINDING_NOTE = "Saving 'Partly' or 'Not yet' keeps a finding open for this question, or opens one.";

export const SCOPE_OPTIONS: ReadonlyArray<{ value: ScopeAnswer; label: string; help: string }> = Object.freeze([
  { value: 'yes', label: 'Yes', help: 'It contains sensitive or personal information.' },
  { value: 'no', label: 'No', help: 'It does not.' },
  { value: 'not_sure', label: 'Not sure', help: 'We do not know yet. The two personal-data questions stay open.' },
]);

export const REASON_HELP = 'Say what is in place, where it is recorded, and what is missing.';

/** UX-12's live count: "212 / 4,000 characters". */
export function reasonCount(n: number): string {
  return `${count(n)} / 4,000 characters`;
}

/** In the order of `OUTSIDE_ROLES` (types/record.ts), FR-DEC-01's fixed list. */
export const OUTSIDE_ROLE_LABELS: Readonly<Record<OutsideRole, string>> = Object.freeze({
  principal_investigator: 'Principal investigator',
  supervisor: 'Supervisor',
  ethics_committee: 'Ethics committee',
  data_access_committee: 'Data-access committee',
  institutional_dpo: 'Institutional data-protection officer',
  funder: 'Funder',
  other: 'Other',
});

export const WITHDRAWAL_CODE_LABELS: Readonly<Record<WithdrawalCode, string>> = Object.freeze({
  entered_in_error: 'Entered in error',
  wrong_project: 'Wrong project',
  duplicate: 'Duplicate',
  test_entry: 'Test entry',
});

/** M-11's field messages; the field each belongs to is the `SaveDecisionRequest` key (7.4.1 "Validation errors"). */
export const M11: Readonly<{
  status: string; scopeAnswer: string; reasonMissing: string; reasonTooLong: (n: number) => string;
  reasonNul: string; reasonCode: string; reasonCodeNotAllowed: string; decidedBy: string;
  yearMissing: string; dayWithoutMonth: string; monthRange: string; yearFormat: string;
  dateLater: string; monthDays: (month: number, year: number) => string; webAddress: string; unchanged: (n: number) => string;
}> = Object.freeze({
  status: 'Choose a status.',
  scopeAnswer: 'Choose a scope answer.',
  reasonMissing: 'Write a reason. Say what is in place, where it is recorded, and what is missing.',
  reasonTooLong: (n: number) => `The reason is ${count(n)} characters. The limit is 4,000.`,
  reasonNul: 'The reason contains a character that cannot be stored. Remove it and save again.',
  reasonCode: 'Choose a reason code.',
  reasonCodeNotAllowed: 'Choose a reason code from the list for this status.',
  decidedBy: 'Choose who decided.',
  yearMissing: 'Enter at least the year the decision was made.',
  dayWithoutMonth: 'Enter the month, or leave the day empty.',
  monthRange: 'Enter a month from 1 to 12.',
  yearFormat: 'Enter the year as four digits, for example 2026.',
  dateLater: 'The date cannot be later than today.',
  monthDays: (month: number, year: number) => `${MONTHS[month - 1]} has ${daysInMonth(month, year)} days.`,
  webAddress: 'Enter a web address that starts with http:// or https://.',
  unchanged: (n: number) => `This is the same as version ${n}. Change something before saving, or keep version ${n}.`,
});

/**
 * Field messages for requests the S-12 form never sends (a hand-made or stale request: a status on the scope
 * question, options the question does not have, a question the running content does not hold). Not in the
 * contract's symbol list; the server and the shared rules use them so every refusal names its field.
 */
export const REQUEST_MESSAGES = Object.freeze({
  body: 'The request body must be a JSON object.',
  requestId: 'requestId must be a UUID (8-4-4-4-12 hexadecimal).',
  stage: 'Choose the stage this question belongs to.',
  questionId: 'This question is not in the content version in use. Reload the page.',
  baseVersionNumber: 'Name the version this decision starts from, or none for a first decision.',
  statusOnScope: 'The scope question takes a scope answer, not a status.',
  scopeOnPractice: 'Only the scope question takes a scope answer.',
  optionsNotOfQuestion: 'Choose options from this question only, each once.',
  optionsOnPractice: 'Only a checklist question has options to choose.',
  evidenceIds: 'Attach each evidence item once.',
  evidenceTooMany: 'Attach at most 100 evidence items to one decision.',
  withdrawalCode: 'Choose a withdrawal code.',
  noCurrentDecision: 'There is no current decision to withdraw.',
});

/** M-11's summary: "There is a problem with this decision. Your answer is kept." */
export function problemSummary(n: number): string {
  return n === 1
    ? 'There is a problem with this decision. Your answer is kept.'
    : `There are ${count(n)} problems with this decision. Your answer is kept.`;
}

/**
 * Who decided. `record` (S-13, documents) follows 7.5.8: a member by account name, a former member
 * "(former member)" (call R-19), an outside role "(outside role)". `confirmation` (M-03, UX-11's test text,
 * SRS line 2311) says "you" for the viewer, the name for another member, and the bare role label.
 */
export function deciderLabel(d: DeciderView, viewerId: string, form: 'confirmation' | 'record'): string {
  if (d.kind === 'outside_role') {
    const label = OUTSIDE_ROLE_LABELS[d.role];
    return form === 'record' ? `${label} (outside role)` : label;
  }
  if (form === 'confirmation' && d.user.userId === viewerId) return 'you';
  return d.user.formerMember ? `${d.user.name} (former member)` : d.user.name;
}

/** M-03: "Saved as version <n> at <time>. Decided by: <decider>. Entered by: you." */
export function savedMessage(v: DecisionVersionView, timeText: string, viewerId: string): string {
  const entered = v.enteredBy.userId === viewerId ? 'you' : v.enteredBy.name;
  const decided = v.decidedBy === null ? '' : ` Decided by: ${deciderLabel(v.decidedBy, viewerId, 'confirmation')}.`;
  return `Saved as version ${v.versionNumber} at ${timeText}.${decided} Entered by: ${entered}.`;
}

/** UX-29: the inline confirmation of a withdrawal names the object and the consequence; its button repeats the action. */
export const WITHDRAW_COPY: Readonly<{
  trigger: string; action: string; objectName: (versionNumber: number, questionId: string) => string; consequence: string;
}> = Object.freeze({
  trigger: 'Withdraw this decision',
  action: 'Withdraw decision',
  objectName: (versionNumber: number, questionId: string) => `Version ${versionNumber} of the decision on ${questionId}`,
  consequence: 'The question returns to "no decision". Every version stays in the history.',
});
