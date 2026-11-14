/**
 * The words of the project screens (audit B, as plan 1A Task 17 rules them): All projects (S-32), the project page (S-10)
 * with its stage columns and follow-up lists, and the follow-up words Home shares with it. Server only: no file with
 * 'use client' imports it (ruling X-2); the form's words are lib/project/form/copy.ts, Archive's and Unarchive's
 * lib/project/write/copy.ts.
 */
export const PROJECT_COPY = Object.freeze({
  titles: Object.freeze({ project: 'Project', editProject: 'Edit project' }),
  /** S-32 reached from the rail's Findings link with no project to go to (plan 1A Task 12, L2-65). */
  chooseForFindings: 'Choose a project to see its findings.',
  allProjects: Object.freeze({
    heading: 'All projects',
    newProject: 'New project',
    active: 'Active',
    archived: 'Archived',
    noActive: 'No active projects.',
    noArchived: 'No archived projects.',
    showMore: 'Show more',
  }),
  /** A mitigation's line in the follow-up lists of the project page and of Home. */
  followUp: Object.freeze({
    heading: 'Mitigations to follow up',
    none: 'No open mitigations.',
    /** A mitigation's text is null only after erasure (coordinator Q6 (b)). */
    erased: 'Text erased at your organisation\'s request.',
    assignedTo: (name: string) => `Assigned to: ${name}`,
    /** The red word (spec 7.1); the rest of the line follows it as plain text. */
    overdue: 'Overdue',
    wasDue: (day: string) => `: was due ${day}`,
    due: (day: string) => `Due ${day}`,
    cannotAct: (name: string) => `${name} can no longer work on this.`,
    reassign: 'Assign it to someone else.',
    /** The link to the mitigation's finding (coordinator Q7 (b)). */
    view: 'View the finding',
  }),
});
