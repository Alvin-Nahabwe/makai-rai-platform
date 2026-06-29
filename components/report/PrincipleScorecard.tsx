'use client';

import { levelLabels, levelColors } from '@/data/constants';

interface PrincipleData {
  name: string;
  pct: number;
  level: string;
}

interface PrincipleScorecardProps {
  principle: PrincipleData;
}

/**
 * Renders a single principle scorecard card with level badge and progress bar.
 */
export function PrincipleScorecard({ principle }: PrincipleScorecardProps) {
  const { name, pct, level } = principle;
  return (
    <div className="scorecard-card card">
      <div className="scorecard-card__header">
        <h4>{name}</h4>
        <span className={`badge badge--${level}`}>{levelLabels[level]}</span>
      </div>
      <div className="scorecard-card__score">
        <span className="scorecard-card__pct" style={{ color: levelColors[level] }}>{pct}%</span>
        <div className="progress-bar">
          <div className="progress-bar__fill" style={{ width: `${pct}%`, backgroundColor: levelColors[level] }}></div>
        </div>
      </div>
    </div>
  );
}
