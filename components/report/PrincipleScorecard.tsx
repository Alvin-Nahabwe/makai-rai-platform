'use client';

import { levelLabels, levelColors } from '@/data/constants';
import type { PracticeCoverage } from '@/types/domain';

interface PrincipleData {
  name: string;
  pct: number | null;
  level: string;
  practices: PracticeCoverage | null;
}

interface PrincipleScorecardProps {
  principle: PrincipleData;
}

/**
 * Renders a single principle scorecard card with level badge and progress bar.
 *
 * `pct` (maturity) and `practices` (checklist coverage) are the two
 * independent readings from `EvidenceScore` -- see
 * docs/superpowers/specs/2026-08-18-practices-maturity-split-design.md §3.3.
 * Maturity renders as a percentage with its level colour; practices renders
 * as a plain count with neither, because a coverage count carries no band.
 * Absent evidence renders as text, never as 0 or 0%.
 */
export function PrincipleScorecard({ principle }: PrincipleScorecardProps) {
  const { name, pct, level, practices } = principle;
  return (
    <div className="scorecard-card card">
      <div className="scorecard-card__header">
        <h4>{name}</h4>
        <span className={`badge badge--${level}`}>{levelLabels[level]}</span>
      </div>
      <div className="scorecard-card__score">
        {pct !== null ? (
          <>
            <span className="scorecard-card__pct" style={{ color: levelColors[level] }}>{pct}%</span>
            <div className="progress-bar">
              <div className="progress-bar__fill" style={{ width: `${pct}%`, backgroundColor: levelColors[level] }}></div>
            </div>
          </>
        ) : (
          <span className="scorecard-card__pct scorecard-card__pct--muted">No maturity questions</span>
        )}
      </div>
      <div className="scorecard-card__practices">
        {practices !== null
          ? `${practices.inPlace} of ${practices.total} practices in place`
          : 'No practices assessed'}
      </div>
    </div>
  );
}
