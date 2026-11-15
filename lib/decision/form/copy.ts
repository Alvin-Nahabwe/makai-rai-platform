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
    reason: 'Reason',
    decidedBy: 'Decided by',
    declaredDate: 'Decided on',
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
  /**
   * Walk finding B3: the link's request ended without the link while Save waited. Nothing was sent; the summary shows this.
   * "or clear the box": an address left in the box holds the next Save back too (lib/evidence/copy.ts, `typedNotAdded`).
   */
  linkNotAdded: 'Not saved. The link was not added. Select Add link again, or clear the box, then save.',
  saveWithout: (n: number): string => (n === 1 ? 'Save without this file' : 'Save without these files'),
  cancel: 'Cancel',
  save: 'Save decision',
  retry: 'Retry',
  signInAgain: 'Sign in again',
  /** "Saved without {files}. ...": `after` for one file, `afterMany` for more than one (the coordinator's answer to Q17 (b)). */
  savedWithout: Object.freeze({
    before: 'Saved without ', after: '. When the upload has finished, save again to add it.',
    afterMany: '. When the upload has finished, save again to add them.',
  }),
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
  /** The decision card (owner's ruling R2, 15 Nov 2026; the locked sketch's form): its heading and the way on beside Save. */
  card: Object.freeze({
    heading: 'Your decision',
    next: (title: string): string => `Next: ${title}`,
    position: (n: number, of: number): string => `Question ${n} of ${of}`,
  }),
  /**
   * The line before Save on what this save will do (R2; spec 9.3 item 6). Each sentence is true of the code that decides
   * findings (lib/data/findings.ts): only Partly and Not yet raise a finding, and only when the question has no open one
   * (raiseShortfall); a finding closed by an accepted risk is not raised again unless the decision improved and fell back
   * or got worse (raisesAfterAcceptance); Done and Not applicable never close a finding themselves, they let the team close
   * it (findingsToCloseByDecision). The personal data answer switches the conditional questions (lib/content/loader.ts,
   * questionApplies): Yes and Not sure keep them, No switches them off.
   */
  consequence: Object.freeze({
    version: (n: number): string => `This save becomes version ${n}.`,
    raises: (status: string): string => `Saving \u2018${status}\u2019 raises a finding for this question, unless your team has already accepted this risk.`,
    keepsOpen: (status: string): string => `Saving \u2018${status}\u2019 keeps a finding open for this question until your team closes it.`,
    raisesNone: (status: string): string => `Saving \u2018${status}\u2019 raises no finding.`,
    closesNot: (status: string): string => `Saving \u2018${status}\u2019 does not close the open finding by itself. Your team closes it on the finding's page.`,
    scope: Object.freeze({
      yes: 'Saving \u2018Yes\u2019 means the questions about consent and anonymisation apply to this project.',
      no: 'Saving \u2018No\u2019 means the questions about consent and anonymisation do not apply to this project.',
      not_sure: 'Saving \u2018Not sure\u2019 means the questions about consent and anonymisation still apply.',
    }),
  }),
});
