import { TERM_PERSONAL_DATA_QUESTION_SCOPE_QUESTION } from '@/lib/vocabulary/terms';

/**
 * The words of the question page's decision form (components/decision/{DecisionForm, DecisionFields, ConflictView,
 * SaveStatus}) that lib/decision/copy.ts does not already hold: copy audit B rows 149 to 178 and 226 to 244, as the lead
 * and the coordinator ruled them for plan 1A Task 17. Only the form's client files import it (ruling X-2).
 */
export const DECISION_FORM_COPY = Object.freeze({
  /** The label each field is listed under in the error summary, and its label or legend without "(required)". */
  fields: Object.freeze({
    status: 'Status',
    scopeAnswer: 'Answer',
    optionsInPlace: 'Which of these are in place?',
    reasonCode: 'Main reason',
    reason: 'Explain your decision',
    decidedBy: 'Decided by',
    declaredDate: 'When was this decided?',
  }),
  scopeLegend: 'Answer (required)',
  /** Spec 6's line for the personal data question: the vocabulary's own definition. */
  scopeNote: TERM_PERSONAL_DATA_QUESTION_SCOPE_QUESTION.definition,
  optionsCount: (inPlace: number, of: number): string => `${inPlace} of ${of} in place`,
  chooseOne: 'Choose one',
  startingNote: 'The form shows the current decision. Change what is different, then save.',
  you: (name: string): string => `You (${name})`,
  formerMember: (name: string): string => `${name} (former member)`,
  noAccountGroup: 'Someone without a platform account',
  dateHelp: 'Leave the day empty if you only know the month. Leave both empty if you only know the year.',
  sameAsMyLast: (date: string): string => `Same date as my last decision (${date})`,
  sameAsCurrent: (date: string): string => `Same date as the current decision (${date})`,
  evidenceFallback: 'Evidence',
  removeKept: (n: number): string => (n === 1 ? 'Remove it from this decision' : 'Remove them from this decision'),
  /** "Waiting for {files} to finish uploading.": the names sit between the two parts, in their own element. */
  waiting: Object.freeze({ before: 'Waiting for ', after: ' to finish uploading.' }),
  saveWithout: (n: number): string => (n === 1 ? 'Save without this file' : 'Save without these files'),
  cancel: 'Cancel',
  save: 'Save decision',
  retry: 'Retry',
  signInAgain: 'Sign in again',
  savedWithout: Object.freeze({ before: 'Saved without ', after: '. When the upload has finished, save again to add it.' }),
  /** Plan line 925, exact: under the form while the field holds text that is not saved. */
  unsaved: 'Not saved yet. Your text is kept in this browser for up to 7 days. Signing out here, or another person signing in on this browser, removes it.',
  noStorage: 'This browser cannot keep a copy of your text. Save before you leave this page.',
  conflict: Object.freeze({
    heading: 'Not saved. A newer version was saved while you worked.',
    saved: (versionNumber: number): string => `Saved version (${versionNumber})`,
    mine: 'Your version (not saved)',
    status: 'Status',
    reason: 'Reason',
    decidedBy: 'Decided by',
    evidence: 'Evidence',
    also: 'Also attached',
    none: 'None',
    erased: 'Text erased',
    withdrawn: (label: string): string => `Withdrawn: ${label}`,
    saveMine: 'Save my version',
    editMine: 'Edit my version',
    discardMine: 'Discard my version',
  }),
});
