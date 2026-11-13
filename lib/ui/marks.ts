import type { StatusMarkKind } from '@/components/ui/types';
import type { DecisionStatus } from '@/types/record';

/** How many questions show each mark, and how many of the done ones have no evidence attached. Kinds that do not occur are absent. */
export type Tally = Readonly<Partial<Record<StatusMarkKind, number>>> & { readonly doneNoEvidence?: number };

/**
 * The mark a question shows (spec 7.2). The personal data question shows the answer mark once it has a decision;
 * "Not applicable" on a question the personal data answer gates is "Does not apply"; no decision is the small dot.
 */
export function markKindOf(input: { status: DecisionStatus | null; gated: boolean; isScopeQuestion: boolean }): StatusMarkKind {
  const { status, gated, isScopeQuestion } = input;
  if (status === null) return 'no_decision';
  if (isScopeQuestion) return 'scope_answered';
  if (status === 'not_applicable' && gated) return 'does_not_apply';
  return status;
}

/** The tally of a row of marks: one count per kind that occurs, plus `doneNoEvidence` when it is above zero. */
export function tallyOf(kinds: readonly StatusMarkKind[], doneNoEvidence: number): Tally {
  const counts: Partial<Record<StatusMarkKind, number>> = {};
  for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1;
  return doneNoEvidence > 0 ? { ...counts, doneNoEvidence } : counts;
}
