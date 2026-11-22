import type { DecisionStatus, DeclaredDate, OutsideRole, ScopeAnswer, WithdrawalCode } from '@/types/record';
import { formatDeclaredDate } from '@/lib/format/dates';
import type { DecisionVersionView, DeciderView } from '@/types/api';
import { TERM_DONE, TERM_NOT_APPLICABLE, TERM_NOT_YET, TERM_PARTLY } from '@/lib/vocabulary/terms';

/**
 * The fixed texts of a decision (SRS 7.5.6, 7.5.7 M-03 and M-11, FR-DEC-01's outside roles, FR-DEC-08's
 * withdrawal codes), shared by the decision service and the S-12 form so each text has one copy. Imports
 * only `types/`, the vocabulary's terms and `lib/format/dates` (which imports only `types/`; `whoWhenSummary` writes a date with it),
 * so a client component can import it (00-contract.md, "Further cross-unit
 * symbols").
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

/** Days in a month of the proleptic Gregorian calendar; `month` is 1 to 12. The one copy: `./rules` uses it too. */
export function daysInMonth(month: number, year: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export const STATUS_OPTIONS: ReadonlyArray<{ value: DecisionStatus; label: string; help: string }> = Object.freeze([
  // Plan line 926 (spec 6): each status's help is the vocabulary's own definition of the status.
  { value: 'done', label: 'Done', help: TERM_DONE.definition },
  { value: 'partly', label: 'Partly', help: TERM_PARTLY.definition },
  { value: 'not_yet', label: 'Not yet', help: TERM_NOT_YET.definition },
  { value: 'not_applicable', label: 'Not applicable', help: TERM_NOT_APPLICABLE.definition },
]);

export const FINDING_NOTE = 'If you choose Partly or Not yet, a finding is raised for this question (or stays open).';

export const SCOPE_OPTIONS: ReadonlyArray<{ value: ScopeAnswer; label: string; help: string }> = Object.freeze([
  { value: 'yes', label: 'Yes', help: 'The data includes personal or sensitive information.' },
  { value: 'no', label: 'No', help: 'It does not.' },
  { value: 'not_sure', label: 'Not sure', help: 'We do not know yet. The questions about consent and anonymisation still apply.' },
]);

export const REASON_HELP = 'Say what is in place, where it is recorded, and what is missing.';

/** UX-12's live count: "212 / 4,000 characters". */
export function reasonCount(n: number): string {
  return `${count(n)} / 4,000 characters`;
}

/**
 * The answer form's one line for who and when (design 2026-11-22 section 2 item 1; the owner's "Default who and when",
 * "Prefill today" and "Keep earlier decider" of 19 and 22 Nov 2026): "Decided by you, 22 Nov 2026", then the Change button.
 * `decider` is how the line names the person ("you", a name, or an outside role's label, as M-03 names them); `date` is
 * what the form holds, or null while the device's date is not yet known (the server render), which reads "today".
 */
export function whoWhenSummary(decider: string, date: DeclaredDate | null): string {
  return `Decided by ${decider}, ${date === null ? 'today' : formatDeclaredDate(date)}`;
}

/** The words around that line: the button that opens Decided by and Decided on, and the reason's label once it is optional. */
export const WHO_WHEN_COPY = Object.freeze({
  change: 'Change',
  /** The line's name for a decider the form cannot name (none chosen, or a member no longer listed). */
  noDecider: 'no one yet',
  formerMember: 'a former member',
});

/** After the reason's label, as the kit writes "(required)": the typed reason is optional for every status (FR-DEC-01). */
export const REASON_OPTIONAL = '(optional)';

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

/** The withdrawal codes of FR-DEC-08, in the labels' order: the one list the parser checks against. */
export const WITHDRAWAL_CODES: readonly WithdrawalCode[] = Object.freeze(Object.keys(WITHDRAWAL_CODE_LABELS) as WithdrawalCode[]);

/** M-11's field messages; the field each belongs to is the `SaveDecisionRequest` key (7.4.1 "Validation errors"). */
export const M11: Readonly<{
  status: string; scopeAnswer: string; reasonMissing: string; reasonTooLong: (n: number) => string;
  reasonNul: string; reasonCode: string; reasonCodeNotAllowed: string; decidedBy: string;
  yearMissing: string; dayWithoutMonth: string; monthRange: string; yearFormat: string;
  dateLater: string; monthDays: (month: number, year: number) => string; webAddress: string; unchanged: (n: number) => string;
}> = Object.freeze({
  status: 'Choose a status.',
  scopeAnswer: 'Choose an answer.',
  reasonMissing: 'Write a reason. Say what is in place, where it is recorded, and what is missing.',
  reasonTooLong: (n: number) => `The reason is ${count(n)} characters. The limit is 4,000.`,
  reasonNul: 'The reason contains a character that cannot be stored. Remove it and save again.',
  reasonCode: 'Choose a main reason.',
  reasonCodeNotAllowed: 'Choose a main reason from the list.',
  decidedBy: 'Choose who decided.',
  yearMissing: 'Enter at least the year the decision was made.',
  dayWithoutMonth: 'Enter the month, or leave the day empty.',
  monthRange: 'Enter a month from 1 to 12.',
  yearFormat: 'Enter the year as four digits, for example 2026.',
  dateLater: 'The date cannot be later than today.',
  monthDays: (month: number, year: number) => `${MONTHS[month - 1]} has ${daysInMonth(month, year)} days.`,
  webAddress: 'Enter a web address that starts with http:// or https://.',
  // The parameter stays (the type is frozen across lanes, ruling T17-c); the sentence names the current decision, not its number.
  unchanged: (_n: number) => 'Nothing has changed since the current decision. Change something before you save.',
});

/**
 * Field messages for requests the S-12 form never sends (a hand-made or stale request: a status on the scope
 * question, options the question does not have, a question the running content does not hold). Not in the
 * contract's symbol list; the server and the shared rules use them so every refusal names its field.
 */
export const REQUEST_MESSAGES = Object.freeze({
  body: 'Something went wrong. Reload the page and try again.',
  requestId: 'Something went wrong. Reload the page and try again.',
  stage: 'This page is out of date. Reload it and try again.',
  questionId: 'This question has changed. Reload the page.',
  baseVersionNumber: 'This page is out of date. Reload it and try again.',
  statusOnScope: 'This page is out of date. Reload it and try again.',
  scopeOnPractice: 'This page is out of date. Reload it and try again.',
  optionsNotOfQuestion: 'This page is out of date. Reload it and try again.',
  optionsOnPractice: 'This page is out of date. Reload it and try again.',
  evidenceIds: 'Attach each file or link once.',
  evidenceTooMany: 'Attach at most 100 files or links to one decision.',
  withdrawalCode: 'Choose what kind of mistake it was.',
  noCurrentDecision: 'There is no current decision to withdraw.',
});

/** M-11's summary: "There is a problem with this decision. Your text is kept." */
export function problemSummary(n: number): string {
  return n === 1
    ? 'There is a problem with this decision. Your text is kept.'
    : `There are ${count(n)} problems with this decision. Your text is kept.`;
}

/**
 * Who decided. `record` (S-13, documents) follows 7.5.8: a member by account name, a former member
 * "(former member)" (call R-19), someone without a platform account "(no platform account)". `confirmation` (M-03, UX-11's test text,
 * SRS line 2311) says "you" for the viewer, the name for another member, and the bare role label.
 */
export function deciderLabel(d: DeciderView, viewerId: string, form: 'confirmation' | 'record'): string {
  if (d.kind === 'outside_role') {
    const label = OUTSIDE_ROLE_LABELS[d.role];
    return form === 'record' ? `${label} (no platform account)` : label;
  }
  if (form === 'confirmation' && d.user.userId === viewerId) return 'you';
  return d.user.formerMember ? `${d.user.name} (former member)` : d.user.name;
}

/** M-03's words: "Saved at <time> as version <n>. Decided by: <decider>." (copy audit B row 345); no decider, no second sentence. */
export function savedLine(timeText: string, versionNumber: number, decider: string | null): string {
  return decider === null ? `Saved at ${timeText} as version ${versionNumber}.` : `Saved at ${timeText} as version ${versionNumber}. Decided by: ${decider}.`;
}

/** M-03 for a saved version, as the person who saved it reads it ("you" for themselves). */
export function savedMessage(v: DecisionVersionView, timeText: string, viewerId: string): string {
  return savedLine(timeText, v.versionNumber, v.decidedBy === null ? null : deciderLabel(v.decidedBy, viewerId, 'confirmation'));
}

/**
 * The line at the top of the question (or the stage's end screen) a clean Save moves the person to (answer cost, design 2 item 3):
 * UX-11's save confirmation, naming who decided and when, as `savedMessage` does. `decider` is `deciderLabel(…, 'confirmation')`
 * ("you" for the person's own answer); `declaredDateText` is the declared date as the interface writes it (`formatDeclaredDate`).
 */
export function savedArrivalLine(questionNumber: number, decider: string, declaredDateText: string): string {
  return `Your answer to question ${questionNumber} is saved: decided by ${decider}, ${declaredDateText}.`;
}

/** The link in that line, back to the question just saved. */
export function savedArrivalBack(questionNumber: number): string {
  return `Back to question ${questionNumber}`;
}

/**
 * UX-29: the inline confirmation of a withdrawal names the object and the consequence; its button repeats the action. Its
 * fields' and buttons' words too: the control shows on the question page and the history page.
 */
export const WITHDRAW_COPY: Readonly<{
  trigger: string; action: string; objectName: (versionNumber: number, questionId: string) => string; consequence: string;
  codeLabel: string; chooseOne: string; reasonLabel: string; more: string; retry: string;
}> = Object.freeze({
  trigger: 'Withdraw this decision',
  action: 'Withdraw decision',
  // The signature stays (versionNumber, questionId); the question names the decision (copy audit B row 348).
  objectName: (_versionNumber: number, questionId: string) => `Withdraw the decision on ${questionId}?`,
  consequence: 'The question returns to "no decision". Every version stays in the history.',
  codeLabel: 'What kind of mistake was it?',
  chooseOne: 'Choose one',
  reasonLabel: 'Explain',
  more: 'More actions',
  retry: 'Retry',
});

/** Page titles of the question and history pages (spec 7.5): the page's own heading, from data the page already loads. */
export const DECISION_COPY = Object.freeze({
  titles: Object.freeze({
    question: (questionId: string, moduleTitle: string): string => `${questionId} \u00b7 ${moduleTitle}`,
    history: (questionId: string): string => `History of ${questionId}`,
  }),
});
