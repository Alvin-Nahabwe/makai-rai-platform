/**
 * The question page's own words (copy audit B rows 7 to 20, 179 to 184 and 249 to 251, audit C rows 172 to 174, plan 1A
 * Task 17): its navigation, its region headings, the earlier-wording disclosure, the current decision, the question's
 * content and the finding link; the stage page's and the history page's own words, with DecisionHistoryList's. SERVER
 * ONLY: the pages, CurrentDecision, DecisionHistoryList, QuestionContent and QuestionFindingLink, all server components,
 * import it; no 'use client' file does (ruling X-2), so these words are not shipped to the browser.
 */
export const QUESTION_COPY = Object.freeze({
  nav: Object.freeze({
    label: 'Questions in this stage',
    previous: 'Previous question',
    next: 'Next question',
    position: (n: number, of: number, stage: string): string => `Question ${n} of ${of} in ${stage}`,
    /** The strip's link to the stage page (design spec 9.3; plan 1C `DECISION_COPY.allQuestionsLink`). */
    allQuestions: 'All questions',
  }),
  headings: Object.freeze({
    current: 'Current decision',
    seals: 'Sealed reviews',
    record: 'Record a decision',
    findings: 'Findings',
    suggestions: 'Ways teams address this',
  }),
  /**
   * Under the code line of a question the personal data answer switched off (workshop walk S3). The first sentence of
   * FINDINGS_COPY.closeGate (lib/findings/copy.ts); question-frame.test.tsx holds the two together.
   */
  doesNotApply: 'Your team answered No to the personal data question, so this question does not apply.',
  /** The way on at the foot of the main column, after the form (workshop walk S9; plan 1C DECISION_COPY.nextQuestion, lastQuestion; design spec 9.3). */
  foot: Object.freeze({
    next: (title: string): string => `Next question: ${title}`,
    last: 'This is the last question in this stage.',
  }),
  reworded: Object.freeze({
    line: "The description of good practice changed after your team's decision.",
    summary: 'See the earlier description',
  }),
  current: Object.freeze({
    none: 'No decision yet.',
    history: (n: number): string => `See all versions (${n})`,
    withdrawn: (code: string): string => `No decision. The last decision was withdrawn (${code}).`,
    withdrawnNoCode: 'No decision. The last decision was withdrawn.',
    version: (n: number): string => `version ${n}`,
    decidedBy: (who: string, date: string | null): string => (date === null ? `Decided by: ${who}.` : `Decided by: ${who}, ${date}.`),
    enteredBy: (name: string, day: string, time: string): string => `Entered by: ${name} on ${day} at ${time}`,
    formerMember: (name: string): string => `${name} (former member)`,
    reason: 'Reason',
    evidence: 'Evidence',
    noEvidence: 'None',
  }),
  /**
   * The read-only question page (plan 1C Task 7, decision C12; directions/surfaces/viewer-reading.png): what a Reviewer, a
   * Viewer or anyone in an archived project reads in place of the form. components/question/ReadingDecision.tsx (the card),
   * OpenWorkList.tsx (what is still open) and ReadingAside.tsx (the sealed copy, the role note, the way on).
   */
  reading: Object.freeze({
    title: 'What the team decided',
    /** Under the quotation, with the declared date after a separator the page draws. */
    decidedBy: (who: string): string => `Decided by ${who}`,
    /** The version line (spec 9.3: status and version are separate text nodes; the status is in the card's corner). */
    version: (n: number): string => `Version ${n}`,
    saved: (day: string): string => `saved ${day}`,
    history: (n: number): string => `History: ${n} ${n === 1 ? 'version' : 'versions'}`,
    /** Spec 9.7: a withdrawn decision is struck through (the page strikes "Version n"), with who, when and why. */
    withdrawnVersion: (n: number): string => `Version ${n}`,
    withdrawnBy: (who: string, day: string, kind: string | null): string =>
      (kind === null ? ` was withdrawn by ${who} on ${day}.` : ` was withdrawn by ${who} on ${day} (${kind}).`),
    /** The withdrawal of a version with no earlier one to name (not expected: a withdrawal always has a base). */
    withdrawnNoBase: (who: string, day: string, kind: string | null): string =>
      (kind === null ? `The last decision was withdrawn by ${who} on ${day}.` : `The last decision was withdrawn by ${who} on ${day} (${kind}).`),
    evidence: 'Evidence',
    noEvidence: 'None yet',
    /** A file's line under its name: the size, a separator the page draws, then this. */
    added: (day: string): string => `added ${day}`,
    download: 'Download',
    /**
     * After a link's own name: the host it goes to, so a name cannot claim another site (link spoofing), in the pattern of
     * lib/suggestions/copy.ts's resource line "(PDF, opens another site)". The page wraps the host in `<bdi>`.
     */
    linkTo: Object.freeze({ before: ' (', after: ', opens another site)' }),
    /** After the name of a link that is not a web address (shown as text, not as a link): the address, cleaned. */
    notWebLink: Object.freeze({ before: ' (', after: ')' }),
    stillOpen: (n: number): string => `Still open on this question: ${n} ${n === 1 ? 'finding' : 'findings'}`,
    mitigation: (what: string): string => `Mitigation: ${what}`,
    noMitigationYet: 'No mitigation yet',
    /** Beside "No mitigation yet": a finding is assigned through its mitigations (vocabulary "Assigned to"). */
    notAssignedYet: 'Not assigned yet',
    /** After the word Overdue and a separator the page draws. */
    wasDue: (day: string): string => `was due ${day}`,
    sealedHeading: 'In a sealed copy',
    /** One per review, its highest seal holding the current version (spec 9.7 "Sealed copy exists"). */
    sealKeeps: (sealNumber: number, reviewName: string, versionNumber: number): string =>
      `Seal ${sealNumber} of ${reviewName} keeps version ${versionNumber} of this decision.`,
    /** The reader's way on (a reader has no Save, so this is the page's one primary action). */
    next: (n: number): string => `Next: question ${n}`,
  }),
  /** components/question/QuestionContent.tsx. */
  content: Object.freeze({
    principle: (principle: string): string => `Principle: ${principle}`,
    jump: (n: number): string => `Ways teams address this (${n})`,
    goodPractice: 'What good looks like',
    whyAsked: 'Why this is asked',
  }),
  /** The stage page, All questions (copy audit B rows 2 to 6). */
  stage: Object.freeze({
    topics: (titles: readonly string[]): string => titles.join(' · '),
    nothingRecorded: 'Nothing is recorded for this stage yet. Open any question to start. You can work on the stages in any order.',
    reviewName: (name: string): string => `${name}:`,
    /** The row of marks' label (plan 1C Task 3): the words of the question page's own navigation, nav.label. */
    routeLabel: 'Questions in this stage',
    showMore: 'Show more' as const,
    /**
     * The question page's column: its link to the stage page. The strip's link already reads nav.allQuestions, so this one
     * reads the words ruled for the project page's link to a stage (spec 9.2; PROJECT_COPY at lib/project/copy.ts,
     * `allQuestions`), copied here because this module is the question page's own; __tests__/unit/route-column.test.tsx
     * holds the two equal.
     */
    allQuestionsInStage: 'All questions in this stage',
  }),
  /** The history page of a question and components/decision/DecisionHistoryList.tsx (copy audit B rows 21 to 25, 185 to 197). */
  history: Object.freeze({
    back: (questionId: string): string => `Back to ${questionId}`,
    none: 'No decision has been recorded for this question yet.',
    count: (n: number): string => `${n} ${n === 1 ? 'version' : 'versions'}, newest first.`,
    showOlder: 'Show older' as const,
    version: (n: number): string => `Version ${n}`,
    status: 'Status',
    withdrawn: (code: string): string => `Withdrawn: ${code}`,
    reason: 'Reason',
    decidedBy: 'Decided by',
    enteredBy: 'Entered by',
    questionThen: 'Question as worded then',
    goodPracticeThen: 'What good looked like',
    evidence: 'Evidence',
    noEvidence: 'None',
  }),
  /** components/findings/QuestionFindingLink.tsx (answer Q7 (b)). */
  findingLink: Object.freeze({
    open: 'This question has an open finding.',
    /** R4: the open finding has a decision closure available and no mitigation open. */
    closable: 'This question has a finding that can now be closed.',
    view: 'View the finding',
    raise: 'Raise a finding about this question',
  }),
});
