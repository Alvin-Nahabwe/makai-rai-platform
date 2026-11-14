/**
 * The words of Home (spec 9.1; audit B rows 27 to 42, as plan 1A Task 17 rules them). Server only: no file with
 * 'use client' imports it (ruling X-2). The follow-up words Home shares with the project page (Overdue, the due lines,
 * the erased text, "View the finding") are the project page's, in lib/project/copy.ts.
 */
export const HOME_COPY = Object.freeze({
  titles: Object.freeze({ home: 'Home' }),
  heading: 'Home',
  newProject: 'New project',
  activeProjects: 'Active projects',
  /** Archived projects only, for every role (B#31): plain text, the page's All projects link follows it. */
  noActiveProjects: 'No active projects. Your archived projects are in All projects.',
  /** No project at all (B#32, B#33): a creator's line is followed by a New project link, everyone else's by whoCanCreate. */
  noProjects: 'No projects yet.',
  whoCanCreate: 'Owners, Admins and Assessors can create one.',
  allProjects: 'All projects',
  myMitigations: 'Mitigations assigned to me',
  noMitigations: 'No mitigations are assigned to you.',
  projectOf: (name: string) => `Project: ${name}`,
  /** A project card's line per stage, through StageColumn's `plural`: "Pre-processing: 1 open finding, 0 overdue mitigations". */
  card: Object.freeze({
    openFinding: 'open finding',
    openFindings: 'open findings',
    overdueMitigation: 'overdue mitigation',
    overdueMitigations: 'overdue mitigations',
    line: (stage: string, findings: string, mitigations: string) => `${stage}: ${findings}, ${mitigations}`,
  }),
});
