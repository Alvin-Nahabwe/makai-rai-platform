import type { Stage } from '@/types/record';

/**
 * The words of the findings list (S-14) and of one finding (S-15), with their forms and the field messages the server and
 * the forms share (plan 1A Task 18, part 18a; copy audit C with CONSOLIDATED sections 2 and 8). One module for both
 * screens (ruling X-2): its client importers are the five client forms of these two screens. No public, email, admin or
 * legal file may import it (`__tests__/lint/findings-counts-visibility.test.ts`).
 *
 * The mitigation status words ("Planned", "In progress", "Done", "Cancelled") are not here: they stay in
 * `components/findings/MitigationForm.tsx`, where the claims allow-list names "In progress".
 */

/** "A", "A and B", "A, B and C". */
function joinAnd(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The sentences of a line joined by one space, leaving out an empty one (a form with nothing typed has no kept-text sentence). */
function sentences(...parts: readonly string[]): string {
  return parts.filter((p) => p !== '').join(' ');
}

/** How to try again: "Select Retry." where a Retry button exists, else "Select <the action's own button label> again." (L5-5). */
function selectAgain(again: string | undefined): string {
  return again === undefined ? 'Select Retry.' : `Select ${again} again.`;
}

/** "There is a problem with this <thing>." or "There are <n> problems with this <thing>.", then where the words are. */
function problems(thing: string, n: number, kept: string): string {
  return sentences(n === 1 ? `There is a problem with this ${thing}.` : `There are ${n} problems with this ${thing}.`, kept);
}

/** The words over an error summary that say the typed words are kept (the forms with no draft). */
const TYPED_IS_KEPT = 'What you typed is kept.';

/**
 * The field messages, one copy for the server (`FINDING_MESSAGES` in lib/findings/validate.ts, `TEAM_FINDING_MESSAGES`
 * in lib/data/teamFindings.ts), the forms' own checks (lib/findings/formRules.ts) and the allow-list `FIELD_TEXTS` that
 * `fieldText` shows a server message by. Every string here is a text a form may show.
 */
const FIELDS = Object.freeze({
  title: 'Write a title.',
  description: 'Write a description.',
  stage: 'Choose a stage.',
  riskArea: 'Choose a risk area of this stage, or none.',
  questionId: 'Choose a question of this stage, or none.',
  decisionVersionId: 'Choose a decision version of this question, or none.',
  what: 'Write what will be done.',
  ownerUserId: 'Choose who it is assigned to.',
  dueDate: 'Enter a due date.',
  status: 'Choose a status.',
  followsControl: 'Choose a control from the suggested controls, or none.',
  closureNote: 'Attach evidence that it is done, or say why there is none.',
  closureNoteNotDone: 'A closure note is only for a mitigation marked Done.',
  cancelReason: 'Say why it is cancelled.',
  cancelReasonNotCancelled: 'A reason for cancelling is only for a cancelled mitigation.',
  evidenceIds: 'Attach each file or link once, and at most 100.',
  changeNote: 'Say why the date changed.',
  acceptedBy: 'Choose who accepted the risk.',
  acceptReason: 'Write why the risk is accepted.',
  lookAgainOn: 'Enter a real date, or leave the date empty.',
  lookAgainNote: 'Write what you checked.',
  eventReason: 'Write a reason.',
  closingDecisionVersionId: 'Choose the decision version that closes this finding.',
  cancelledFinal: 'A cancelled mitigation cannot be changed.',
  notStorable: 'This contains a character that cannot be stored. Remove it and save again.',
} as const);

export const FINDINGS_COPY = Object.freeze({
  titles: Object.freeze({ findings: 'Findings' }),

  /** Between the parts of a line: a middle dot with a space each side. */
  separator: ' · ',

  /** The stage names (owner decision D1). */
  stages: Object.freeze({ 'pre-processing': 'Pre-processing', 'in-processing': 'In-processing', 'post-processing': 'Post-processing' } satisfies Record<Stage, string>),

  /** The field messages (see `FIELDS`), and the server's count text for a text over its limit. */
  fields: FIELDS,
  tooLong: (n: number, max: number): string => `This is ${n.toLocaleString('en-GB')} characters. The limit is ${max.toLocaleString('en-GB')}.`,
  /** The one sentence a field shows when the server's text for it is not one of ours. */
  genericField: 'This entry cannot be saved. Check it and try again.',
  /** The live count under a long text: "96 / 4,000 characters". */
  count: (n: number, max: number): string => `${n.toLocaleString('en-GB')} / ${max.toLocaleString('en-GB')} characters`,

  /** The sentence over an error summary of a form: how many problems, and where the person's words are. */
  summary: (thing: 'mitigation' | 'finding' | 'form' | 'reason', n: number, kept: string): string => problems(thing, n, kept),

  /** Labels a finding or a mitigation carries (lib/findings/labels.ts builds them). */
  labels: Object.freeze({
    open: 'Open',
    closedByMitigation: 'Closed by a mitigation',
    withdrawn: 'Withdrawn',
    closedByAcceptedRisk: 'Closed by an accepted risk',
    closedByAcceptedRiskBy: (who: string): string => `Closed by an accepted risk (${who})`,
    noStatus: 'No status',
    raisedByTeam: 'Raised by the team',
    fromDecision: 'From a decision',
    fromDecisionWith: (status: string): string => `From a decision: ${status}`,
    overdue: 'Overdue',
    wasDue: (date: string): string => `: was due ${date}`,
    stageCount: (stageName: string, n: number): string => `${stageName}: ${n} ${n === 1 ? 'finding' : 'findings'}`,
  }),

  /** M-26: "Only <roles> can <action>." The roles are read from the grants by lib/findings/messages.ts. */
  roles: Object.freeze({
    plural: Object.freeze({ owner: 'Owners', admin: 'Admins', assessor: 'Assessors', reviewer: 'Reviewers', viewer: 'Viewers' }),
    actions: Object.freeze({
      'risk:accept': 'accept a risk',
      'mitigation:write': 'add or update a mitigation',
      'finding:reopen': 'reopen a finding',
    }),
    onlyRolesCan: (roles: readonly string[], action: string): string => `Only ${joinAnd(roles)} can ${action}.`,
  }),

  /**
   * What a write that did not save says (M-05 to M-09, M-12, 7.4.4). `kept` says where the person's words are, or is empty.
   * `again` is the action's own button label where no Retry button exists (ruling L5-5): "Select <label> again.".
   */
  failures: Object.freeze({
    keptInBrowser: 'Your text is kept in this browser.',
    keptInForm: 'What you typed is still in the form.',
    noReply: (kept: string, again?: string): string => sentences('Not saved yet. We did not get a reply in time, so it may already be saved.', kept, `${selectAgain(again)} It will not save twice.`),
    connectionLost: (kept: string, again?: string): string => sentences('Not saved. Connection lost.', kept, selectAgain(again)),
    signedOut: (kept: string): string => sentences('Not saved. You have been signed out.', kept, 'Sign in again to save it.'),
    forbidden: (kept: string): string => sentences('Not saved. Your role in this organisation no longer allows this.', kept, 'Ask an Owner or Admin.'),
    archived: 'Not saved. This project is archived. Owners and Admins can unarchive it.',
    closedBy: (name: string, time: string): string => `This finding was closed by ${name} at ${time}.`,
    closed: 'This finding is closed.',
    newerFirst: 'Someone saved a newer version first.',
    alreadyOpen: 'This finding is already open.',
    withdrawn: 'This finding was withdrawn, so it cannot be changed.',
    cannotWithdrawShortfall: 'A finding raised from a decision cannot be withdrawn. Withdraw the decision instead.',
    entry: (n: number): string => problems('entry', n, TYPED_IS_KEPT),
    outOfDate: 'Not saved. This page is out of date, or you no longer have access to it. Reload the page.',
    tooMany: (kept: string, again?: string): string => sentences('Not saved. Too many requests.', kept, again === undefined ? 'Wait a minute, then select Retry.' : `Wait a minute, then select ${again} again.`),
    refused: (kept: string): string => sentences('Not saved.', kept, 'Reload the page and try again.'),
    server: (kept: string, again?: string): string => sentences('Not saved. The server had a problem.', kept, selectAgain(again)),
  }),

  /** S-14, the findings list. */
  list: Object.freeze({
    backTo: 'Back to',
    filter: 'Filter by stage',
    allStages: 'All stages',
    emptyProject: 'No findings yet. The platform raises a finding when a decision is saved as Partly or Not yet. Members can also raise one.',
    emptyStage: 'No findings in this stage.',
    decisionDone: 'Ready to close: the decision has changed',
    decisionWithdrawn: 'Ready to close: the decision was withdrawn',
    noMitigation: 'Open, no mitigation yet',
    overdue: 'Open, with overdue mitigations',
    open: 'Open',
    groupLabel: (stageName: string, group: string): string => `${stageName}: ${group}`,
    lookAgain: 'Accepted risks to check again',
    closed: 'Closed',
    withdrawn: 'Withdrawn',
    showMore: 'Show more',
  } as const),

  /** The raise form on S-14. */
  raise: Object.freeze({
    heading: 'Raise a finding',
    summary: (n: number): string => problems('finding', n, TYPED_IS_KEPT),
    aboutQuestion: 'About question:',
    title: 'Title',
    description: 'Description',
    descriptionHelp: 'Say what the problem is and who it may affect.',
    stage: 'Stage',
    chooseStage: 'Choose a stage',
    riskArea: 'Risk area (optional)',
    noRiskArea: 'No risk area',
    areaOption: (id: string, name: string): string => `${name} (${id})`,
    submit: 'Raise finding',
    raising: 'Raising...',
    slow: 'Still saving. The connection is slow. What you typed is still in the form.',
    raised: 'Finding raised.',
    viewFinding: 'View the finding',
  }),

  /** S-15, one finding. */
  finding: Object.freeze({
    untitled: 'Untitled finding',
    backToFindings: 'Back to findings',
    riskArea: 'Risk area:',
    namedId: (name: string, id: string): string => `${name} (${id})`,
    aboutQuestion: 'About question:',
    raisedByPlatformOn: 'Raised by the platform on',
    raisedByPlatformWhen: ', when',
    savedDecisionAs: (status: string): string => `saved the decision as ${status}.`,
    raisedBy: 'Raised by',
    on: 'on',
    acceptedHeaderStart: 'Closed by an accepted risk (',
    acceptedHeaderOn: (date: string): string => `) on ${date}.`,
    checkAgainOn: (date: string): string => ` To be checked again on ${date}.`,
    closeSection: 'Can be closed now',
    /** The box's cause sentences alone (B2: a blocked box gives the cause without "You can close this finding now."). */
    closeWithdrawnCause: 'The decision on this question was withdrawn.',
    closeGateCause: 'Your team answered No to the personal data question, so this question does not apply.',
    closeChangedCause: (status: string): string => `The decision on this question is now ${status}.`,
    closeNow: 'You can close this finding now.',
    closeWithdrawn: 'The decision on this question was withdrawn. You can close this finding now.',
    closeGate: 'Your team answered No to the personal data question, so this question does not apply. You can close this finding now.',
    closeChanged: (status: string): string => `The decision on this question is now ${status}. You can close this finding now.`,
    /** B2 (ruling R1): shown in the close box, with no button, while a mitigation is Planned or In progress. */
    closeBlocked: 'This finding stays open while it has a mitigation that is Planned or In progress. Mark the mitigation Done, or cancel it and say why.',
    mitigations: 'Mitigations',
    noMitigations: 'No mitigations yet. A mitigation says what the team will do about this finding. An Owner or Admin can accept the risk instead.',
    addMitigation: 'Add a mitigation',
    updateMitigation: 'Update this mitigation',
    ways: 'Ways teams address this',
    otherWays: 'Accept the risk, withdraw or reopen',
    history: 'History',
  } as const),

  /** A mitigation's card and its history on S-15. */
  mitigation: Object.freeze({
    assignedTo: 'Assigned to:',
    formerMember: ' (former member)',
    due: (date: string): string => `Due ${date}`,
    version: (n: number): string => `version ${n}`,
    cannotAct: 'The person this is assigned to can no longer update it. Assign it to someone else.',
    controlUsed: 'Suggested control used:',
    cancelReason: 'Why it is cancelled:',
    historySummary: (n: number): string => `History: ${n} ${n === 1 ? 'version' : 'versions'}`,
    historyVersion: (n: number): string => `Version ${n}, saved`,
    by: 'by',
    assignedToClause: ': assigned to',
    dueClause: (date: string): string => `, due ${date}.`,
    changeNote: 'Why the date changed:',
    raisedFromDecision: (status: string): string => `Raised by the platform when the decision on this question was saved as ${status}.`,
    raisedByTeam: 'Raised by the team.',
    reopened: 'Reopened',
    withdrawn: 'Withdrawn',
    added: 'Mitigation added',
    updated: (n: number): string => `Mitigation updated to version ${n}`,
    riskAcceptedBy: 'Risk accepted by',
    /**
     * Shown and printed in place of the text of a done mitigation the platform wrote when it closed a finding
     * because of a decision (kinds `decision_changed` and `decision_withdrawn`): such a row never had text.
     * The finding page shows them; the mitigation plan and the model card print them (register row D-408).
     */
    closedBecauseDecisionChanged: 'Closed because the decision changed.',
    closedBecauseDecisionWithdrawn: 'Closed because the decision was withdrawn.',
  }),

  /** "Accept the risk, withdraw or reopen": withdraw and reopen. */
  actions: Object.freeze({
    withdrawnDone: 'Withdrawn.',
    reopenedDone: 'Reopened.',
    reasonSummary: problems('reason', 1, TYPED_IS_KEPT),
    reason: 'Reason (required)',
    reopenTrigger: 'Reopen this finding',
    reopenHeading: 'Reopen this finding',
    reopenSubmit: 'Reopen finding',
    cancel: 'Cancel',
    objectName: (title: string): string => `Finding: ${title}`,
    consequence: 'The finding stays in the list, marked Withdrawn. It is no longer open. This cannot be undone.',
    withdrawAction: 'Withdraw finding',
    withdrawTrigger: 'Withdraw this finding',
    saving: 'Saving...',
    slow: 'Still saving. The connection is slow.',
  }),

  /** The accepted-risk form. */
  acceptRisk: Object.freeze({
    willShowStart: 'The finding will show as "Closed by an accepted risk (',
    willShowEnd: ')".',
    savedStart: 'Closed by an accepted risk (',
    savedEnd: ').',
    willShow: (who: string): string => `The finding will show as "Closed by an accepted risk (${who})".`,
    saved: (who: string): string => `Closed by an accepted risk (${who}).`,
    keepTrigger: 'Keep the risk accepted',
    keepHeading: 'Check this risk again',
    heading: 'Accept the risk',
    intro: 'Accepting a risk closes this finding without a mitigation. It records who accepted the risk and why. It can be reopened later.',
    summary: (n: number): string => problems('form', n, TYPED_IS_KEPT),
    acceptedBy: 'Accepted by (required)',
    choose: 'Choose who accepted the risk',
    you: (name: string): string => `You (${name})`,
    outsideGroup: 'Someone without a platform account',
    outsideWho: (role: string): string => `${role} (no platform account)`,
    aMember: 'a member',
    reason: 'Why the risk is accepted (required)',
    reasonKeep: 'Why the risk is still accepted (required)',
    reasonHelp: 'Say why, and where the acceptance is recorded (for example, committee minutes).',
    note: 'What you checked (required)',
    dateLegend: 'Date to check this risk again (optional)',
    submit: 'Accept the risk',
    submitKeep: 'Keep the risk accepted',
    cancel: 'Cancel',
    saving: 'Saving...',
    slow: 'Still saving. The connection is slow. What you typed is still in the form.',
  }),

  /** The one button that closes a finding by the decision that resolved it. */
  closeByDecision: Object.freeze({
    label: 'Close finding',
    ariaLabel: (title: string): string => `Close finding: ${title}`,
    closing: 'Closing...',
    slow: 'Still closing. The connection is slow.',
  }),

  /** The mitigation form and its conflict view. */
  mitigationForm: Object.freeze({
    doneNothingAttached: 'Done, nothing attached:',
    notAttached: 'Not attached:',
    conflictHeading: 'Someone saved a newer version of this mitigation',
    conflictYouSaved: (n: number): string => `You saved version ${n} at`,
    conflictOtherSaved: (n: number): string => `saved version ${n} at`,
    conflictYouRest: (next: number): string => `, perhaps from another tab or device. Compare it with yours below. Then save yours as version ${next}, or discard yours.`,
    conflictOtherRest: (next: number): string => `, after you started. Compare it with yours below. Then save yours as version ${next}, or discard yours.`,
    newerVersion: 'The newer version:',
    assignedTo: 'assigned to',
    dueClause: (date: string): string => `, due ${date}.`,
    yours: 'Yours:',
    yoursDue: (date: string): string => `, due ${date}`,
    saveMine: 'Save my version',
    editMine: 'Edit my version',
    discardMine: 'Discard my version',
    saving: 'Saving...',
    slow: (kept: string): string => sentences('Still saving. The connection is slow.', kept),
    savedAs: (n: number, time: string): string => `Saved as version ${n} of this mitigation at ${time}.`,
    newerFirst: 'Someone saved a newer version first. Reload this page.',
    replyNotShown: (kept: string): string => sentences('The reply could not be shown. Reload this page to see whether it saved.', kept),
    addHeading: 'Add a mitigation',
    updateHeading: 'Update this mitigation',
    status: 'Status (required)',
    assignedLabel: 'Assigned to (required)',
    assignedHelp: 'Only Owners, Admins and Assessors can be chosen.',
    chooseAssigned: 'Choose who it is assigned to',
    dueLegend: 'Due date (required)',
    changeNote: 'Why the due date moved later (required)',
    what: 'What will be done',
    follows: 'Suggested control this follows (optional)',
    noControl: 'None',
    evidenceLegend: 'Evidence that it is done (required)',
    noArtefact: 'We have no file or link to attach',
    noArtefactWhy: 'Why there is nothing to attach (required)',
    cancelReason: 'Why it is cancelled (required)',
    waitingFor: 'Waiting for',
    toFinishUploading: 'to finish uploading.',
    waiting: (names: readonly string[]): string => `Waiting for ${names.join(', ')} to finish uploading.`,
    saveWithout: 'Save without it',
    cancel: 'Cancel',
    save: 'Save mitigation',
    close: 'Close',
    unsaved: 'Not saved yet. Your text is kept in this browser for up to 7 days. Signing out here, or another person signing in on this browser, removes it.',
    cannotKeep: 'This browser cannot keep drafts. Save before leaving this page.',
    retry: 'Retry',
  }),
});
