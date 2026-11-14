import Link from 'next/link';
import type { ReactElement } from 'react';
import { SealMarker } from '@/components/review/SealMarker';
import { VersionEvidenceList } from '@/components/evidence/VersionEvidenceList';
import { StatusMark } from '@/components/ui/StatusMark';
import { WITHDRAWAL_CODE_LABELS, deciderLabel } from '@/lib/decision/copy';
import { textErasedLine } from '@/lib/documents/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import { markKindOf } from '@/lib/ui/marks';
import { formatDay, formatDeclaredDate, formatTime } from '@/lib/format/dates';
import type { DecisionVersionView } from '@/types/api';
import type { SealRef } from '@/types/seal';

const C = QUESTION_COPY.current;

export type CurrentDecisionProps = {
  orgSlug: string; current: DecisionVersionView | null; historyCount: number; historyHref: string; seals: SealRef[];
  /** Whether the personal data question's answer makes this question not apply (lib/ui/marks.ts markKindOf). */
  gated: boolean;
  /** Whether this is the personal data question itself, whose decision is an answer, not a status. */
  isScopeQuestion: boolean;
};

/**
 * The current decision of the question on S-12 (W-3 note 3; FR-DEC-01, FR-DEC-04, FR-DEC-09): its status as the kit's
 * mark with its words, and its version, its seal marker (REV-b's slot), who decided with the declared date at its
 * precision, who entered it with the received time, the reason and the evidence of that version (every role reads them:
 * owner decision D6, which replaces W-3 note 3 and the read-only variant), and the history link. Both pairs appear
 * together (principle 4). With no version it reads "No decision yet." (7.4.2); a withdrawal as the current version is no
 * decision, says what kind of mistake it was, and has no mark (a mark has no kind for it). A server component: every
 * value is a React child, so it is text, never markup (NFR-SEC-11).
 */
export function CurrentDecision({ orgSlug, current, historyCount, historyHref, seals, gated, isScopeQuestion }: CurrentDecisionProps): ReactElement | null {
  if (current === null) return <p>{C.none}</p>;
  const history = <p><Link href={historyHref}>{C.history(historyCount)}</Link></p>;
  if (current.status === 'withdrawn') {
    return (
      <div className="current-decision">
        <p>{current.withdrawalCode === null ? C.withdrawnNoCode : C.withdrawn(WITHDRAWAL_CODE_LABELS[current.withdrawalCode])}</p>
        {history}
      </div>
    );
  }
  const decided = current.decidedBy === null ? null
    : C.decidedBy(deciderLabel(current.decidedBy, '', 'record'), current.declaredDate === null ? null : formatDeclaredDate(current.declaredDate));
  const entered = C.enteredBy(current.enteredBy.formerMember ? C.formerMember(current.enteredBy.name) : current.enteredBy.name, formatDay(current.receivedAt), formatTime(current.receivedAt));
  const kind = markKindOf({ status: current.status, scopeAnswer: current.scopeAnswer, gated, isScopeQuestion });
  return (
    <div className="current-decision">
      <p>
        <StatusMark kind={kind} scopeAnswer={current.scopeAnswer ?? undefined} />
        <span aria-hidden="true"> · </span>
        <span>{C.version(current.versionNumber)}</span>
      </p>
      <SealMarker seals={seals} />
      <p>{decided === null ? entered : <>{decided} {entered}</>}</p>
      <dl>
        <dt>{C.reason}</dt>
        <dd>{current.reasonErased !== null ? textErasedLine(current.reasonErased.erasedOn) : (current.reason ?? '')}</dd>
        <dt>{C.evidence}</dt>
        <dd>{current.evidence.length === 0 ? C.noEvidence : <VersionEvidenceList orgSlug={orgSlug} items={current.evidence} />}</dd>
      </dl>
      {history}
    </div>
  );
}
