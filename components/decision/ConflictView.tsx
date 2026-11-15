'use client';

import { useEffect, useRef, type ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { WITHDRAWAL_CODE_LABELS, deciderLabel } from '@/lib/decision/copy';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { statusText } from '@/lib/question/stageList';
import { keptEvidenceLine } from '@/lib/question/draft';
import { formatDeclaredDate, formatTime } from '@/lib/format/dates';
import { evidenceDisplayName } from '@/components/evidence/EvidenceItemText';
import { conflictText } from '@/lib/question/saveOutcome';
import { declaredDateFromParts } from '@/lib/decision/rules';
import type { DecisionDraft } from '@/lib/question/draft';
import type { DecisionVersionView } from '@/types/api';
import './ConflictView.css';

const C = DECISION_FORM_COPY.conflict;

export type ConflictViewProps = {
  current: DecisionVersionView; mine: DecisionDraft; viewerId: string;
  onSaveMine: () => void; onEditMine: () => void; onDiscard: () => void;
  /** Who "your version" names as the decider and which evidence it holds, as the form knows them (W-4). */
  mineDecidedBy?: string; mineEvidence?: string[];
  /** Evidence ids the restored draft holds that the evidence block cannot name; Save mine attaches them too (F3). */
  mineKeptEvidence?: number;
};

/** The status words of either side: statusText's words, and a withdrawal named with its code (as S-13 names it). */
function statusWords(v: Pick<DecisionVersionView, 'status' | 'scopeAnswer' | 'withdrawalCode'>): string {
  if (v.status === 'withdrawn') return C.withdrawn(v.withdrawalCode === null ? '' : WITHDRAWAL_CODE_LABELS[v.withdrawalCode]);
  return v.status === null && v.scopeAnswer === null ? C.none : statusText(v);
}

function Column({ title, rows }: { title: string; rows: Array<[string, string]> }): ReactElement {
  return (
    <div>
      <h4>{title}</h4>
      <dl className="conflict-view__list">
        {rows.map(([k, v]) => (
          <div key={k}><dt>{`${k}: `}</dt><dd><bdi>{v}</bdi></dd></div>
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
    [C.status, statusWords(c)],
    [C.reason, c.reason ?? C.erased],
    [C.decidedBy, c.decidedBy === null ? C.none : `${deciderLabel(c.decidedBy, p.viewerId, 'record')}${c.declaredDate ? `, ${formatDeclaredDate(c.declaredDate)}` : ''}`],
    [C.evidence, c.evidence.length === 0 ? C.none : c.evidence.map(evidenceDisplayName).join(', ')],
  ];
  const mine: Array<[string, string]> = [
    [C.status, statusWords({ status: p.mine.status, scopeAnswer: p.mine.scopeAnswer, withdrawalCode: null })],
    [C.reason, p.mine.reason],
    // A first decision's draft may have no decider yet: say so, never "Decided by: , 14 Nov 2026" (review round 1, B-M3).
    [C.decidedBy, `${p.mineDecidedBy || C.notChosen}${'field' in mineDate ? '' : `, ${formatDeclaredDate(mineDate.date)}`}`],
    [C.evidence, (p.mineEvidence ?? []).length === 0 ? C.none : (p.mineEvidence ?? []).join(', ')],
    ...((p.mineKeptEvidence ?? 0) > 0 ? [[C.also, keptEvidenceLine(p.mineKeptEvidence ?? 0)] as [string, string]] : []),
  ];
  return (
    <section className="conflict-view" data-region="conflict" aria-labelledby="decision-conflict-heading">
      <h3 id="decision-conflict-heading" tabIndex={-1} ref={heading}>{C.heading}</h3>
      <p>{conflictText(c, p.viewerId, formatTime)}</p>
      <div className="conflict-view__columns">
        <Column title={C.saved(c.versionNumber)} rows={theirs} />
        <Column title={C.mine} rows={mine} />
      </div>
      <div className="conflict-view__actions">
        <Button variant="primary" onClick={p.onSaveMine}>{C.saveMine}</Button>
        <Button variant="secondary" onClick={p.onEditMine}>{C.editMine}</Button>
        <Button variant="secondary" onClick={p.onDiscard}>{C.discardMine}</Button>
      </div>
    </section>
  );
}
