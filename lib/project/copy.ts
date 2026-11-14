import type { Stage } from '@/types/record';

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
  archivedBanner: 'This project is archived. Nothing in it can be changed. An Owner or Admin can unarchive it on the All projects page.',
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
  /** A stage column's counts, through StageColumn's `plural` where a word has a singular and a plural. */
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
    noDecision: (n: number) => `${n} with no decision`,
    /** The summary line a collapsed column shows: "Pre-processing: 9 with no decision, 3 open findings, 1 overdue mitigation". */
    todoLine: (stage: string, noDecision: number, findings: string, mitigations: string) => `${stage}: ${noDecision} with no decision, ${findings}, ${mitigations}`,
    withoutMitigation: (k: number) => ` (${k} of them with no mitigation yet)`,
    doneNoEvidence: (n: number) => `${n} done, no evidence attached`,
    todo: 'To do',
    recorded: 'Recorded',
    nothingRecorded: 'Nothing recorded yet.',
    done: (n: number) => `Done ${n}`,
    partly: (n: number) => `Partly ${n}`,
    notYet: (n: number) => `Not yet ${n}`,
    notApplicable: (n: number) => `Not applicable ${n}`,
    issued: (risks: string, documents: string) => `${risks}, ${documents} issued`,
    /** The link to the stage page; it prints the stage's address segment, as before (defect 18 is plan 1C's). */
    open: (segment: string) => `Open ${segment}`,
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
