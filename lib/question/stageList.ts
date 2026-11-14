import { STATUS_OPTIONS } from '@/lib/decision/copy';
import { STAGE_LIST_COPY } from '@/lib/question/list/copy';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';
import type { DeclaredDate, ScopeAnswer, Stage } from '@/types/record';

/** The stage's name as pages print it (W-2, W-3): never its address segment. */
export const STAGE_TITLE: Readonly<Record<Stage, string>> = STAGE_LIST_COPY.stageTitle;

/**
 * S-11's rows and filters (W-2, SRS lines 1785-1830): one row per question of the stage, its status as words
 * (never colour alone: UX-06, NFR-A11Y-05), and the counts of the filter group. Pure: the page reads the data,
 * this shapes it, so the filters work without scripts (W-2 note 2) and the browser can narrow the same rows.
 */

export type StageFilter = 'all' | 'no_decision' | 'shortfalls' | 'done_without_evidence' | 'changed_since_seal' | 'reworded' | 'drafts';
export const STAGE_FILTERS: readonly StageFilter[] = ['all', 'no_decision', 'shortfalls', 'done_without_evidence', 'changed_since_seal', 'reworded', 'drafts'];

export interface StageRow {
  questionId: string; questionType: LoadedQuestion['type']; text: string; moduleId: string; moduleTitle: string; statusText: string; versionNumber: number | null;
  declaredDate: DeclaredDate | null; openFindings: number; changedSinceSeal: boolean; reworded: boolean; inPlace: { n: number; of: number } | null;
  /** The kind of status, which the filters count: no decision, a shortfall, done, not applicable, the gate answered. */
  kind: 'none' | 'shortfall' | 'done' | 'not_applicable' | 'scope' | 'not_applicable_by_gate';
  evidenceCount: number;
}

/** The status words of a version: a status label, or the gate's scope answer (FR-CNT-04). Words, never colour alone (UX-06). */
export function statusText(v: Pick<DecisionVersionView, 'status' | 'scopeAnswer'>): string {
  return versionStatusText(v);
}

function versionStatusText(v: Pick<DecisionVersionView, 'status' | 'scopeAnswer'>): string {
  const status = STATUS_OPTIONS.find((o) => o.value === v.status);
  if (status !== undefined) return status.label;
  return v.scopeAnswer === null ? STAGE_LIST_COPY.status.noDecision : STAGE_LIST_COPY.status.answer(v.scopeAnswer);
}

export const NOT_APPLICABLE_BY_GATE = STAGE_LIST_COPY.status.doesNotApply;

/** The filter's words in W-2's filter group (FR-CNT-08 names the reworded one). */
export function filterLabel(f: StageFilter, sealNumber: number | null): string {
  switch (f) {
    case 'all': return STAGE_LIST_COPY.filters.all;
    case 'no_decision': return STAGE_LIST_COPY.filters.noDecision;
    case 'shortfalls': return STAGE_LIST_COPY.filters.shortfalls;
    case 'done_without_evidence': return STAGE_LIST_COPY.filters.doneNoEvidence;
    case 'changed_since_seal': return STAGE_LIST_COPY.filters.changedSinceSeal(sealNumber);
    case 'reworded': return STAGE_LIST_COPY.filters.reworded;
    case 'drafts': return STAGE_LIST_COPY.filters.drafts;
  }
}

export function isStageFilter(v: unknown): v is StageFilter {
  return typeof v === 'string' && (STAGE_FILTERS as readonly string[]).includes(v);
}

/**
 * One row per question, in the order given (the stage's module order). A withdrawal as the current version is no
 * decision (FR-DEC-03, 5.3 item 2) and keeps its version number; the gate shows its scope answer (FR-CNT-04); with
 * the gate answered "no" the questions conditional on it read "Does not apply" (W-2 note 4).
 */
