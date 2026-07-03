'use client';

import { useRef, useEffect } from 'react';

interface ResetModalProps {
  show: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * ResetModal — confirmation dialog using native <dialog>.
 */
export function ResetModal({ show, onClose, onConfirm }: ResetModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (show && !dialog.open) {
      dialog.showModal();
    } else if (!show && dialog.open) {
      dialog.close();
    }
  }, [show]);

  return (
    <dialog
      ref={dialogRef}
      className="completion-modal"
      aria-labelledby="reset-modal-title"
      onClose={onClose}
    >
      <h3 id="reset-modal-title">Reset Assessment?</h3>
      <p>This will permanently delete all your responses across all stages. This action cannot be undone.</p>
      <div className="completion-modal__actions">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" style={{ background: 'var(--color-risk-critical)' }} onClick={onConfirm}>Reset Everything</button>
      </div>
    </dialog>
  );
}
