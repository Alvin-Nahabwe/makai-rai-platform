'use client';

import { useId } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { UI_COPY } from '@/lib/ui/copy';
import './InlineConfirm.css';

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
  /** The confirm button is the kit's destructive button (decision B6) rather than the primary one. */
  destructive?: boolean;
  /** The cancel button's words; "Cancel" by default. */
  cancelLabel?: string;
}

/**
 * The confirmation of an action that cannot be undone or that changes what others rely on (UX-29): it
 * appears in place, names the object and the consequence, and its button repeats the action. It is not a
 * modal and not `window.confirm`. The confirm button is disabled while `busy` or when `canConfirm` is false (disabled, not
 * the kit's busy state, so a second press cannot send twice). Cancel comes first, in the markup and on screen, on every
 * width (plan 1A Task 6), and is never disabled.
 */
export function InlineConfirm(p: InlineConfirmProps): ReactElement {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} className="ui-confirm">
      <p id={headingId} className="ui-confirm__object"><strong>{p.objectName}</strong></p>
      <p className="ui-confirm__consequence">{p.consequence}</p>
      {p.children}
      {/* Cancel first, confirm last, nothing else in here: FindingActions.tsx focuses the confirm button as the last
          button of .ui-confirm__actions when the confirmation opens (UX-42). __tests__/unit/ui/inline-confirm.test.tsx
          pins the order and that selector. */}
      <div className="ui-confirm__actions">
        <Button variant="secondary" onClick={p.onCancel}>{p.cancelLabel ?? UI_COPY.confirm.cancel}</Button>
        <Button variant={p.destructive === true ? 'destructive' : 'primary'} disabled={p.busy === true || p.canConfirm === false} onClick={() => { void p.onConfirm(); }}>{p.actionLabel}</Button>
      </div>
    </div>
  );
}
