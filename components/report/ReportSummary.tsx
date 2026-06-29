'use client';

interface ReportSummaryProps {
  overallScore: number;
  overallLevel: string;
  completedStagesCount: number;
  strengthsCount: number;
  attentionsCount: number;
  gapsCount: number;
  activeModifiersCount: number;
  levelLabels: Record<string, string>;
  levelColors: Record<string, string>;
}

/**
 * Renders the executive summary section with the overall score ring
 * and key stats (strengths, attentions, gaps, cross-stage effects).
 */
export function ReportSummary({
  overallScore,
  overallLevel,
  completedStagesCount,
  strengthsCount,
  attentionsCount,
  gapsCount,
  activeModifiersCount,
  levelLabels,
  levelColors,
}: ReportSummaryProps) {
  return (
    <div className="report-summary" id="report-summary">
      <h2>Executive summary</h2>
      <div className="report-summary__grid">
        <div className="report-summary__overall">
          <div className="score-ring" style={{ '--score-color': levelColors[overallLevel] } as React.CSSProperties} role="img" aria-label={`Overall readiness score: ${overallScore}%, ${levelLabels[overallLevel]}`}>
            <span className="score-ring__value">{overallScore}%</span>
            <span className="score-ring__label">{levelLabels[overallLevel]}</span>
          </div>
          <p className="report-summary__desc">
            Overall readiness across {completedStagesCount} completed stage{completedStagesCount > 1 ? 's' : ''}.
            {overallScore < 50 && ' There are gaps that need fixing.'}
            {overallScore >= 50 && overallScore < 75 && ' Solid start, but some areas still need work.'}
            {overallScore >= 75 && ' You\'re in good shape. Keep it up as your system evolves.'}
          </p>
        </div>
        <div className="report-summary__stats">
          <div className="report-stat">
            <span className="report-stat__value" style={{ color: '#22C55E' }}>{strengthsCount}</span>
            <span className="report-stat__label">Areas of strength</span>
          </div>
          <div className="report-stat">
            <span className="report-stat__value" style={{ color: '#F59E0B' }}>{attentionsCount}</span>
            <span className="report-stat__label">To strengthen</span>
          </div>
          <div className="report-stat">
            <span className="report-stat__value" style={{ color: '#F97316' }}>{gapsCount}</span>
            <span className="report-stat__label">Gaps found</span>
          </div>
          <div className="report-stat">
            <span className="report-stat__value" style={{ color: '#C06014' }}>{activeModifiersCount}</span>
            <span className="report-stat__label">Cross-stage effects</span>
          </div>
        </div>
      </div>
    </div>
  );
}
