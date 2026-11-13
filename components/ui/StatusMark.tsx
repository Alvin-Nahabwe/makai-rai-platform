import type { ReactElement } from 'react';
import type { ScopeAnswer, StatusMarkKind } from '@/components/ui/types';
import { STATUS_MARK_COPY, UI_COPY } from '@/lib/ui/copy';
import './StatusMark.css';

export type StatusMarkProps = {
  kind: StatusMarkKind;
  size?: 16 | 20 | 24;
  words?: 'visible' | 'hidden';
  /** Only with `done`: adds ", no evidence attached". */
  noEvidence?: boolean;
  /** Only with `scope_answered`: the answer the words give. */
  scopeAnswer?: ScopeAnswer;
};

const RING = { cx: 12, cy: 12, r: 8 } as const;
const SLASH = <line x1={6.3} y1={17.7} x2={17.7} y2={6.3} stroke="currentColor" strokeWidth={2} strokeLinecap="round" />;

/** The shape of each kind (plan 1A, StatusMark): viewBox 24, all in currentColor, so the colour comes from CSS alone. */
const SHAPES: Readonly<Record<StatusMarkKind, ReactElement>> = {
  done: <circle {...RING} fill="currentColor" />,
  partly: <><circle {...RING} fill="none" stroke="currentColor" strokeWidth={2} /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /></>,
  not_yet: <circle {...RING} fill="none" stroke="currentColor" strokeWidth={2.5} />,
  not_applicable: <><circle {...RING} fill="none" stroke="currentColor" strokeWidth={2} />{SLASH}</>,
  does_not_apply: <><circle {...RING} fill="none" stroke="currentColor" strokeWidth={2} strokeDasharray="3 2.6" />{SLASH}</>,
  scope_answered: <rect x={5} y={5} width={14} height={14} fill="currentColor" />,
  no_decision: <circle cx={12} cy={12} r={3.5} fill="currentColor" />,
};

/**
 * The words of a mark: its kind's words, with the no-evidence note on done and the answer on the personal data question.
 * The answer mark given no answer says only that the question is answered.
 */
export function statusMarkWords(kind: StatusMarkKind, noEvidence = false, scopeAnswer?: ScopeAnswer): string {
  if (kind === 'scope_answered') return scopeAnswer === undefined ? UI_COPY.marks.answered : STATUS_MARK_COPY.scope_answered(scopeAnswer);
  if (kind === 'done' && noEvidence) return `${STATUS_MARK_COPY.done}, ${STATUS_MARK_COPY.noEvidence}`;
  return STATUS_MARK_COPY[kind];
}

/** The shape alone, hidden from assistive technology: for a caller that writes the words itself (RouteRow). */
export function MarkShape({ kind, size = 16 }: { kind: StatusMarkKind; size?: 16 | 20 | 24 }): ReactElement {
  return (
    <svg className="ui-mark__shape" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {SHAPES[kind]}
    </svg>
  );
}

/** A status as a shape and its words, in ink (spec 7.2). There is no tick and no colour per status. */
export function StatusMark({ kind, size = 16, words = 'visible', noEvidence = false, scopeAnswer }: StatusMarkProps): ReactElement {
  return (
    <span className={`ui-mark ui-mark--${kind}`} data-mark-kind={kind}>
      <MarkShape kind={kind} size={size} />
      <span className={words === 'hidden' ? 'ui-mark__words visually-hidden' : 'ui-mark__words'}>{statusMarkWords(kind, noEvidence, scopeAnswer)}</span>
    </span>
  );
}
