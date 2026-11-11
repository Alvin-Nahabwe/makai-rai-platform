import type { ReactElement } from 'react';
import { SealMarker } from '@/components/review/SealMarker';
import { VersionEvidenceList } from '@/components/evidence/VersionEvidenceList';
import { WITHDRAWAL_CODE_LABELS, deciderLabel } from '@/lib/decision/copy';
import { textErasedLine } from '@/lib/documents/copy';
import { formatDay, formatDeclaredDate, formatTime } from '@/lib/format/dates';
import { statusText } from '@/lib/question/stageList';
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
 * "Withdrawn: <code>"), reason or the erased line, who decided with the declared date at its precision, who entered it
 * with the received time (UTC on request, because the seal manifest uses UTC), the content version with that version's
 * wording, its evidence (EVD's slot) and its seals (REV-b's slot). A server component: every record text is a React
 * child, so it is shown as text and never as markup (NFR-SEC-11). Each entry carries `data-version-number`.
 */
export function DecisionHistoryList({ orgSlug, entries }: { orgSlug: string; entries: HistoryEntry[] }): ReactElement {
  return (
    <ol className="decision-history" style={{ listStyle: 'none', padding: 0 }}>
      {entries.map(({ version: v, wording, seals }) => (
        <li key={v.id} data-version-number={v.versionNumber} className="card" style={{ marginBottom: '0.75rem' }}>
          <h2 style={{ fontSize: '1.1rem' }}>{`Version ${v.versionNumber}`}</h2>
          <SealMarker seals={seals} />
          <dl>
            <dt>Status</dt>
            <dd><span className="status-label" style={{ color: 'var(--text-body)' }}>
              {v.status === 'withdrawn' ? `Withdrawn: ${v.withdrawalCode === null ? '' : WITHDRAWAL_CODE_LABELS[v.withdrawalCode]}` : statusText(v)}
            </span></dd>
            <dt>Reason</dt>
            <dd>{v.reasonErased !== null ? textErasedLine(v.reasonErased.erasedOn) : (v.reason ?? '')}</dd>
            {v.decidedBy !== null ? (<><dt>Decided by</dt><dd>{`${deciderLabel(v.decidedBy, '', 'record')}${v.declaredDate === null ? '' : `, ${formatDeclaredDate(v.declaredDate)}`}`}</dd></>) : null}
            <dt>Entered by</dt>
            <dd>
              {`${v.enteredBy.formerMember ? `${v.enteredBy.name} (former member)` : v.enteredBy.name}, ${formatDay(v.receivedAt)} ${formatTime(v.receivedAt)}`}
              {' '}
              <details style={{ display: 'inline-block' }}><summary>Show UTC</summary><time dateTime={v.receivedAt}>{v.receivedAt}</time></details>
            </dd>
            <dt>Content version</dt>
            <dd>{v.content.semver}</dd>
            {wording !== null ? (<><dt>Question in that version</dt><dd>{wording.text}</dd><dt>What good looked like</dt><dd>{wording.expectedPractice}</dd></>) : null}
            <dt>Evidence</dt>
            <dd>{v.evidence.length === 0 ? 'None' : <VersionEvidenceList orgSlug={orgSlug} items={v.evidence} />}</dd>
          </dl>
        </li>
      ))}
    </ol>
  );
}
