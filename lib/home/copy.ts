/**
 * The words of Home (spec 9.1; audit B rows 27 to 42, as plan 1A Task 17 rules them). Server only: no file with
 * 'use client' imports it (ruling X-2). The follow-up words Home shares with the project page (Overdue, the due lines,
 * the erased text, "View the finding") are the project page's, in lib/project/copy.ts.
 */

/** A project card's line per stage in its two parts around the findings count (R5). */
const cardLineStart = (stage: string): string => `${stage}: `;
const cardLineEnd = (mitigations: string): string => `, ${mitigations}`;

export const HOME_COPY = Object.freeze({
  titles: Object.freeze({ home: 'Home' }),
  heading: 'Home',
  newProject: 'New project',
  activeProjects: 'Active projects',
  /** Archived projects only, for every role (B#31, one word changed by the coordinator): plain text, the page's All projects link follows it. */
  noActiveProjects: 'No active projects. Your archived projects are on the All projects page.',
  /** No project at all (B#32, B#33): a creator's line is followed by a New project link, everyone else's by whoCanCreate. */
  noProjects: 'No projects yet.',
  whoCanCreate: 'Owners, Admins and Assessors can create one.',
  allProjects: 'All projects',
  myMitigations: 'Mitigations assigned to me',
  noMitigations: 'No mitigations are assigned to you.',
  projectOf: (name: string) => `Project: ${name}`,
  /** "Your next step" (spec 9.1; plan 1B Task 10's words, rule C2): the reason line says which rule chose the question. */
  nextStepHeading: 'Your next step',
  reasonNextOpen: (stage: string, day: string) => `You last saved in ${stage} on ${day}. This is the next question there with no decision.`,
  reasonLastSaved: (day: string) => `You last saved here on ${day}.`,
  reasonFirstOpen: 'You have not saved a decision in this organisation yet. This is the first question with no decision.',
  continueRecording: 'Continue recording',
  chooseAnother: 'Choose another question',
  /** A project card's line per stage, through StageColumn's `plural`: "Pre-processing: 1 open finding, 0 overdue mitigations". */
  card: Object.freeze({
    openFinding: 'open finding',
    openFindings: 'open findings',
    overdueMitigation: 'overdue mitigation',
    overdueMitigations: 'overdue mitigations',
    line: (stage: string, findings: string, mitigations: string) => `${cardLineStart(stage)}${findings}${cardLineEnd(mitigations)}`,
    /** R5: the line in its parts, so the findings count can be a link: `lineStart` + findings + `lineEnd`. */
    lineStart: cardLineStart,
    lineEnd: cardLineEnd,
  }),
});
