'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { revealFocused, revealOpened } from '@/components/ui/revealInView';
import { useHydrated } from '@/lib/client/useHydrated';
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
 * The confirmation of an action that cannot be undone or that changes what others rely on (UX-29): it appears in place, names
 * the object and the consequence, and its button repeats the action. It is not a modal and not `window.confirm`. Cancel comes
 * first, in the markup and on screen, on every width (plan 1A Task 6), and is never disabled or busy.
 *
 * Busy (D-386, SC 2.4.3): while `busy` the confirm button is the kit's Button busy state: `aria-busy="true"`, a spinner, and
 * a press that does nothing, so a second press cannot send twice while the button keeps keyboard focus. `canConfirm` false
 * disables it, busy or not.
 *
 * In view (D-386, SC 2.4.11): a confirmation that opens is wholly in view, and so is whatever takes focus inside it, on every
 * screen that uses it, without the screen doing anything. Two things do it (components/ui/revealInView.ts), each an instant
 * nearest-edge scroll:
 *   - On open, in a layout effect, which runs before every caller's own effects and so before a caller's focus(): the whole
 *     confirmation, then the element that has focus at that moment if it is inside. It moves no focus: each screen keeps
 *     putting focus where it did. Only when the confirmation mounted after the page: one that comes with the page's own HTML
 *     (the kit page's) is not revealed, so that page still loads at the top. `useHydrated` tells the two apart by its value in
 *     the first render (false while hydrating server HTML). Not handled: a page reached by client-side navigation that shows a
 *     confirmation from its first render would be revealed too; no screen does that today.
 *   - On focus: an element that takes focus inside the confirmation (a caller's focus(), a later script focus such as a field
 *     error's, or Tab) is brought wholly into view, as DecisionForm.tsx's form does.
 */
export function InlineConfirm(p: InlineConfirmProps): ReactElement {
  const headingId = useId();
  const box = useRef<HTMLDivElement>(null);
  const hydrated = useHydrated();
  const [mountedAfterPage] = useState(hydrated);   // the first render's value: false while hydrating the page's own HTML
  useLayoutEffect(() => {
    if (mountedAfterPage) revealOpened<Element>(box.current!, document.activeElement);
  }, [mountedAfterPage]);
  return (
    <div ref={box} role="group" aria-labelledby={headingId} className="ui-confirm" onFocus={(e) => { revealFocused(e.target); }}>
      <p id={headingId} className="ui-confirm__object"><strong>{p.objectName}</strong></p>
      <p className="ui-confirm__consequence">{p.consequence}</p>
      {p.children}
      {/* Cancel first, confirm last, nothing else in here: FindingActions.tsx focuses the confirm button as the last
          button of .ui-confirm__actions when the confirmation opens (UX-42). __tests__/unit/ui/inline-confirm.test.tsx
          pins the order and that selector. */}
      <div className="ui-confirm__actions">
        <Button variant="secondary" onClick={p.onCancel}>{p.cancelLabel ?? UI_COPY.confirm.cancel}</Button>
        <Button variant={p.destructive === true ? 'destructive' : 'primary'} busy={p.busy === true} disabled={p.canConfirm === false} onClick={() => { void p.onConfirm(); }}>{p.actionLabel}</Button>
      </div>
    </div>
  );
}
