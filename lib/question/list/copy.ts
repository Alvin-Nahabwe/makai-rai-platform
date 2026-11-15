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
    /** Spec 8's words (lane 1 Task 2): the filter names what changed and since when. */
    reworded: 'Good practice changed since the decision',
    /** Spec 8 and 9.7's words: where the unsaved text is kept. */
    drafts: 'Not saved in this browser',
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
  /**
   * The route's line (owner's answer R1, 15 November 2026; lane 1 Task 2): the words a question's row and a folded run
   * add. The interface never says "stop" or "line" (spec principle 4). `youAreHere` is the kit's UI_COPY.plate.youAreHere,
   * repeated here because this list imports only its own copy module (ruling X-2); __tests__/unit/route-column.test.tsx
   * holds the two equal.
   */
  line: Object.freeze({
    youAreHere: 'You are here',
    next: 'Next question',
    version: (n: number): string => `version ${n}`,
    /**
     * A tally's item for the personal data question once answered: the vocabulary's term (lane 6's wording ruling, as the
     * question page's strip reads it: QUESTION_COPY.frame.personalDataAnswered), never "scope" or a bare "answered".
     */
    personalDataAnswered: (n: number): string => `${n} personal data ${n === 1 ? 'question' : 'questions'} answered`,
    /** The name of a row's (i) for a term its question first uses (fix round 4), as the question page's strip names it. */
    whatMeans: (term: string): string => `What does "${term}" mean?`,
    /** Between a folded run's tally items, as the sketch writes them. */
    tallySeparator: ' · ',
    /** A folded run of questions, by their places in the stage. */
    run: (first: number, last: number): string => (last === first + 1 ? `Questions ${first} and ${last}` : `Questions ${first} to ${last}`),
  }),
  /** The stage page's count of its questions, beside the tally. */
  count: (n: number): string => `${n} questions`,
  /** A count line: the stage's under its heading, and each topic's under its own. */
  summary: (n: number, noDecision: number): string => `${n} questions · ${noDecision} with no decision`,
  /**
   * The parts of a question plate's one line of state, joined by `separator`. Each part stands alone: the line follows the
   * plate's status mark, not the status words, so its first part starts with no separator (plan 1C Task 3).
   */
  row: Object.freeze({
    separator: ' · ',
    inPlace: (n: number, of: number): string => `${n} of ${of} in place`,
    openFindings: (n: number): string => `${n} open ${n === 1 ? 'finding' : 'findings'}`,
    changedSinceSeal: (n: number | null): string => `changed since seal ${n ?? ''}`,
    reworded: 'good practice changed',
    notSaved: (date: string): string => `not saved yet (kept in this browser until ${date})`,
  }),
  /**
   * Under the filter group, once storage has been read and this browser keeps none: the "Not saved yet" option then shows
   * no count. Ruled in lib/decision/form/copy.ts as DECISION_FORM_COPY.noStorage; repeated here, word for word, because this
   * list imports only its own copy module (ruling X-2), and __tests__/unit/stage-route.test.tsx holds the two equal.
   */
  noStorage: 'This browser cannot keep a copy of your text. Save before you leave this page.',
});
