import type { StatusMarkKind } from '@/components/ui/types';
import { tallyOf, type Tally } from '@/lib/ui/marks';
import { filterCounts, filterLabel, STAGE_FILTERS, type StageFilter, type StageRow } from '@/lib/question/stageList';
import type { ChangedSinceSeal } from '@/types/api';
import type { ScopeAnswer } from '@/types/record';

/**
 * A stage as a row of marks (plan 1C Task 2, spec 7.2), pure: the page reads the rows and their marks, this shapes the
 * kit's RouteRow stops and tally. The stops are every row given, in their order: callers pass the whole stage.
 */
export type RouteStopData = { id: string; kind: StatusMarkKind; title: string; href: string; current: boolean; scopeAnswer?: ScopeAnswer };

/**
 * One stop per row: its mark, the question in words, its address, and whether it is the question open now. With the
 * personal data question's answer, that question's stop carries it, so its words are "Answer: Yes" and not "Answered".
 */
export function stopsOf(
  rows: readonly StageRow[], marks: Readonly<Record<string, StatusMarkKind>>, hrefOf: (questionId: string) => string, currentId?: string,
  scopeAnswer?: ScopeAnswer | null,
): RouteStopData[] {
  return rows.map((r) => {
    const kind = marks[r.questionId];
    const stop: RouteStopData = { id: r.questionId, kind, title: r.text, href: hrefOf(r.questionId), current: r.questionId === currentId };
    return kind === 'scope_answered' && scopeAnswer != null ? { ...stop, scopeAnswer } : stop;
  });
}

/** The tally of the rows' marks; done with no evidence is a done row with no evidence attached (the done_without_evidence filter's rule). */
export function tallyOfRows(rows: readonly StageRow[], marks: Readonly<Record<string, StatusMarkKind>>): Tally {
  return tallyOf(rows.map((r) => marks[r.questionId]), rows.filter((r) => r.kind === 'done' && r.evidenceCount === 0).length);
}

/**
 * The filter group's counts and options for a stage's list, as the stage page and the question page's column both give
 * them (one rule, written once). RE-4: the changed filter counts every question the seal comparison names, a question
 * the running content has cut included, so it agrees with the banner (REV-b RE-1); the rows it shows are those the stage
 * still holds. The changed filter is offered only with a seal to compare against.
 */
export function stageFilterSet(rows: readonly StageRow[], changed: ChangedSinceSeal | null): {
  counts: Record<StageFilter, number>; filters: Array<{ key: StageFilter; label: string }>; sealNumber: number | null;
} {
  const counts = { ...filterCounts(rows, new Set()), ...(changed === null ? {} : { changed_since_seal: changed.changedQuestions.length }) };
  const sealNumber = changed?.sealNumber ?? null;
  const filters = STAGE_FILTERS.filter((f) => f !== 'changed_since_seal' || changed !== null).map((f) => ({ key: f, label: filterLabel(f, sealNumber) }));
  return { counts, filters, sealNumber };
}
