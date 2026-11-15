import type { StatusMarkKind } from '@/components/ui/types';
import { tallyOf, type Tally } from '@/lib/ui/marks';
import { tallyWords, UI_COPY } from '@/lib/ui/copy';
import { STAGE_LIST_COPY } from '@/lib/question/list/copy';
import { filterCounts, filterLabel, STAGE_FILTERS, type StageFilter, type StageRow } from '@/lib/question/stageList';
import type { ChangedSinceSeal } from '@/types/api';
import type { ScopeAnswer } from '@/types/record';

/**
 * A stage as a row of marks (plan 1C Task 2, spec 7.2), pure: the page reads the rows and their marks, this shapes the
 * kit's RouteRow stops and tally. The stops are every row given, in their order: callers pass the whole stage. Lane 1's
 * pages no longer draw RouteRow (the route line replaced it); the project page (lane 4, lib/project/routes.ts) still does.
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

/**
 * The column's folding (owner's answer R1, 15 November 2026; lane 1 Task 2). `shortStage`: a stage of this many questions
 * or fewer folds nothing. `window`: how many questions show unfolded around the open one, `before` of them before it
 * where the stage allows; at the stage's ends the window slides so the column always shows the same number. Sized so the
 * column, with two-line titles, the filter and the stage's meaning, fits the first view at 1440 by 900 under the page's
 * top strip (seen on the 0.7.0 frame: five rows ran to about y = 950, four end near 870).
 */
export const ROUTE_FOLD = Object.freeze({ shortStage: 8, before: 1, window: 4 });

/** A question on the line with its place in the stage (1-based), or a run of questions folded into one row. */
export type RoutePart<T> =
  | { kind: 'row'; row: T; number: number }
  | { kind: 'run'; first: number; last: number; rows: Array<{ row: T; number: number }> };

/**
 * The stage's questions as the line shows them, in stage order. `rows` are the rows shown, in stage order; a part's
 * `number` is its place among them, which is its place in the stage whenever anything folds (no filter: every row).
 * Nothing folds when `fold` is false (the column with a filter active, and the stage page, which shows every question),
 * when no question is open, when the open question is not among the rows, or in a stage of `shortStage` questions or
 * fewer. Otherwise the window round the open question shows, stretched to reach the next question so that it is never
 * folded, and the questions before and after it fold into one run each; a run of one question shows as its own row.
 * Every row is in exactly one part, so every question stays reachable (a run opens in place).
 */
export function foldRoute<T extends { questionId: string }>(
  rows: readonly T[], p: { currentId?: string; nextId?: string | null; fold: boolean },
): RoutePart<T>[] {
  const numbered = rows.map((row, i) => ({ row, number: i + 1 }));
  const asRows = (xs: typeof numbered): RoutePart<T>[] => xs.map((x) => ({ kind: 'row' as const, ...x }));
  const at = p.currentId === undefined ? -1 : rows.findIndex((r) => r.questionId === p.currentId);
  if (!p.fold || at === -1 || rows.length <= ROUTE_FOLD.shortStage) return asRows(numbered);
  const start = Math.min(Math.max(at - ROUTE_FOLD.before, 0), Math.max(rows.length - ROUTE_FOLD.window, 0));
  const next = p.nextId == null ? -1 : rows.findIndex((r) => r.questionId === p.nextId);
  const end = Math.max(Math.min(rows.length - 1, start + ROUTE_FOLD.window - 1), next);
  const fold = (xs: typeof numbered): RoutePart<T>[] => (xs.length < 2
    ? asRows(xs)
    : [{ kind: 'run', first: xs[0].number, last: xs[xs.length - 1].number, rows: xs }]);
  return [...fold(numbered.slice(0, start)), ...asRows(numbered.slice(start, end + 1)), ...fold(numbered.slice(end + 1))];
}

/**
 * The question the page's Next leads to: the first after the open one that applies under the personal data answer
 * (lib/question/panel.ts, position.nextId, reads the same rule through questionApplies; a row the answer switches off is
 * `not_applicable_by_gate`). Null on the last, or when the open question is not in the rows.
 */
export function nextApplyingId(rows: readonly StageRow[], currentId: string): string | null {
  const at = rows.findIndex((r) => r.questionId === currentId);
  if (at === -1) return null;
  return rows.slice(at + 1).find((r) => r.kind !== 'not_applicable_by_gate')?.questionId ?? null;
}

/** Each kind's place in a tally (spec 7.2's table, as tallyWords writes it). A Record, so a new kind fails to compile here. */
const TALLY_RANK: Readonly<Record<StatusMarkKind, number>> = {
  done: 0, partly: 1, not_yet: 2, not_applicable: 3, does_not_apply: 4, scope_answered: 5, no_decision: 6,
};
const TALLY_ORDER = (Object.keys(TALLY_RANK) as StatusMarkKind[]).sort((a, b) => TALLY_RANK[a] - TALLY_RANK[b]);

/** One kind's words: tallyWords' own, except the personal data question, which a tally names by its term. */
function kindWords(kind: StatusMarkKind, t: Tally, withNoEvidence: boolean): string {
  const n = t[kind] ?? 0;
  if (kind === 'scope_answered') return STAGE_LIST_COPY.line.personalDataAnswered(n);
  return tallyWords(withNoEvidence && kind === 'done' && (t.doneNoEvidence ?? 0) > 0 ? { done: n, doneNoEvidence: t.doneNoEvidence } : { [kind]: n });
}

/**
 * A tally as one part per kind that occurs, so a page can set a mark (and the word's (i)) beside each: its count `n`, its
 * `word` after the count ("done", "personal data question answered"), the done kind's `extra` "(n with no evidence
 * attached)" or null, and `words`, the three as one phrase.
 */
export function tallyParts(t: Tally): Array<{ kind: StatusMarkKind; n: number; word: string; extra: string | null; words: string }> {
  return TALLY_ORDER.filter((kind) => (t[kind] ?? 0) > 0).map((kind) => {
    const n = t[kind] ?? 0;
    const word = kindWords(kind, t, false).slice(String(n).length + 1);
    const extra = kind === 'done' && (t.doneNoEvidence ?? 0) > 0 ? UI_COPY.tally.noEvidence(t.doneNoEvidence ?? 0) : null;
    return { kind, n, word, extra, words: kindWords(kind, t, true) };
  });
}

/**
 * A folded run's tally on one line, as the sketch writes it: the kinds joined by middots, with no "(n with no evidence
 * attached)" inside a run (each row's own meta line says it). Design fix round 1, S2-4.
 */
export function lineTallyWords(t: Tally): string {
  return TALLY_ORDER.filter((kind) => (t[kind] ?? 0) > 0).map((kind) => kindWords(kind, t, false)).join(STAGE_LIST_COPY.line.tallySeparator);
}