export function buildStageRows(i: {
  questions: LoadedQuestion[]; current: ReadonlyMap<string, DecisionVersionView>; gate: ScopeAnswer | null;
  openFindingsByQuestion: ReadonlyMap<string, number>; changed: readonly string[]; reworded: readonly string[];
}): StageRow[] {
  return i.questions.map((q) => {
    const v = i.current.get(q.id) ?? null;
    const decided = v !== null && v.status !== 'withdrawn' ? v : null;
    let statusText: string = STAGE_LIST_COPY.status.noDecision;
    let kind: StageRow['kind'] = 'none';
    if (q.condition !== undefined && i.gate === 'no' && i.gate !== q.condition.value) {
      statusText = NOT_APPLICABLE_BY_GATE; kind = 'not_applicable_by_gate';
    } else if (decided !== null && q.type === 'gate' && decided.scopeAnswer !== null) {
      statusText = versionStatusText(decided); kind = 'scope';
    } else if (decided !== null && decided.status !== null) {
      statusText = versionStatusText(decided);
      kind = decided.status === 'partly' || decided.status === 'not_yet' ? 'shortfall' : decided.status === 'done' ? 'done' : 'not_applicable';
    }
    return {
      questionId: q.id, questionType: q.type, text: q.text, moduleId: q.moduleId, moduleTitle: q.moduleTitle, statusText, kind,
      versionNumber: v?.versionNumber ?? null, declaredDate: decided?.declaredDate ?? null,
      openFindings: i.openFindingsByQuestion.get(q.id) ?? 0, changedSinceSeal: i.changed.includes(q.id), reworded: i.reworded.includes(q.id),
      inPlace: q.type === 'checklist' && decided !== null ? { n: decided.optionsInPlace.length, of: q.options?.length ?? 0 } : null,
      evidenceCount: decided?.evidence.length ?? 0,
    };
  });
}

/** Whether a row is shown by a filter; `drafts` is the questions with a draft of this account on this device. */
export function rowMatches(r: StageRow, f: StageFilter, drafts: ReadonlySet<string>): boolean {
  switch (f) {
    case 'all': return true;
    case 'no_decision': return r.kind === 'none';
    case 'shortfalls': return r.kind === 'shortfall';
    case 'done_without_evidence': return r.kind === 'done' && r.evidenceCount === 0;
    case 'changed_since_seal': return r.changedSinceSeal;
    case 'reworded': return r.reworded;
    case 'drafts': return drafts.has(r.questionId);
  }
}

/** The count beside each filter: whole numbers of this stage only (FR-RM-04, UX-07). */
export function filterCounts(rows: readonly StageRow[], drafts: ReadonlySet<string>): Record<StageFilter, number> {
  const out = {} as Record<StageFilter, number>;
  for (const f of STAGE_FILTERS) out[f] = rows.filter((r) => rowMatches(r, f, drafts)).length;
  return out;
}

/**
 * The question ids of this stage's rows that have a draft of this account on this device. A draft key names the project
 * and the question, not the stage, so the device's list for the project is narrowed to this stage's rows (F1, UX-07).
 */
export function stageDraftIds(listedQuestionIds: readonly string[], rows: readonly StageRow[]): Set<string> {
  const here = new Set(rows.map((r) => r.questionId));
  return new Set(listedQuestionIds.filter((id) => here.has(id)));
}

/** The line after Retry all (7.4.1 "Offline or slow"): how many were saved, and how many were not (F6). */
export function retryAllSummary(results: readonly string[]): string {
  const saved = results.filter((id) => id === 'M-03' || id === 'M-04').length;
  const n = results.length;
  return STAGE_LIST_COPY.retryAllSummary(saved, n);
}

/** W-2's module groups, in the rows' order: each module's rows with its question count and its no-decision count. */
export function moduleGroups(rows: readonly StageRow[]): Array<{ moduleId: string; moduleTitle: string; rows: StageRow[]; noDecision: number }> {
  const groups: Array<{ moduleId: string; moduleTitle: string; rows: StageRow[]; noDecision: number }> = [];
  for (const r of rows) {
    let g = groups.find((x) => x.moduleId === r.moduleId);
    if (g === undefined) { g = { moduleId: r.moduleId, moduleTitle: r.moduleTitle, rows: [], noDecision: 0 }; groups.push(g); }
    g.rows.push(r);
    if (r.kind === 'none') g.noDecision += 1;
  }
  return groups;
}
