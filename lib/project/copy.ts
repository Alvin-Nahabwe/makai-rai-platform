import type { Stage } from '@/types/record';
import { WORKING_REPORT_PAGE } from '@/lib/documents/copy';

/**
 * The words of the project screens (audit B, as plan 1A Task 17 rules them): Projects (S-32), the project page (S-10)
 * with its stage columns and follow-up lists, and the follow-up words Home shares with it. Server only: no file with
 * 'use client' imports it (ruling X-2); the form's words are lib/project/form/copy.ts, Archive's and Unarchive's
 * lib/project/write/copy.ts.
 */
/**
 * The archived banner's sentence, split around the words that link to the organisation's projects (lane 1's design review
 * S5-1). The link says "Projects page", the page's own heading (owner's ruling of 15 Nov 2026 18:28).
 */
const ARCHIVED_BANNER = Object.freeze({
  before: 'This project is archived. Nothing in it can be changed. An Owner or Admin can unarchive it on the ',
  link: 'Projects page',
  after: '.',
});

export const PROJECT_COPY = Object.freeze({
  titles: Object.freeze({ project: 'Project', editProject: 'Edit project', workingReport: 'Working report' }),
  /**
   * The working report page and its rail entry (path to outputs, Task 10; design G1). The page's other words are the PDF's
   * (lib/documents/copy.ts: WORKING_REPORT_PAGE, draftLine, DOCUMENT_TITLES), so the screen and the download say the same things.
   * "Working report" in the rail is fixed copy.
   */
  workingReport: Object.freeze({
    railLink: 'Working report',
    downloadHeading: 'Download as PDF',
    downloadAll: 'Download the whole working report (PDF)',
    /** Names the list of one-part links. */
    partsHeading: 'Or download one part',
    /** One part's link: its name, then the kind. The size is not known until the PDF is made, so none is printed. */
    partLink: (name: string): string => `${name} (PDF)`,
    /** The heading of a stage's draft plan, and the name of its link. */
    planTitle: (planName: string, stageName: string): string => `${planName}, ${stageName}`,
    /** Where an open item sits: page 1's one wording (lib/documents/copy.ts), shared with the PDF. */
    placeOf: WORKING_REPORT_PAGE.placeOf,
  }),
  /** S-10's one primary action (plan 1C C11): after a save of the person's in this project, and before one. */
  continue: 'Continue recording',
  start: 'Start recording',
  /**
   * S-10 as three lines of stops (Route R5; spec 9.2; plan 1C Task 8's copy table). The interface never says "stop" or
   * "line" (spec principle 4): the last stop's label is "Next question".
   */
  nextLabel: 'Next question',
  noDecisionYet: (n: number) => (n === 1 ? '1 question has no decision yet.' : `${n} questions have no decision yet.`),
  allDecided: 'Every question in this stage has a decision.',
  beforeSealing: 'Before sealing, look at:',
  nothingLeftOpen: 'Nothing is left open in this stage.',
  doneNoEvidence: (n: number) => (n === 1 ? '1 decision marked Done with no evidence attached' : `${n} decisions marked Done with no evidence attached`),
  overdueMitigations: (n: number) => (n === 1 ? '1 overdue mitigation' : `${n} overdue mitigations`),
  /** A review's one line, after its date: how many decisions and findings changed since the seal (owner's ruling of 15 Nov 2026, 21:32). */
  changedSince: (k: number) => `${k} changed since`,
  reviewsHeading: 'Reviews',
  /** A review's quiet line: "Review 1 · sealed 11 Nov 2026" or "Review 2 · not sealed yet". */
  reviewNumber: (n: number) => `Review ${n}`,
  sealed: 'sealed',
  notSealedYet: 'not sealed yet',
  /** The foot row of project actions (the sketch's nav.acts), named by its heading. */
  thisProject: 'This project',
  findings: 'Findings',
  editProjectDetails: 'Edit project details',
  /** "Overdue: 1 mitigation"; the word Overdue is followUp.overdue. */
  mitigationCount: (n: number) => (n === 1 ? '1 mitigation' : `${n} mitigations`),
  noOverdue: 'No overdue mitigations',
  /**
   * After the overdue plates (or "No overdue mitigations"): the stage's open mitigations not yet overdue, as one line linked
   * to the Findings page, where each is listed and can be reassigned (owner's ruling of 15 Nov 2026 20:50).
   */
  otherOpenMitigations: (n: number) => (n === 1 ? '1 other open mitigation' : `${n} other open mitigations`),
  /** The red part of an overdue mitigation's plate (spec 7.1: red only on "Overdue" and the date). */
  wasDue: (day: string) => `was due ${day}`,
  /** The name of a stage's row of marks, one per question. */
  routeLabel: (stageName: string) => `Questions in ${stageName}`,
  /**
   * The accessible name of the (i) beside a status word in a tally, at its first use on the page: 'What does "Done" mean?'
   * (the owner's ruling of 15 November 2026, 11:05; the same words as the question page's, lib/question/copy.ts on lane 1).
   */
  whatMeans: (term: string) => `What does "${term}" mean?`,
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
  /** S-10's header, jump links and the share line. */
  overview: Object.freeze({
    anyOrder: 'You can work on the stages in any order.',
    downloadRecords: 'Download records',
    jumpTo: 'Jump to a stage',
    /** G5 (owner-approved 19 Nov 2026; wording to be checked with the content approver): said at the top of the project page and on Home. */
    whatYouGet: 'Answer the questions that apply. At any point you can open a working report: next steps by risk area, plus draft data card, model card and mitigation plan. About 5 minutes a question.',
    /** G5: the project page's one primary action. */
    openReport: 'Open the working report',
    /** G4: "N of M questions recorded", the words beside each stage's bar and the bar's accessible name and value text. */
    progressName: (n: number, m: number): string => `${n} of ${m} questions recorded`,
    /** G4: the link to the stage's first question with no decision; "View" for a role that cannot record (the same target, read only). */
    nextQuestion: (n: number, canRecord: boolean): string => `Next: Question ${n} · ${canRecord ? 'Continue' : 'View'}`,
    /** G7: a stage the project's development stage leaves out. It stays openable. */
    doesNotApply: "Doesn't apply to this project yet",
    shareLine: 'To share your record outside the team, seal a stage review and create a document from it.',
  }),
  /** Every page of an archived project (coordinator Q5 (a): no link, the banner's props stay as they are). */
  archivedBanner: `${ARCHIVED_BANNER.before}${ARCHIVED_BANNER.link}${ARCHIVED_BANNER.after}`,
  /** The same sentence in three parts: ArchivedBanner links only the middle one to the organisation's projects (S5-1). */
  archivedBannerParts: ARCHIVED_BANNER,
  /** S-09 in edit mode for an archived project: the heading above the banner. */
  editArchivedHeading: 'Edit project',
  /** The stage names (decision D1); each stage's meaning is its vocabulary definition (TERM_STAGE_1 to 3). */
  stageNames: Object.freeze({
    'pre-processing': 'Pre-processing', 'in-processing': 'In-processing', 'post-processing': 'Post-processing',
  } satisfies Record<Stage, string>),
  /** A stage's counts, through `plural` (components/project/StageColumn.tsx) where a word has a singular and a plural. */
  stage: Object.freeze({
    question: 'question',
    questions: 'questions',
    openFinding: 'open finding',
    openFindings: 'open findings',
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
