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
    /** The reader's way on, under "Next: question n" (components/question/ReadingAside.tsx; viewer-reading.png). */
    position: (n: number, of: number, stage: string): string => `Question ${n} of ${of} in ${stage}`,
    /** The strip's link to the stage page (design spec 9.3; plan 1C `DECISION_COPY.allQuestionsLink`). */
    allQuestions: 'All questions',
  }),
  /**
   * The frame of the question page outside the decision card and the route column (lane 1 Task 1, the Route sketch
   * assigned.html and workspace-phone-saved.html): the top strip from 1160px (breadcrumb and the stage's tally), the
   * position strip under 1160px, and the guidance aside's risk areas and folded list.
   */
  frame: Object.freeze({
    /** The tally list's label (the sketch's hidden `.tally h2.sr` words; a label, so no heading comes before the h1). */
    tallyHeading: "Your team's work in this stage",
    /** The accessible name of the (i) beside a noun the vocabulary defines (spec 6; owner's ruling of 15 Nov, 11:00). */
    whatIs: (term: string): string => `What is a ${term}?`,
    /** The accessible name of the (i) beside a status word the vocabulary defines: 'What does "Not yet" mean?'. */
    whatMeans: (term: string): string => `What does "${term}" mean?`,
    /**
     * The position strip's links (phone sketch): the neighbour's words, then its place (the number the link shows) and its
     * status in words, never the mark alone.
     */
    previous: (text: string, n: number, status: string): string => `Previous question: ${text} (question ${n}, ${status})`,
    next: (text: string, n: number, status: string): string => `Next question: ${text} (question ${n}, ${status})`,
    /** After "Question n of N" in the position strip, read by a screen reader only: this question's status. */
    hereStatus: (status: string): string => `, you are here, ${status}`,
    /** The list of the question's risk areas under "Why this is asked" (plan 1C Task 4, DECISION_COPY.riskAreas). */
    riskAreas: 'Risk areas',
  }),
  headings: Object.freeze({
    current: 'Current decision',
    seals: 'Sealed reviews',
    record: 'Record a decision',
    findings: 'Findings',
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
     * After a link's name: the host it really goes to, so a name cannot claim another site (link spoofing), in the pattern
     * of lib/suggestions/copy.ts's resource line "(PDF, opens another site)". The page sets it in its own quieter element.
     */
    linkTo: (host: string): string => `(${host}, opens another site)`,
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
    /** The folded control's summary in the guidance aside (spec 9.3: one link that opens the list in place). */
    jump: (n: number): string => `Ways teams address this (${n})`,
    goodPractice: 'What good looks like',
    whyAsked: 'Why this is asked',
  }),
  /** The stage page, All questions (copy audit B rows 2 to 6). */
  stage: Object.freeze({
    topics: (titles: readonly string[]): string => titles.join(' · '),
    nothingRecorded: 'Nothing is recorded for this stage yet. Open any question to start. You can work on the stages in any order.',
    reviewName: (name: string): string => `${name}:`,
    showMore: 'Show more' as const,
    /**
     * The question page's column: its link to the stage page. The strip's link already reads nav.allQuestions, so this one
     * reads the words ruled for the project page's link to a stage (spec 9.2; PROJECT_COPY at lib/project/copy.ts,
     * `allQuestions`), copied here because this module is the question page's own; __tests__/unit/route-column.test.tsx
     * holds the two equal.
     */
    allQuestionsInStage: 'All questions in this stage',
    /**
     * Under the column's heading and the stage's meaning (lane 1 Task 2). The sketch's "Each stop is a question. Go to any
     * one." uses a word the interface never says (spec principle 4); this is the nearest true sentence, listed for the owner.
     */
    routeIntro: 'Each mark is a question. Open any one.',
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
