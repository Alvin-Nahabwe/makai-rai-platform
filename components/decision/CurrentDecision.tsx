import Link from 'next/link';
import type { ReactElement } from 'react';
import { SealMarker } from '@/components/review/SealMarker';
import { VersionEvidenceList } from '@/components/evidence/VersionEvidenceList';
import { WITHDRAWAL_CODE_LABELS, deciderLabel } from '@/lib/decision/copy';
import { textErasedLine } from '@/lib/documents/copy';
import { statusText } from '@/lib/question/stageList';
import { formatDay, formatDeclaredDate, formatTime } from '@/lib/format/dates';
import type { DecisionVersionView } from '@/types/api';
import type { SealRef } from '@/types/seal';

export type CurrentDecisionProps = { orgSlug: string; current: DecisionVersionView | null; historyCount: number; historyHref: string; seals: SealRef[] };

/**
 * The current decision of the question on S-12 (W-3 note 3; FR-DEC-01, FR-DEC-04, FR-DEC-09): status and version,
 * its seal marker (REV-b's slot), who decided with the declared date at its precision, who entered it with the
 * received time, the reason and the evidence of that version (every role reads them: owner decision D6, which replaces
 * W-3 note 3 and the read-only variant), and the history link. Both pairs appear together (principle 4). With no version it reads
 * "No decision yet." (7.4.2); a withdrawal as the current version is no decision and says which version withdrew
 * it. A server component: every value is a React child, so it is text, never markup (NFR-SEC-11).
 */
export function CurrentDecision({ orgSlug, current, historyCount, historyHref, seals }: CurrentDecisionProps): ReactElement | null {
  if (current === null) return <p>No decision yet.</p>;
  const history = <p><Link href={historyHref}>{`History: ${historyCount} ${historyCount === 1 ? 'version' : 'versions'}`}</Link></p>;
  if (current.status === 'withdrawn') {
    const code = current.withdrawalCode === null ? '' : `: ${WITHDRAWAL_CODE_LABELS[current.withdrawalCode]}`;
    return (
      <div className="current-decision">
        <p>{`No decision. Version ${current.versionNumber} withdrew the decision${code}.`}</p>
        {history}
      </div>
    );
  }
  const decided = current.decidedBy === null ? null
    : `Decided by: ${deciderLabel(current.decidedBy, '', 'record')}${current.declaredDate === null ? '' : `, ${formatDeclaredDate(current.declaredDate)}`}.`;
  const entered = `Entered by: ${current.enteredBy.formerMember ? `${current.enteredBy.name} (former member)` : current.enteredBy.name}, ${formatDay(current.receivedAt)} ${formatTime(current.receivedAt)}`;
  return (
    <div className="current-decision">
      <p>
        <span className="status-label" style={{ color: 'var(--text-body)' }}>{statusText(current)}</span>
        <span aria-hidden="true"> · </span>
        <span>{`version ${current.versionNumber}`}</span>
      </p>
      <SealMarker seals={seals} />
      <p>{decided === null ? entered : <>{decided} {entered}</>}</p>
      <dl>
        <dt>Reason</dt>
        <dd>{current.reasonErased !== null ? textErasedLine(current.reasonErased.erasedOn) : (current.reason ?? '')}</dd>
        <dt>Evidence</dt>
        <dd>{current.evidence.length === 0 ? 'None' : <VersionEvidenceList orgSlug={orgSlug} items={current.evidence} />}</dd>
      </dl>
      {history}
    </div>
  );
}
