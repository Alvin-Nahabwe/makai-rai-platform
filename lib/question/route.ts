import type { StatusMarkKind } from '@/components/ui/types';
import { tallyOf, type Tally } from '@/lib/ui/marks';
import type { StageRow } from '@/lib/question/stageList';
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
