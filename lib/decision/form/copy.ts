import { TERM_PERSONAL_DATA_QUESTION_SCOPE_QUESTION } from '@/lib/vocabulary/terms';

/** The unsaved line's two parts (design N1): the first sentence alone is what the pinned Save row shows on a wide screen. */
const UNSAVED_SHORT = 'Not saved yet.';
const UNSAVED_MORE = 'Your text is kept in this browser for up to 7 days. Signing out here, or another person signing in on this browser, removes it.';

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
  /** The name of a term's (i) button in the form (lane 6's TermTip), as the project page's (lib/project/copy.ts whatMeans). */
  whatMeans: (term: string): string => `What does "${term}" mean?`,
  startingNote: 'The form shows the current decision. Change what is different, then save.',
  you: (name: string): string => `You (${name})`,
  formerMember: (name: string): string => `${name} (former member)`,
  noAccountGroup: 'Someone without a platform account',
  dateHelp: 'Leave the day empty if you only know the month. Leave both empty if you only know the year.',
  sameAsMyLast: (date: string): string => `Same date as my last decision (${date})`,
  sameAsCurrent: (date: string): string => `Same date as the current decision (${date})`,
  /** I5, the owner's words (15 Nov 2026, 19:30): beside a re-decision's empty date boxes, the current version's date at its precision. */
  lastDecidedOn: (date: string): string => `Last decided on ${date}`,
  evidenceFallback: 'Evidence',
  removeKept: (n: number): string => (n === 1 ? 'Remove it from this decision' : 'Remove them from this decision'),
  /** "Waiting for {files} to finish uploading.": the names sit between the two parts, in their own element. */
  waiting: Object.freeze({
    before: 'Waiting for ', after: ' to finish uploading.',
    /** The owner's words (15 Nov 2026, 14:30), exact, after a failed or refused file's name in the wait card. */
    failed: ' did not upload. Retry it, remove it, or save without it.',
  }),
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
  unsaved: `${UNSAVED_SHORT} ${UNSAVED_MORE}`,
  /** Design N1: the pinned row shows `unsavedShort` only; `unsavedMore` follows the row in the card, read once in `unsaved`. */
  unsavedShort: UNSAVED_SHORT,
  unsavedMore: UNSAVED_MORE,
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
    /** "Your version" with no decider chosen yet (a first decision's draft): never "Decided by: , date". */
    notChosen: 'not chosen yet',
    saveMine: 'Save my version',
    editMine: 'Edit my version',
    discardMine: 'Discard my version',
  }),
  /** The decision card (owner's ruling R2, 15 Nov 2026; the locked sketch's form): its heading and the way on beside Save. */
  card: Object.freeze({
    heading: 'Your decision',
    /** The corner on a wide screen: "Saved as version N · <saved date>" (R2's words); the date sits after the separator. */
    savedAs: (n: number): string => `Saved as version ${n} \u00b7 `,
    /** The foot's "Entered by: <name> on <saved time>.": the time, in East Africa time with its zone, follows these words. */
    enteredBy: (name: string): string => `Entered by: ${name} on `,
    next: (title: string): string => `Next: ${title}`,
    /**
     * The way on, on a phone, in place of `next(<words>)`: the owner's "'Next question', no cut" (25 Nov 2026). Only about 12 characters
     * of the question's words fit there, so they are not shown. The owner's phrase; its wording has not yet had the copy review.
     */
    nextQuestion: 'Next question',
    position: (n: number, of: number): string => `Question ${n} of ${of}`,
  }),
  /**
   * The line before Save on what this save will do (R2; spec 9.3 item 6). Each sentence is true of the code that decides
   * findings (lib/data/findings.ts): only Partly and Not yet raise a finding, and only when the question has no open one
   * (onShortfallSaved, lib/data/findings.ts:311-334); after a finding closed by an accepted risk a new one is raised
   * unless the risk was accepted at this level or a worse one and no version since was Done or Not applicable
   * (raisesAfterAcceptance, :337-358); Done and Not applicable never close a finding themselves, they let the team close it
   * (findingsToCloseByDecision, :837). The personal data answer switches the conditional questions (lib/content/loader.ts,
   * questionApplies): Yes and Not sure keep them, No switches them off.
   */
  consequence: Object.freeze({
    version: (n: number): string => `This save becomes version ${n}.`,
    /**
     * The owner's sentence, exact (ruled 15 Nov 2026, 11:45, reworded by the owner at 14:30: "its last finding was closed as
     * an accepted risk"; not to be reworded). True of onShortfallSaved and raisesAfterAcceptance: a finding
     * is withheld only when the version the risk was accepted on was Partly or Not yet ("at this level or a worse one"),
     * no Done or Not applicable version lies between it and this one, and this status is not worse; a withdrawal has no
     * level, so a risk accepted on one never withholds a finding (__tests__/integration/findings-consequence-sentence.test.ts).
     */
    raises: (status: string): string => `Saving \u2018${status}\u2019 raises a finding for this question, unless its last finding was closed as an accepted risk at this level or a worse one and no version since was Done or Not applicable.`,
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
