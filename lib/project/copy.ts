import type { Stage } from '@/types/record';

/**
 * The words of the project screens (audit B, as plan 1A Task 17 rules them): Projects (S-32), the project page (S-10)
 * with its stage columns and follow-up lists, and the follow-up words Home shares with it. Server only: no file with
 * 'use client' imports it (ruling X-2); the form's words are lib/project/form/copy.ts, Archive's and Unarchive's
 * lib/project/write/copy.ts.
 */
export const PROJECT_COPY = Object.freeze({
  titles: Object.freeze({ project: 'Project', editProject: 'Edit project' }),
  /** S-10's one primary action (plan 1C C11): after a save of the person's in this project, and before one. */
  continue: 'Continue recording',
  start: 'Start recording',
  /** S-32 reached from the rail's Findings link with no project to go to (plan 1A Task 12, L2-65). */
  chooseForFindings: 'Choose a project to see its findings.',
  /** S-32, Projects: one list, active and archived (plan 1B Task 12; spec 8, rule C8). The key keeps its 1A name. */
  allProjects: Object.freeze({
    heading: 'Projects',
    newProject: 'New project',
    /** The table's caption, which also names its region: what the list holds and its fixed order (C8: no sorting). */
    caption: 'Active projects first, then archived ones',
    columns: Object.freeze({ project: 'Project', actions: 'Actions' }),
    /** A plate's line of state: the word, and for an archived project the archive icon before it. */
    active: 'Active',
    archived: 'Archived',
    /** No project at all: the title, then TERM_PROJECT's definition and one of the two sentences (plan 1B Task 12). */
    empty: Object.freeze({
      title: 'No projects yet',
      create: 'Create a project to start.',
      /** Spec 9.1's sentence, as plan 1B gives it for Home's HOME_COPY.firstTimeAsk (Task 10, the Home stream). */
      ask: 'Ask an Owner, Admin or Assessor to create your project.',
    }),
    showMore: 'Show more',
    /** The line before "Show more" while more projects remain (design review 15; voice rule 11). */
    showing: (shown: number, total: number) => `Showing ${shown} of ${total} projects.`,
    archivedNotShown: (n: number) => (n === 1
      ? '1 archived project is not shown yet. Archived projects come last.'
      : `${n} archived projects are not shown yet. Archived projects come last.`),
    /** For a person who cannot unarchive, once, when an archived project is listed (spec 9.7; lane 3 lead's ruling). */
    whoCanUnarchive: 'Owners and Admins can unarchive a project.',
  }),
  /** The words of a project's descriptive line (S-08, S-10, S-32; audit B rows 364 to 369). */
  descriptive: Object.freeze({
    other: 'Other',
    usesPersonalData: 'Uses personal data',
    noPersonalData: 'No personal data',
  }),
  /** S-10's header, jump links and closing lines. */
  overview: Object.freeze({
    anyOrder: 'You can work on the stages in any order.',
    editProject: 'Edit project',
    downloadRecords: 'Download records',
    jumpTo: 'Jump to a stage',
    shareLine: 'To share your record outside the team, seal a stage review and create a document from it.',
    findings: 'Findings for this project',
  }),
  /** Every page of an archived project (coordinator Q5 (a): no link, the banner's props stay as they are). */
  archivedBanner: 'This project is archived. Nothing in it can be changed. An Owner or Admin can unarchive it on the Projects page.',
  /** S-09 in edit mode for an archived project: the heading above the banner. */
  editArchivedHeading: 'Edit project',
  /** The stage names (decision D1) and the line under each (SRS W-1). */
  stageNames: Object.freeze({
    'pre-processing': 'Pre-processing', 'in-processing': 'In-processing', 'post-processing': 'Post-processing',
  } satisfies Record<Stage, string>),
  stageLines: Object.freeze({
    'pre-processing': 'Problem formulation; data collection and preparation',
    'in-processing': 'Model development and training; evaluation, fairness, documentation',
    'post-processing': 'Deployment and monitoring; governance and community engagement',
  } satisfies Record<Stage, string>),
  /** A stage block's counts, through StageColumn's `plural` where a word has a singular and a plural. */
  stage: Object.freeze({
    question: 'question',
    questions: 'questions',
    openFinding: 'open finding',
    openFindings: 'open findings',
    overdueMitigation: 'overdue mitigation',
    overdueMitigations: 'overdue mitigations',
    acceptedRisk: 'accepted risk',
    acceptedRisks: 'accepted risks',
    document: 'document',
    documents: 'documents',
    /** The first line of "Still open in this stage". */
    noDecisionQuestions: (n: number) => (n === 1 ? '1 question with no decision' : `${n} questions with no decision`),
    /** Plain text after the linked open-findings count. */
    withoutMitigation: (k: number) => ` (${k} of them with no mitigation yet)`,
    stillOpen: 'Still open in this stage',
    nothingOpen: 'Nothing is open in this stage.',
    /** The tally's heading; the tally's own words are the kit's (tallyWords, lib/ui/copy.ts). */
    recorded: 'Recorded so far',
    issued: (risks: string, documents: string) => `${risks}, ${documents} issued`,
    /** The link to the stage page; three on the page share these words, so each is described by its stage's heading. */
    allQuestions: 'All questions in this stage',
  }),
  /** The stage page's two count links (S-11). */
  followUpCounts: Object.freeze({
    openFinding: 'open finding',
    openFindings: 'open findings',
    overdueMitigation: 'overdue mitigation',
    overdueMitigations: 'overdue mitigations',
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
