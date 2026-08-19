'use client';

import { useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { AreaScoreMap } from '@/types/domain';

interface CompletionModalProps {
  show: boolean;
  onClose: () => void;
  stageLabel: string;
  stageColor: string;
  /**
   * Task 11: `calculateAreaScores` has returned `EvidenceScore` objects
   * (maturity + practices, Task 1) since this branch started; this prop's
   * type was never updated to match, so callers cast the mismatch away with
   * `as Record<string, number>` and this component rendered the whole
   * object as JSX text -- React's "Objects are not valid as a child" crash,
   * on every stage completion. See `renderAreaScoreRows` below for the
   * fixed rendering and why maturity is the only reading shown here.
   */
  areaScores: AreaScoreMap;
  isLastStage: boolean;
  nextStageLabel: string;
  onViewReport: () => void;
  onContinueNext: () => void;
}

/**
 * Renders one score row per area: id, a maturity bar + percentage, or --
 * when the stage's areas were answered but this particular area carries no
 * maturity reading -- muted text instead of a bar (never `0%`, per the
 * `EvidenceScore.maturity === null` convention `AreaCard`/
 * `PrincipleScorecard` already use). Deliberately NOT exported from a
 * `useEffect`/`useRef`-bearing component body: this repo has no jsdom or
 * `@testing-library/react` (D-169), so a hook-bearing component cannot be
 * called directly in a test -- React throws "Invalid hook call" outside an
 * actual render. Factoring the score-row markup into this hook-free, pure
 * function (same split `AssessmentEngine.js#meanMaturity` and
 * `useFindingsData.ts#computeFindingsData` already use for the identical
 * reason) keeps the exact expression that used to crash directly callable
 * and testable via `extractText`, per `__tests__/unit/completion-modal-
 * scores.test.tsx`.
 *
 * Practices (the checklist-coverage reading) is deliberately NOT shown
 * here -- see this file's own doc comment below for why.
 */
export function renderAreaScoreRows(areaScores: AreaScoreMap, stageColor: string): ReactNode {
  return Object.entries(areaScores).map(([areaId, score]) => (
    <div key={areaId} className="completion-modal__score-row">
      <span className="completion-modal__area-id">{areaId}</span>
      {score.maturity !== null ? (
        <>
          <div className="completion-modal__score-bar">
            <div className="completion-modal__score-fill" style={{ width: `${score.maturity}%`, backgroundColor: stageColor }}></div>
          </div>
          <span className="completion-modal__score-value">{score.maturity}%</span>
        </>
      ) : (
        <span className="completion-modal__score-value completion-modal__score-value--muted">No maturity questions</span>
      )}
    </div>
  ));
}

/**
 * CompletionModal — stage completion dialog using native <dialog>.
 *
 * Task 11 judgement call: shows maturity only, not both EvidenceScore
 * readings. This is the moment a user is told how the stage went, which
 * argues for completeness -- but the existing per-area row is a single
 * bar-plus-percentage widget (`.completion-modal__score-bar`/`-fill`),
 * built for one number, in a dialog capped at 520px wide
 * (`.completion-modal` in AssessmentPage.css). `AreaCard`'s two-reading
 * treatment (`.gap-card__readings`, two full label+value blocks per area,
 * plus a collapsible practices list) is sized for a full report page, not
 * a per-row slot in a stage-completion popup; cramming a second reading in
 * would mean either shrinking both past legibility or restructuring this
 * modal's layout for a dialog whose job is a fast, low-stakes "here's
 * roughly how it went" glance -- not an audit. The full two-reading detail
 * (including the practices list `AreaCard` shows) is one click away via
 * this same modal's "View Report Now" / "View Full Report" buttons, which
 * route to the report page that already renders both. Maturity is the
 * reading that answers the modal's actual question -- "how mature were
 * this stage's answers" -- where practices-in-place is a coverage count
 * that reads oddly stripped of the checklist items behind it, which this
 * space cannot show without turning the modal into a scrollable list of
 * one form or the other. Nothing here forecloses adding practices later if
 * that turns out wrong; this is a scope call for THIS task, driven by the
 * existing widget's shape, not a claim that practices are unimportant.
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
      aria-labelledby="completion-modal-title"
      onClose={onClose}
    >
      <div className="completion-modal__header" style={{ borderColor: stageColor }}>
        <h3 id="completion-modal-title">{stageLabel} stage finished</h3>
      </div>
      <div className="completion-modal__body">
        <p>Your {stageLabel.toLowerCase()} responses are saved. Area scores so far:</p>
        <div className="completion-modal__scores">
          {renderAreaScoreRows(areaScores, stageColor)}
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
    </dialog>
  );
}
