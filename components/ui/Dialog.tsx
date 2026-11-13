'use client';

import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import type { ReactElement, ReactNode, SyntheticEvent } from 'react';
import './Dialog.css';

export type DialogProps = {
  open: boolean;
  title: string;
  children: ReactNode;
  /** The dialog's buttons, safe action first: showModal() focuses the first focusable element, so the safe action takes focus. */
  actions: ReactNode;
  /**
   * Called once when the browser closes the dialog (Escape, or a button of a form whose method is dialog); the caller
   * then sets `open` to false. Required: Escape always closes the native dialog, and a caller that kept `open` true
   * could never open it again.
   */
  onClose: () => void;
};

/**
 * A modal dialog (plan 1A Task 6, modern-web-guidance `dialog`): the native <dialog>, opened with showModal() when
 * `open` turns true and closed when it turns false. The browser makes the page inert, keeps focus inside, closes on
 * Escape and returns focus to the invoker, so there is no role, no aria-modal, no focus trap and no key handler here.
 *
 * Escape fires the native `cancel` and then `close`; `onClose` is called once for the two. A close the caller makes by
 * setting `open` to false is not reported back, nor is a `cancel` that bubbles from inside (a dismissed file picker), nor
 * a late `close` that arrives after the dialog was opened again. Unmounted while open, it closes the native dialog
 * first, so the browser returns focus to the invoker; a caller may also simply keep the Dialog mounted.
 *
 * Focus on opening: showModal() focuses the first focusable element inside the dialog, so the caller makes the safe
 * action the focused one by putting it first in `actions` (Cancel before Archive) with nothing focusable in `children`
 * before it. React's `autoFocus` is not the way: on the client it writes no `autofocus` attribute and focuses at mount,
 * while the dialog is still closed (react-dom-client `setProp` skips it, `commitMount` calls focus()).
 */
export function Dialog({ open, title, children, actions, onClose }: DialogProps): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  const reported = useRef(false);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      reported.current = false;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => { if (dialog?.open === true) dialog.close(); };
  }, []);

  const report = () => {
    if (reported.current) return;
    reported.current = true;
    onClose();
  };
  const own = (e: SyntheticEvent<HTMLDialogElement>) => e.target === e.currentTarget;

  return (
    <dialog ref={ref} className="ui-dialog" aria-labelledby={titleId} onCancel={(e) => { if (own(e)) report(); }}
      onClose={(e) => { if (own(e) && open && ref.current?.open === false) report(); }}>
      <h2 id={titleId} className="ui-dialog__title">{title}</h2>
      <div className="ui-dialog__body">{children}</div>
      <div className="ui-dialog__actions">{actions}</div>
    </dialog>
  );
}
