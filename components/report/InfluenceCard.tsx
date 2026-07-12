'use client';

interface ModifierSource {
  type?: string;
  areaId?: string;
  areaName?: string;
  areaScore?: number;
  threshold?: number;
  questionId?: string;
  questionText?: string;
}

export interface Modifier {
  modifier: number;
  ruleId: string;
  questionId: string;
  questionText: string;
  rationale: string;
  citation?: string;
  source?: ModifierSource;
}

interface InfluenceCardProps {
  mod: Modifier;
}

/**
 * Renders a single cross-stage influence card showing how an earlier-stage
 * response caused a later-stage question to be weighted more heavily.
 */
export function InfluenceCard({ mod }: InfluenceCardProps) {
  return (
    <div className="influence-card card">
      <div className="influence-card__header">
        <span className="influence-card__badge">Weight: {mod.modifier}×</span>
        <span className="influence-card__qid">{mod.ruleId}</span>
      </div>
      {/* Source trigger */}
      {mod.source?.type === 'area' && (
        <div className="influence-card__trigger">
          <span className="influence-card__trigger-label">Trigger</span>
          <span className="influence-card__trigger-detail">
            Area <strong>{mod.source.areaId}</strong> ({mod.source.areaName}) scored {mod.source.areaScore}% — below the {mod.source.threshold}% threshold
          </span>
        </div>
      )}
      {mod.source?.type === 'question' && (
        <div className="influence-card__trigger">
          <span className="influence-card__trigger-label">Trigger</span>
          <span className="influence-card__trigger-detail">
            <strong>{mod.source.questionId}</strong>: {mod.source.questionText}
          </span>
        </div>
      )}
      {/* Target question */}
      <div className="influence-card__target">
        <span className="influence-card__target-label">Weighted question</span>
        <span className="influence-card__target-detail">
          <strong>{mod.questionId}</strong>: {mod.questionText}
        </span>
      </div>
      <p className="influence-card__rationale">{mod.rationale}</p>
      <p className="influence-card__citation">{mod.citation}</p>
    </div>
  );
}
