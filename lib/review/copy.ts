
/**
 * The words of stage reviews and seals: the open form, the review, the seal page, the seal check, and the review
 * components other pages mount (plan 1A Task 18, part 18b; audit C, as ruled in Task 18's answers Q1, Q3, Q6, Q9).
 * Imported by the client components of these screens, so it holds these screens' words and nothing else (ruling X-2).
 */
export const REVIEW_COPY = Object.freeze({
  titles: Object.freeze({
    openReview: 'Open a stage review',
    /** The seal page's heading and title: the review's name (C#20). The seal number is no longer part of it. */
    seal: (reviewName: string, _sealNumber?: number): string => `Seal "${reviewName}"`,
  }),

  /** The stage as the pages write it (the content's names). */
  stageNames: Object.freeze({ 'pre-processing': 'Pre-processing', 'in-processing': 'In-processing', 'post-processing': 'Post-processing' }),
  /** A member's role as a sentence writes it (capitalised, CONSOLIDATED 3 rule 12). */
  roleWords: Object.freeze({ owner: 'Owner', admin: 'Admin', assessor: 'Assessor', reviewer: 'Reviewer', viewer: 'Viewer' }),
  /** The answer to the personal data question. */
  gateWords: Object.freeze({ yes: 'Yes', no: 'No', not_sure: 'Not sure' }),

  open: Object.freeze({
    refusal: 'Only Owners, Admins and Assessors can open a stage review.',
    nameLabel: 'Name:',
    stageLabel: 'Stage',
    fixedStage: (stageName: string): string => `Stage: ${stageName}`,
    noteLabel: 'Prepared for (optional)',
    help: "What is this review for? For example: an ethics committee submission, a data-sharing agreement with a partner, or a yearly report to a funder. Write roles, not people's names.",
    count: (n: number, max: number): string => `${n} of ${max} characters`,
    submit: 'Open a stage review',
    sending: 'Opening...',
    slow: 'Still opening. The connection is slow.',
    /** The field texts the server sends (route 12 and lib/data/reviews.ts). */
    stageInvalid: 'Choose a stage.',
    noteInvalid: 'This note cannot be saved. Check it and try again.',
    noteTooLong: 'The note can have at most 120 characters.',
    numberTaken: 'Not opened. Someone opened a review of this stage at the same moment. The name above has changed. Select Open a stage review again.',
    signedOut: 'Not opened. You have been signed out. Sign in again.',
    rateLimited: (wait: string): string => `Not opened. Too many requests. ${wait}`,
    archived: 'Not opened. This project is archived. Owners and Admins can unarchive it.',
    roleChanged: 'Not opened. Your role changed. Ask an Owner or Admin.',
    server: 'Not opened. The server had a problem. Select Open a stage review again.',
    lost: 'Not opened yet. We did not get a reply in time, so the review may already be open. Select Open a stage review again. It will not open twice.',
  }),

  /** A rate limit's wait, for the open form and the seal page (no Retry button follows it). */
  waitOne: 'Wait 1 minute, then try again.',
  waitMany: (n: number): string => `Wait ${n} minutes, then try again.`,

  state: Object.freeze({
    notSealed: 'Not sealed yet.',
    /** A seal whose stored copy no longer holds together (Q3 (b)): the state line and the line under that seal. */
    damaged: 'Something in this seal has changed since it was sealed. Contact MAK-AI through Help and contact.',
    /** The first sentence of `damaged`, for the project page's one-line review (owner's ruling of 15 Nov 2026, 21:32). */
    damagedShort: 'Something in this seal has changed since it was sealed.',
    changed: (sealNumber: number, count: number): string => `Changed since seal ${sealNumber} (${count}).`,
    sealed: (sealNumber: number, day: string): string => `Sealed as seal ${sealNumber} on ${day}.`,
    contentChanged: (sealNumber: number): string => `MAK-AI updated the questions after seal ${sealNumber}. Changes are compared with the current questions.`,
  }),

  review: Object.freeze({
    /** S5 (C 7): the review's facts as a description list, one term each; an erased note reads `mounted.noteErased`. */
    facts: Object.freeze({ stage: 'Stage', preparedFor: 'Prepared for', openedBy: 'Opened by', on: 'on' }),
    statusHeading: 'Status',
    /** After "Not sealed yet." while the review has no seal: who may seal it (lib/authz/policy.ts, `review:seal`). */
    whoSeals: 'An Owner, an Admin or a Reviewer seals this review.',
    questionsChanged: (n: number): string => `Questions changed since the last seal (${n}): `,
    noLongerInContent: ' (no longer in the current questions)',
    findingsChanged: (n: number): string => `Findings changed since the last seal (${n}): `,
    finding: 'Finding',
    sealThis: 'Seal this review',
    sealAgain: (n: number): string => `Seal again as seal ${n}`,
    sealsHeading: 'Seals',
    sealLead: (n: number): string => `Seal ${n}\u00a0· `,
    sealedBy: (name: string, role: string): string => `\u00a0· sealed by ${name} (${role})`,
    documentsHeading: 'Documents from this review',
    createDocument: 'Create a document',
  }),

  sealPage: Object.freeze({
    refusal: 'Only Owners, Admins and Reviewers can seal a stage review.',
    includesHeading: 'What this seal will include',
    statement: (sealNumber: number): string => `Sealing saves a fixed copy of this stage as it is now. The copy includes questions with no decision and open findings. You can keep working after you seal. Later changes will show as "changed since seal ${sealNumber}". Documents are made from a seal.`,
    byStatus: (done: number, partly: number, notYet: number, notApplicable: number): string =>
      `Decisions by status: Done ${done}\u00a0· Partly ${partly}\u00a0· Not yet ${notYet}\u00a0· Not applicable ${notApplicable}`,
    byReason: (parts: string): string => `Not applicable and Not yet by reason: ${parts}`,
    /** S7 (C 182): the decisions by status as a table, each status beside its definition. */
    statusTable: Object.freeze({ caption: 'Decisions by status', status: 'Status', count: 'Decisions' }),
    /** S7 (C 183): Not applicable and Not yet by reason as a small table. */
    reasonTable: Object.freeze({ caption: 'Not applicable and Not yet by reason', reason: 'Reason', count: 'Decisions' }),
    gateAnswer: (answer: string): string => `Answer to the personal data question: ${answer}`,
    doneNoEvidence: (n: number): string => `Done, no evidence attached: ${n}`,
    openFindings: (n: number): string => `Open findings: ${n}`,
    openMitigations: (n: number): string => `Open mitigations: ${n}`,
    evidence: (files: string, links: string): string => `Evidence: ${files} and ${links}. For a link, the seal keeps the web address only.`,
    enteredBy: (people: string): string => `Decisions entered by ${people}`,
    reworded: (n: number): string => `Good practice changed since the decision: ${n}`,
    sealingAs: (name: string, role: string): string => `You are sealing as ${name} (${role})`,
    noDecision: (n: number): string => `Questions with no decision (${n})`,
  }),

  confirm: Object.freeze({
    unsavedOne: 'You have 1 unsaved decision in this stage in this browser. It will not be in the seal.',
    unsavedMany: (n: number): string => `You have ${n} unsaved decisions in this stage in this browser. They will not be in the seal.`,
    unsavedLink: 'Open the unsaved decisions',
    sealNow: 'Seal now',
    cancel: 'Cancel',
    retry: 'Retry',
    back: 'Back to the review',
    sealed: (sealNumber: number, day: string, time: string, shortFingerprint: string): string =>
      `Sealed as seal ${sealNumber} on ${day} at ${time}. Fingerprint ${shortFingerprint}.`,
    sending: 'Sealing...',
    slow: 'Still sealing. The connection is slow.',
    lost: 'Not sealed yet. We did not get a reply in time, so this review may already be sealed. Select Retry. It will not seal twice.',
    numberTaken: (sealNumber: number): string => `Not sealed. Someone else sealed this review a moment ago, as seal ${sealNumber}. Look at their seal first. Then seal again if you still need to.`,
    signedOut: 'Not sealed. You have been signed out. Sign in again to seal.',
    rateLimited: (wait: string): string => `Not sealed. Too many requests. ${wait}`,
    archived: 'Not sealed. This project is archived. Owners and Admins can unarchive it.',
    roleChanged: 'Not sealed. Your role changed. Ask an Owner or Admin.',
    server: 'Not sealed. The server had a problem. Nothing was sealed.',
  }),

  fingerprint: Object.freeze({
    label: 'Fingerprint',
    showFull: 'Show full fingerprint',
    hideFull: 'Hide full fingerprint',
    copy: 'Copy fingerprint',
    copied: 'Copied.',
    notCopied: 'Not copied. The full fingerprint is shown; select it to copy.',
  }),

  check: Object.freeze({
    button: 'Check this seal',
    help: 'Checks that nothing in this seal has changed.',
    valid: 'Checked: nothing in this seal has changed since it was sealed.',
    validErasedOne: (day: string): string => `Checked: nothing in this seal has changed since it was sealed, except 1 field erased on ${day} at your organisation's request.`,
    validErasedMany: (n: number, day: string): string => `Checked: nothing in this seal has changed since it was sealed, except ${n} fields erased on ${day} at your organisation's request.`,
    mismatch: "Checked: something in this seal has changed since it was sealed. Contact MAK-AI through Help and contact, and give them this seal's fingerprint.",
    technicalDetails: 'Technical details',
    firstDifference: (path: string): string => `First difference: ${path}.`,
    didNotRun: 'The check did not run. Try again.',
    tooMany: (wait: string): string => `Too many checks. Try again in ${wait}.`,
  }),

  /**
   * The seal step under a stage page's heading (design G2 and §8; SRS FR-DOC-09 clause 10). `ask`, `waiting`, `seal` and
   * `openAndSeal` are the design's words, verbatim. The refusals that name no button are the open form's (`open`).
   */
  sealStep: Object.freeze({
    ask: 'Ask a reviewer to seal this stage',
    waiting: 'Review opened · waiting for an Owner, Admin or Reviewer to seal',
    seal: 'Seal this stage',
    openAndSeal: 'Open and seal this stage',
    sealed: 'This stage is sealed.',
    /** The request is idempotent per stage (clause 10), so pressing again returns the review it may already have opened. */
    lost: (button: string): string => `Not opened yet. We did not get a reply in time, so the review may already be open. Select ${button} again. It will not open twice.`,
    server: (button: string): string => `Not opened. The server had a problem. Select ${button} again.`,
    /** A number another open took on both of the service's tries (fix round 1): pressing again returns the review that open made. */
    numberTaken: (button: string): string => `Not opened. Someone opened a review of this stage at the same moment. Select ${button} again.`,
    /** The name of the (i) button beside the step's first use of "seal", as the project page's (lib/project/copy.ts whatMeans). */
    whatMeans: (term: string): string => `What does "${term}" mean?`,
  }),

  /** The components other pages mount (names and props frozen, ruling T18-c). */
  mounted: Object.freeze({
    sealMarker: (sealNumber: number, reviewName: string): string => `In seal ${sealNumber} of ${reviewName}`,
    sealNote: (sealNumber: number): string =>
      `This decision is in seal ${sealNumber}. If you save, seal ${sealNumber} keeps the earlier version of this decision. The review will then show "changed since seal ${sealNumber}".`,
    reviewsHeading: 'Stage reviews',
    noReviews: 'No stage review yet.',
    noteErased: (day: string): string => `(note erased on ${day})`,
    viewReview: 'View review',
    openReview: 'Open a stage review',
    banner: (sealNumber: number, where: string): string => `changed since seal ${sealNumber}${where}.`,
  }),
});
