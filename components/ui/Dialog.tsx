'use client';

import { useEffect, useId, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import './Dialog.css';

export type DialogProps = {
  open: boolean;
  title: string;
  children: ReactNode;
  /** The dialog's buttons, safe action first; it takes the first focus when the dialog opens. */
  actions: ReactNode;
  /** Called once when the browser closes the dialog (Escape, or a button of a form whose method is dialog); the caller then sets `open` to false. */
  onClose?: () => void;
};

/**
 * A modal dialog (plan 1A Task 6, modern-web-guidance `dialog`): the native <dialog>, opened with showModal() when
 * `open` turns true and closed when it turns false. The browser makes the page inert, keeps focus inside, closes on
 * Escape and returns focus to the invoker, so there is no role, no aria-modal, no focus trap and no key handler here.
 *
 * Escape fires the native `cancel` and then `close`; `onClose` is called once for the two. A close the caller makes by
 * setting `open` to false is not reported back.
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

  const report = () => {
    if (reported.current) return;
    reported.current = true;
    onClose?.();
  };

  return (
    <dialog ref={ref} className="ui-dialog" aria-labelledby={titleId} onCancel={report} onClose={() => { if (open) report(); }}>
      <h2 id={titleId} className="ui-dialog__title">{title}</h2>
      <div className="ui-dialog__body">{children}</div>
      <div className="ui-dialog__actions">{actions}</div>
    </dialog>
  );
}
