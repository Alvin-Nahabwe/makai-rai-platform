'use client';

import { STAGE_ORDER, stageLabels } from '@/data/constants';
import {
  getStageStatus,
  isStageAccessible,
  canGenerateReport,
  calculateAreaScores,
} from '@/lib/engine/AssessmentEngine.js';
import type { EngineState } from '@/types/domain';

/** Stage descriptions shown on accessible (non-locked) cards. */
const stageDescriptions: Record<string, string> = {
  'pre-processing': 'Are you solving a well-defined problem, with appropriate data, for the people who will actually be affected? This stage covers everything before a model gets built.',
  'in-processing': 'How is your model trained, tested, and validated? Covers fairness, explainability, and robustness during development.',
  'post-processing': 'What happens once the model is live? Looks at monitoring, accountability, human oversight, and how the system performs in practice.',
};

interface StageSelectorProps {
  engineState: EngineState;
  onRestart: () => void;
  onSelectStage: (stage: string) => void;
  onViewReport: () => void;
  /** D-129 round 2: "Start Again" rewrites every response in the
   * assessment via the same autoSave PATCH the response inputs use
   * (`onRestart` in AssessmentPageClient.tsx), so it is gated identically
   * — `can(ctx.role, 'assessment:respond')`, computed server-side and
   * threaded down, never re-derived here. */
  canRestart: boolean;
}

/**
 * StageSelector — pipeline overview rendered when no stage is selected.
 *
 * Shows a progress indicator (circles + connectors), stage cards
 * (locked / available / completed), and action buttons for viewing
 * the report or restarting the assessment.
 */
export function StageSelector({ engineState, onRestart, onSelectStage, onViewReport, canRestart }: StageSelectorProps) {
  return (
    <div className="assessment-page" id="assessment-page">
      <section className="page-hero page-hero--animated">
        <div className="page-hero__bg"></div>
        <div className="page-hero__grid-overlay"></div>
        <div className="page-hero__accent-line"></div>
        <div className="container" style={{ position: 'relative', zIndex: 2 }}>
          <span className="text-accent">Responsible AI Assessment</span>
          <h1>AI Lifecycle Assessment</h1>
          <p className="page-hero__desc">Complete each stage in order. Your answers in earlier stages affect the weight and depth of later questions.</p>
        </div>
      </section>

      {/* Pipeline progress indicator */}
      <section className="section">
        <div className="container">
          <div className="pipeline-progress" id="pipeline-progress">
            {STAGE_ORDER.map((stage, idx) => {
              const status = getStageStatus(engineState, stage);
              const cfg = stageLabels[stage];
              const areaScores = calculateAreaScores(engineState, stage);
              const scoreValues = Object.values(areaScores) as number[];
              const avgScore = scoreValues.length > 0
                ? Math.round(scoreValues.reduce((s: number, v: number) => s + v, 0) / scoreValues.length)
                : 0;

              return (
                <div key={stage} className="pipeline-progress__step-wrapper">
                  <div className={`pipeline-progress__step pipeline-progress__step--${status}`}
                       style={{ '--stage-color': cfg.color } as React.CSSProperties}>
                    <div className="pipeline-progress__circle">
                      {status === 'completed' ? '✓' : status === 'locked' ? '🔒' : (idx + 1)}
                    </div>
                    <div className="pipeline-progress__label">{cfg.label}</div>
                    {status === 'completed' && (
                      <div className="pipeline-progress__score">{avgScore}%</div>
                    )}
                    {status === 'locked' && (
                      <div className="pipeline-progress__locked-label">Locked</div>
                    )}
                  </div>
                  {idx < STAGE_ORDER.length - 1 && (
                    <div className={`pipeline-progress__connector pipeline-progress__connector--${
                      getStageStatus(engineState, STAGE_ORDER[idx + 1]) !== 'locked' ? 'active' : 'inactive'
                    }`}></div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Stage cards */}
          <div className="stage-selector" id="stage-selector">
            {STAGE_ORDER.map(stage => {
              const status = getStageStatus(engineState, stage);
              const cfg = stageLabels[stage];

              const accessible = isStageAccessible(engineState, stage);

              if (!accessible) {
                // Locked card
                const prevStage = STAGE_ORDER[STAGE_ORDER.indexOf(stage) - 1];
                return (
                  <div key={stage} className="stage-select-card card stage-select-card--locked"
                       style={{ '--stage-color': cfg.color } as React.CSSProperties}>
                    <div className="stage-select-card__lock-icon">🔒</div>
                    <h2>{cfg.label}</h2>
                    <p className="stage-select-card__locked-msg">
                      Complete {stageLabels[prevStage]?.label} first
                    </p>
                  </div>
                );
              }

              return (
                <button key={stage}
                      onClick={() => onSelectStage(stage)}
                      className={`stage-select-card card ${status === 'completed' ? 'stage-select-card--completed' : ''}`}
                      style={{ '--stage-color': cfg.color } as React.CSSProperties}>
                  {status === 'completed' && <div className="stage-select-card__check">✓</div>}
                  <h2>{cfg.label}</h2>
                  <p className="stage-select-card__desc">{stageDescriptions[stage]}</p>
                  <span className="btn btn--primary btn--arrow" style={{ backgroundColor: cfg.color, borderColor: cfg.color }}>
                    {status === 'completed' ? 'Review Assessment' : 'Begin Assessment'}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Report button if at least one stage is complete */}
          {canGenerateReport(engineState) && (
            <div className="stage-selector__report-cta">
              <button onClick={onViewReport} className="btn btn--green btn--large btn--arrow" id="generate-report-btn">
                View Lifecycle Report
              </button>
            </div>
          )}

          {/* Restart assessment — shown once the user has actually started,
              AND only to a role that may respond (D-129 round 2). */}
          {canRestart && Object.values(engineState.stages || {}).some(
            (st) => st.status === 'completed' || Object.keys(st.responses || {}).length > 0,
          ) && (
            <div style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
              <button
                className="btn btn--secondary"
                id="restart-assessment-btn"
                onClick={onRestart}
              >
                Start Again
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
