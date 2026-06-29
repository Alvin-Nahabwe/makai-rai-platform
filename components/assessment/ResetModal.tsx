'use client';

interface ResetModalProps {
  show: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * ResetModal — confirmation dialog for resetting the full assessment.
 */
export function ResetModal({ show, onClose, onConfirm }: ResetModalProps) {
  if (!show) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="completion-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="reset-modal-title">
        <h3 id="reset-modal-title">Reset Assessment?</h3>
        <p>This will permanently delete all your responses across all stages. This action cannot be undone.</p>
        <div className="completion-modal__actions">
          <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" style={{ background: '#DC2626' }} onClick={onConfirm}>Reset Everything</button>
        </div>
      </div>
    </div>
  );
}
