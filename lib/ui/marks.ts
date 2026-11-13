import type { ScopeAnswer, StatusMarkKind } from '@/components/ui/types';
import type { DecisionStatus } from '@/types/record';

/** How many questions show each mark, and how many of the done ones have no evidence attached. Kinds that do not occur are absent. */
export type Tally = Readonly<Partial<Record<StatusMarkKind, number>>> & { readonly doneNoEvidence?: number };

/**
 * The mark a question shows (spec 7.2's table), in this order:
 *  1. The personal data question shows the answer mark once it has an answer, else no decision. A decision on it carries
 *     `scopeAnswer` and never a status (lib/decision/rules.ts), so its `status` is not read.
 *  2. Any other question the personal data answer gates does not apply, whatever its own decision says
 *     (lib/question/stageList.ts makes a question "by gate" with or without a decision of its own).
 *  3. No status is no decision; otherwise the status is its own mark.
 * `scopeAnswer` is a required key, so a caller that leaves it out fails to compile rather than showing "No decision".
 */
export function markKindOf(input: {
  status: DecisionStatus | null; scopeAnswer: ScopeAnswer | null; gated: boolean; isScopeQuestion: boolean;
}): StatusMarkKind {
  const { status, scopeAnswer, gated, isScopeQuestion } = input;
  if (isScopeQuestion) return scopeAnswer === null ? 'no_decision' : 'scope_answered';
  if (gated) return 'does_not_apply';
  return status ?? 'no_decision';
}

/** The tally of a row of marks: one count per kind that occurs, plus `doneNoEvidence` when it is above zero. */
export function tallyOf(kinds: readonly StatusMarkKind[], doneNoEvidence: number): Tally {
  const counts: Partial<Record<StatusMarkKind, number>> = {};
  for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1;
  return doneNoEvidence > 0 ? { ...counts, doneNoEvidence } : counts;
}
