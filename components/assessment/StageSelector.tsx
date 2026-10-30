'use client';

import { STAGE_ORDER, stageLabels } from '@/data/constants';

/** Stage descriptions shown on each stage card. */
const stageDescriptions: Record<string, string> = {
  'pre-processing': 'Are you solving a well-defined problem, with appropriate data, for the people who will actually be affected? This stage covers everything before a model gets built.',
  'in-processing': 'How is your model trained, tested, and validated? Covers fairness, explainability, and robustness during development.',
  'post-processing': 'What happens once the model is live? Looks at monitoring, accountability, human oversight, and how the system performs in practice.',
};

interface StageSelectorProps {
  onSelectStage: (stage: string) => void;
}

/**
 * StageSelector — the three lifecycle stages as cards, rendered when no stage
 * is selected.
 *
 * The score parts of the v0.5.0 component are gone: the per-stage maturity
 * badge, the report button, the completion and lock states and the restart
 * control, all of which read the removed scoring engine. What remains is the
 * module structure the stage workspace (S-11) builds on.
 */
export function StageSelector({ onSelectStage }: StageSelectorProps) {
  return (
    <div className="assessment-page" id="assessment-page">
      <section className="page-hero page-hero--animated">
        <div className="page-hero__bg"></div>
        <div className="page-hero__grid-overlay"></div>
        <div className="page-hero__accent-line"></div>
        <div className="container" style={{ position: 'relative', zIndex: 2 }}>
          <span className="text-accent">Responsible AI Assessment</span>
          <h1>AI Lifecycle Assessment</h1>
          <p className="page-hero__desc">Choose a stage to begin.</p>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="stage-selector" id="stage-selector">
            {STAGE_ORDER.map(stage => {
              const cfg = stageLabels[stage];

              return (
                <button key={stage}
                      onClick={() => onSelectStage(stage)}
                      className="stage-select-card card"
                      style={{ '--stage-color': cfg.color } as React.CSSProperties}>
                  <h2>{cfg.label}</h2>
                  <p className="stage-select-card__desc">{stageDescriptions[stage]}</p>
                  <span className="btn btn--primary btn--arrow" style={{ backgroundColor: cfg.color, borderColor: cfg.color }}>
                    Begin Assessment
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
