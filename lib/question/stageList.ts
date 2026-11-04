import { SCOPE_OPTIONS, STATUS_OPTIONS } from '@/lib/decision/copy';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';
import type { DeclaredDate, ScopeAnswer } from '@/types/record';

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
  const status = STATUS_OPTIONS.find((o) => o.value === v.status);
  if (status !== undefined) return status.label;
  const scope = SCOPE_OPTIONS.find((o) => o.value === v.scopeAnswer);
  return scope === undefined ? 'No decision' : `Scope answer: ${scope.label.toLowerCase()}`;
}

export const NOT_APPLICABLE_BY_GATE = 'Not applicable (scope answer: no)';

/** The filter's words in W-2's filter group (FR-CNT-08 names the reworded one). */
export function filterLabel(f: StageFilter, sealNumber: number | null): string {
  switch (f) {
    case 'all': return 'All';
    case 'no_decision': return 'No decision';
    case 'shortfalls': return 'Shortfalls';
    case 'done_without_evidence': return 'Done without evidence';
    case 'changed_since_seal': return sealNumber === null ? 'Changed since the last seal' : `Changed since seal ${sealNumber}`;
    case 'reworded': return 'Expected practice reworded since the decision';
    case 'drafts': return 'Drafts on this device';
  }
}

export function isStageFilter(v: unknown): v is StageFilter {
  return typeof v === 'string' && (STAGE_FILTERS as readonly string[]).includes(v);
}

/**
 * One row per question, in the order given (the stage's module order). A withdrawal as the current version is no
 * decision (FR-DEC-03, 5.3 item 2) and keeps its version number; the gate shows its scope answer (FR-CNT-04); with
 * the gate answered "no" the questions conditional on it read "Not applicable (scope answer: no)" (W-2 note 4).
 */
export function buildStageRows(i: {
  questions: LoadedQuestion[]; current: ReadonlyMap<string, DecisionVersionView>; gate: ScopeAnswer | null;
  openFindingsByQuestion: ReadonlyMap<string, number>; changed: readonly string[]; reworded: readonly string[];
}): StageRow[] {
  return i.questions.map((q) => {
    const v = i.current.get(q.id) ?? null;
    const decided = v !== null && v.status !== 'withdrawn' ? v : null;
    let statusText = 'No decision';
    let kind: StageRow['kind'] = 'none';
    if (q.condition !== undefined && i.gate === 'no' && i.gate !== q.condition.value) {
      statusText = NOT_APPLICABLE_BY_GATE; kind = 'not_applicable_by_gate';
    } else if (decided !== null && q.type === 'gate' && decided.scopeAnswer !== null) {
      statusText = `Scope answer: ${SCOPE_OPTIONS.find((o) => o.value === decided.scopeAnswer)?.label.toLowerCase() ?? decided.scopeAnswer}`; kind = 'scope';
    } else if (decided !== null && decided.status !== null) {
      statusText = STATUS_OPTIONS.find((o) => o.value === decided.status)?.label ?? 'No decision';
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
