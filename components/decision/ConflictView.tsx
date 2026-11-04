'use client';

import { useEffect, useRef, type ReactElement } from 'react';
import { SCOPE_OPTIONS, STATUS_OPTIONS, deciderLabel } from '@/lib/decision/copy';
import { formatDeclaredDate, formatTime } from '@/lib/format/dates';
import { evidenceDisplayName } from '@/components/evidence/VersionEvidenceList';
import { conflictText } from '@/lib/question/saveOutcome';
import { declaredDateFromParts } from '@/lib/decision/rules';
import type { DecisionDraft } from '@/lib/question/draft';
import type { DecisionVersionView } from '@/types/api';

export type ConflictViewProps = {
  current: DecisionVersionView; mine: DecisionDraft; viewerId: string;
  onSaveMine: () => void; onEditMine: () => void; onDiscard: () => void;
  /** Who "your answer" names as the decider and which evidence it holds, as the form knows them (W-4). */
  mineDecidedBy?: string; mineEvidence?: string[];
};

const statusWords = (status: string | null, scope: string | null): string =>
  STATUS_OPTIONS.find((o) => o.value === status)?.label
  ?? (scope === null ? 'None' : `Scope answer: ${SCOPE_OPTIONS.find((o) => o.value === scope)?.label ?? scope}`);

function Column({ title, rows }: { title: string; rows: Array<[string, string]> }): ReactElement {
  return (
    <div>
      <h4>{title}</h4>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}><dt style={{ display: 'inline', fontWeight: 600 }}>{`${k}: `}</dt><dd style={{ display: 'inline', margin: 0 }}><bdi>{v}</bdi></dd></div>
        ))}
      </dl>
    </div>
  );
}

/**
 * W-4 (UX-28, FR-DEC-05, M-10): someone saved a newer version after this person started. Both versions side by
 * side, who saved the newer one and when (the same account is named as "you"), and three actions; nothing is
 * merged. The heading takes focus when the view opens, so the change is announced and the person starts here
 * (NFR-A11Y-03). Every record text is a React child, so it is shown as text, never as markup (NFR-SEC-11).
 */
export function ConflictView(p: ConflictViewProps): ReactElement {
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { heading.current?.focus(); }, [p.current.id]);
  const c = p.current;
  const mineDate = declaredDateFromParts(p.mine.date);
  const theirs: Array<[string, string]> = [
    ['Status', statusWords(c.status, c.scopeAnswer)],
    ['Reason', c.reason ?? 'Erased'],
    ['Decided by', c.decidedBy === null ? 'None' : `${deciderLabel(c.decidedBy, p.viewerId, 'record')}${c.declaredDate ? `, ${formatDeclaredDate(c.declaredDate)}` : ''}`],
    ['Evidence', c.evidence.length === 0 ? 'None' : c.evidence.map(evidenceDisplayName).join(', ')],
  ];
  const mine: Array<[string, string]> = [
    ['Status', statusWords(p.mine.status, p.mine.scopeAnswer)],
    ['Reason', p.mine.reason],
    ['Decided by', `${p.mineDecidedBy ?? ''}${'field' in mineDate ? '' : `, ${formatDeclaredDate(mineDate.date)}`}`],
    ['Evidence', (p.mineEvidence ?? []).length === 0 ? 'None' : (p.mineEvidence ?? []).join(', ')],
  ];
  return (
    <section className="card" data-region="conflict" aria-labelledby="decision-conflict-heading">
      <h3 id="decision-conflict-heading" tabIndex={-1} ref={heading}>Not saved: someone saved a newer version.</h3>
      <p>{conflictText(c, p.viewerId, formatTime)}</p>
      <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))' }}>
        <Column title={`Version ${c.versionNumber} (saved)`} rows={theirs} />
        <Column title="Your answer (draft on this device)" rows={mine} />
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn--primary" onClick={p.onSaveMine}>{`Save mine as version ${c.versionNumber + 1}`}</button>
        <button type="button" className="btn btn--secondary" onClick={p.onEditMine}>Edit mine first</button>
        <button type="button" className="btn btn--secondary" onClick={p.onDiscard}>Discard mine</button>
      </div>
    </section>
  );
}
