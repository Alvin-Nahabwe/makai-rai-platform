import type { FindingState, MitigationKind, MitigationStatus, UtcInstant } from '@/types/record';

/**
 * Rulings R2, R3, A and C (14 Nov 2026): what a finding's "Close finding" record means on S-14 and S-15. Pure, with no
 * server imports, so both loaders decide the same way from the rows each already reads.
 *
 * A closing record is a mitigation whose kind is not `action` with exactly one version (version 1: done, no `what`).
 * Such a mitigation with two or more versions is an ordinary mitigation (ruling C: nothing that can block a finding is
 * hidden). R is the `findingSeq` of the latest reopen, or 0; a record or a done mitigation counts only above R.
 */

/** A mitigation as its current version and its version count: `FindingDetailView.mitigations`' shape. */
export interface ClosureMitigation {
  current: { kind: MitigationKind; status: MitigationStatus; findingSeq: number; closureDecisionVersionId: string | null };
  versions: number;
}

/** The decision version a record names, as far as rule A needs it. */
export interface ClosureDecision { questionId: string; scopeAnswer: string | null }

export type ClosureCause = 'changed' | 'withdrawn' | 'no_longer_applies';

/** "Closed by {name} on {date}." and its cause, or no cause when it cannot be read (rule A: never a guessed cause). */
export interface Closure { by: string; at: UtcInstant; cause: ClosureCause | null }

/** The closing record that closed the finding, and its cause. */
export interface RecordClosure<M extends ClosureMitigation> { record: M; cause: ClosureCause | null }

export const isClosingRecord = (m: Pick<ClosureMitigation, 'versions'> & { current: { kind: MitigationKind } }): boolean =>
  m.current.kind !== 'action' && m.versions === 1;

/** R: the `findingSeq` of the latest reopen, or 0. */
export const reopenedAt = (events: ReadonlyArray<{ kind: string; findingSeq: number }>): number =>
  Math.max(0, ...events.filter((e) => e.kind === 'reopened').map((e) => e.findingSeq));

/**
 * Rule A: kind `decision_withdrawn` is withdrawn. Kind `decision_changed`: the named decision version's question is the
 * finding's own question (changed), or another question answered `no` (no longer applies); anything else, an unread or
 * missing version included, gives no cause.
 */
export function causeOf(kind: MitigationKind, decision: ClosureDecision | undefined, findingQuestionId: string | null): ClosureCause | null {
  if (kind === 'decision_withdrawn') return 'withdrawn';
  if (kind !== 'decision_changed' || decision === undefined) return null;
  if (findingQuestionId !== null && decision.questionId === findingQuestionId) return 'changed';
  if (decision.questionId !== findingQuestionId && decision.scopeAnswer === 'no') return 'no_longer_applies';
  return null;
}

/**
 * R2: the finding is closed by its "Close finding" record when it is in state `closed_mitigation`, holds a closing record
 * above R, and no `action` mitigation is done above R. The latest such record says who and when. Null otherwise, an open
 * finding always (ruling B: no closure line while it is open). The page reads who and when from `record`.
 */
export function closureOf<M extends ClosureMitigation>(i: {
  state: FindingState; questionId: string | null; reopenedAt: number;
  mitigations: readonly M[]; decisions: ReadonlyMap<string, ClosureDecision>;
}): RecordClosure<M> | null {
  if (i.state !== 'closed_mitigation') return null;
  const above = (m: M) => m.current.findingSeq > i.reopenedAt;
  if (i.mitigations.some((m) => m.current.kind === 'action' && m.current.status === 'done' && above(m))) return null;
  const record = i.mitigations.filter((m) => isClosingRecord(m) && above(m))
    .sort((x, y) => x.current.findingSeq - y.current.findingSeq).at(-1);
  if (record === undefined) return null;
  const v = record.current;
  const decision = v.closureDecisionVersionId === null ? undefined : i.decisions.get(v.closureDecisionVersionId);
  return { record, cause: causeOf(v.kind, decision, i.questionId) };
}

/**
 * R2's history line: a closing record closed the finding when, at its `findingSeq`, no other mitigation's version as of
 * then (its latest version below that seq) was planned or in progress.
 */
export function recordClosedFinding(
  recordSeq: number, others: ReadonlyArray<ReadonlyArray<{ findingSeq: number; status: MitigationStatus }>>,
): boolean {
  return !others.some((versions) => {
    const asOf = versions.filter((v) => v.findingSeq < recordSeq).sort((x, y) => x.findingSeq - y.findingSeq).at(-1);
    return asOf !== undefined && (asOf.status === 'planned' || asOf.status === 'in_progress');
  });
}
