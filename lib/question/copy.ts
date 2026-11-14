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
   * The read-only question page (plan 1C Task 7, decision C12): what a Reviewer, a Viewer or anyone in an archived project
   * reads in place of the form. CurrentDecision's reading mode and components/question/OpenWorkList.tsx.
   */
  reading: Object.freeze({
    title: 'What the team decided',
    history: (n: number): string => `History: ${n} ${n === 1 ? 'version' : 'versions'}`,
    stillOpen: (n: number): string => `Still open on this question: ${n} ${n === 1 ? 'finding' : 'findings'}`,
    mitigation: (what: string): string => `Mitigation: ${what}`,
    noMitigationYet: 'No mitigation yet',
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
    showMore: 'Show more' as const,
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
    view: 'View the finding',
    raise: 'Raise a finding about this question',
  }),
});
