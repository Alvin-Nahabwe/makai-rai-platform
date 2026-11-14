import type { ScopeAnswer, Stage } from '@/types/record';
import { STATUS_MARK_COPY } from '@/lib/ui/copy';

/**
 * The words of All questions, a stage's question list (copy audit B rows 203 to 221 and 424 to 435, CONSOLIDATED 2,
 * plan 1A Task 17 part 17d): the status words, filter labels and stage titles of lib/question/stageList.ts, and the
 * words of components/decision/StageQuestionList.tsx. StageQuestionList is a client component, so this module ships
 * to the browser on the stage page: it holds this list's words and nothing else.
 */
export const STAGE_LIST_COPY = Object.freeze({
  stageTitle: Object.freeze({
    'pre-processing': 'Pre-processing', 'in-processing': 'In-processing', 'post-processing': 'Post-processing',
  } satisfies Record<Stage, string>),
  status: Object.freeze({
    noDecision: STATUS_MARK_COPY.no_decision,
    /** The personal data question's row: the answer in the kit's own words ("Answer: Yes"). */
    answer: (a: ScopeAnswer): string => STATUS_MARK_COPY.scope_answered(a),
    /** A question the personal data answer gates (CONSOLIDATED 2, "Does not apply"). */
    doesNotApply: 'Does not apply',
  }),
  filters: Object.freeze({
    all: 'All',
    noDecision: 'No decision',
    shortfalls: 'Partly or not yet',
    doneNoEvidence: 'Done, no evidence attached',
    changedSinceSeal: (n: number | null): string => (n === null ? 'Changed since the last seal' : `Changed since seal ${n}`),
    reworded: 'Good practice changed',
    drafts: 'Not saved yet',
  }),
  form: Object.freeze({
    label: 'Show questions',
    legend: 'Show',
    submit: 'Show',
  }),
  /** Decisions whose Save was pressed in this browser and that have not reached the server (answer Q1). */
  unsent: (n: number): string =>
    (n === 1 ? '1 decision saved in this browser has not reached the server.' : `${n} decisions saved in this browser have not reached the server.`),
  saveAll: (n: number): string => `Save all ${n} now`,
  retryAllSummary: (saved: number, n: number): string =>
    (saved === n ? `${n} saved.` : `${saved} of ${n} saved. ${n - saved} not saved: see each question.`),
  noMatch: (label: string): string => `No questions match '${label}'. `,
  showAll: (n: number): string => `Show all ${n}`,
  /** A count line: the stage's under its heading, and each topic's under its own. */
  summary: (n: number, noDecision: number): string => `${n} questions · ${noDecision} with no decision`,
  row: Object.freeze({
    inPlace: (n: number, of: number): string => ` · ${n} of ${of} in place`,
    openFindings: (n: number): string => ` · ${n} open ${n === 1 ? 'finding' : 'findings'}`,
    changedSinceSeal: (n: number | null): string => ` · changed since seal ${n ?? ''}`,
    reworded: ' · good practice changed',
    notSaved: (date: string): string => ` · not saved yet (kept in this browser until ${date})`,
  }),
});
