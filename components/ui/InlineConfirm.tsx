'use client';

import { useId } from 'react';
import type { ReactElement, ReactNode } from 'react';

export interface InlineConfirmProps {
  /** What is being acted on, for example "Data card v1". */
  objectName: string;
  /** What will happen, for example "It stays listed as withdrawn." */
  consequence: string;
  /** The button's words: the action itself ("Withdraw document"), never "OK" (UX-29). */
  actionLabel: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
  canConfirm?: boolean;
  /** Extra fields, such as account deletion's password and typed phrase (both must allow pasting). */
  children?: ReactNode;
}

/**
 * The confirmation of an action that cannot be undone or that changes what others rely on (UX-29): it
 * appears in place, names the object and the consequence, and its button repeats the action. It is not a
 * modal and not `window.confirm`. The confirm button is disabled while `busy` or when `canConfirm` is false.
 */
export function InlineConfirm(p: InlineConfirmProps): ReactElement {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} className="card">
      <p id={headingId}><strong>{p.objectName}</strong></p>
      <p>{p.consequence}</p>
      {p.children}
      <div className="form-actions">
        <button type="button" className="btn btn--primary" disabled={p.busy === true || p.canConfirm === false} onClick={() => { void p.onConfirm(); }}>{p.actionLabel}</button>
        <button type="button" className="btn btn--secondary" onClick={p.onCancel}>Cancel</button>
      </div>
    </div>
  );
}
