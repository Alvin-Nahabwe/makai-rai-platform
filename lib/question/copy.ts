/**
 * The question page's own words (copy audit B rows 7 to 20 and 179 to 184, plan 1A Task 17): its navigation, its region
 * headings, the earlier-wording disclosure and the current decision. SERVER ONLY: the page and CurrentDecision, both server
 * components, import it; no 'use client' file does (ruling X-2), so these words are not shipped to the browser.
 */
export const QUESTION_COPY = Object.freeze({
  nav: Object.freeze({
    label: 'Questions in this stage',
    previous: 'Previous question',
    next: 'Next question',
    position: (n: number, of: number, stage: string): string => `Question ${n} of ${of} in ${stage}`,
    back: (stage: string): string => `Back to ${stage}`,
  }),
  headings: Object.freeze({
    question: 'Question',
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
});
