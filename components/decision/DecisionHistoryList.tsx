import type { ReactElement } from 'react';
import { SealMarker } from '@/components/review/SealMarker';
import { VersionEvidenceList } from '@/components/evidence/VersionEvidenceList';
import { StatusMark } from '@/components/ui/StatusMark';
import { WITHDRAWAL_CODE_LABELS, deciderLabel } from '@/lib/decision/copy';
import { textErasedLine } from '@/lib/documents/copy';
import { formatDay, formatDeclaredDate, formatTime } from '@/lib/format/dates';
import { QUESTION_COPY } from '@/lib/question/copy';
import { markKindOf } from '@/lib/ui/marks';
import type { DecisionVersionView } from '@/types/api';
import type { SealRef } from '@/types/seal';

export type HistoryEntry = {
  version: DecisionVersionView;
  /** The question's wording in that version's content version (FR-CNT-07), or null when that version no longer lists it. */
  wording: { text: string; expectedPractice: string } | null;
  seals: SealRef[];
};

/**
 * S-13's list (FR-DEC-04, FR-DEC-08, FR-CNT-07; 7.5.6, 7.5.8): every version newest first, each with its status (or
 * "Withdrawn: <code>"), reason or the erased line, who decided with the declared date at its precision, who entered
 * it with the received time (a `<time>` carrying the exact instant), the question as worded in that version, its
 * evidence (EVD's slot) and its seals (REV-b's slot). A server component: every record text is a React child, so it
 * is shown as text and never as markup (NFR-SEC-11). Each entry carries `data-version-number`.
 */
export function DecisionHistoryList({ orgSlug, entries, isScopeQuestion = false }: {
  orgSlug: string; entries: HistoryEntry[];
  /** Whether the question is the personal data question, whose versions show the answer mark (as CurrentDecision). */
  isScopeQuestion?: boolean;
}): ReactElement {
  const H = QUESTION_COPY.history;
  return (
    <ol className="decision-history" style={{ listStyle: 'none', padding: 0 }}>
      {entries.map(({ version: v, wording, seals }) => (
        <li key={v.id} data-version-number={v.versionNumber} className="card" style={{ marginBottom: '0.75rem' }}>
          <h2 style={{ fontSize: '1.1rem' }}>{H.version(v.versionNumber)}</h2>
          <SealMarker seals={seals} />
          <dl>
            <dt>{H.status}</dt>
            {/* A withdrawn version keeps its words and no mark; any other shows the kit's mark with its words (spec 7.2). */}
            <dd>{v.status === 'withdrawn'
              ? <span className="status-label">{H.withdrawn(v.withdrawalCode === null ? '' : WITHDRAWAL_CODE_LABELS[v.withdrawalCode])}</span>
              : <StatusMark kind={markKindOf({ status: v.status, scopeAnswer: v.scopeAnswer, gated: false, isScopeQuestion })} scopeAnswer={v.scopeAnswer ?? undefined} />}</dd>
            <dt>{H.reason}</dt>
            <dd>{v.reasonErased !== null ? textErasedLine(v.reasonErased.erasedOn) : (v.reason ?? '')}</dd>
            {v.decidedBy !== null ? (<><dt>{H.decidedBy}</dt><dd>{`${deciderLabel(v.decidedBy, '', 'record')}${v.declaredDate === null ? '' : `, ${formatDeclaredDate(v.declaredDate)}`}`}</dd></>) : null}
            <dt>{H.enteredBy}</dt>
            <dd>
              {`${v.enteredBy.formerMember ? QUESTION_COPY.current.formerMember(v.enteredBy.name) : v.enteredBy.name}, `}
              <time dateTime={v.receivedAt}>{`${formatDay(v.receivedAt)} ${formatTime(v.receivedAt)}`}</time>
            </dd>
            {wording !== null ? (<><dt>{H.questionThen}</dt><dd>{wording.text}</dd><dt>{H.goodPracticeThen}</dt><dd>{wording.expectedPractice}</dd></>) : null}
            <dt>{H.evidence}</dt>
            <dd>{v.evidence.length === 0 ? H.noEvidence : <VersionEvidenceList orgSlug={orgSlug} items={v.evidence} />}</dd>
          </dl>
        </li>
      ))}
    </ol>
  );
}
