'use client';

interface CompletionModalProps {
  show: boolean;
  onClose: () => void;
  stageLabel: string;
  stageColor: string;
  areaScores: Record<string, number>;
  isLastStage: boolean;
  nextStageLabel: string;
  onViewReport: () => void;
  onContinueNext: () => void;
}

/**
 * CompletionModal — stage completion dialog.
 *
 * Displays area scores for the just-completed stage and offers
 * navigation to the report or to the next pipeline stage.
 */
export function CompletionModal({
  show,
  onClose,
  stageLabel,
  stageColor,
  areaScores,
  isLastStage,
  nextStageLabel,
  onViewReport,
  onContinueNext,
}: CompletionModalProps) {
  if (!show) return null;

  return (
    <div className="completion-modal-overlay" onClick={onClose}>
      <div className="completion-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="completion-modal-title">
        <div className="completion-modal__header" style={{ borderColor: stageColor }}>
          <h3 id="completion-modal-title">{stageLabel} stage finished</h3>
        </div>
        <div className="completion-modal__body">
          <p>Your {stageLabel.toLowerCase()} responses are saved. Area scores so far:</p>
          <div className="completion-modal__scores">
            {Object.entries(areaScores).map(([areaId, score]) => (
              <div key={areaId} className="completion-modal__score-row">
                <span className="completion-modal__area-id">{areaId}</span>
                <div className="completion-modal__score-bar">
                  <div className="completion-modal__score-fill" style={{ width: `${score}%`, backgroundColor: stageColor }}></div>
                </div>
                <span className="completion-modal__score-value">{score}%</span>
              </div>
            ))}
          </div>
        </div>
        <div className="completion-modal__actions">
          {isLastStage ? (
            <button className="btn btn--green btn--large btn--arrow" onClick={onViewReport}>
              View Full Report
            </button>
          ) : (
            <>
              <button className="btn btn--secondary" onClick={onViewReport}>
                View Report Now
              </button>
              <button className="btn btn--primary btn--arrow" onClick={onContinueNext}>
                Continue to {nextStageLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
