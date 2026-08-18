'use client';

import { formatProvenanceLine, driftBannerText, provisionalScoreNote } from '@/lib/report/provenance';

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
  /** O-15: `framework_versions.semver` this assessment is pinned to. */
  frameworkSemver: string;
  /** O-15: the date THIS assessment was pinned (`Assessment.startedAt`,
   * formatted 'YYYY-MM-DD' by the caller) -- see
   * `lib/report/provenance.ts#ProvenanceInfo` for why this is not
   * `framework_versions.publishedAt`. */
  frameworkPinnedDate: string;
  /** O-15: `framework_versions.contentHash`, full sha256 hex -- truncated
   * for display by `formatProvenanceLine`. */
  frameworkContentHash: string;
  /** O-14, completed half: `isFrameworkDrifted(assessment.status,
   * resolution.matches)`, computed by the caller (this component has
   * neither piece of information on its own). */
  frameworkDrifted: boolean;
}

/**
 * Renders the executive summary section with the overall score ring,
 * key stats (strengths, attentions, gaps, cross-stage effects), and the
 * report's provenance line (O-15) -- which framework version this
 * assessment was answered against, and when it was pinned. When the
 * deployed framework content has drifted from that pin AND the assessment
 * is completed, also renders a banner disclosing the mismatch (O-14,
 * completed half) -- the cached report underneath is left exactly as it
 * was; this is an annotation, never a recomputation.
 *
 * Fix round 2, Critical: the banner copy previously read "...it has not
 * been recomputed against the newer content" -- true only for an
 * assessment whose completion was ITSELF gated on drift (fix round 2 adds
 * that gate to `completeAssessment`, closing the path fix round 1 missed
 * entirely). It is not knowable from stored data alone whether an
 * assessment completed before that gate existed was scored against
 * matching or already-drifted content -- no field records what was
 * deployed at completion time, only what is deployed NOW. The copy below
 * therefore asserts only what is true unconditionally, for every reachable
 * state: the cached report reflects whatever was recorded at completion,
 * and viewing it never triggers a recalculation. It does NOT claim that
 * recording was itself against matching content, which cannot be verified
 * after the fact.
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
  frameworkSemver,
  frameworkPinnedDate,
  frameworkContentHash,
  frameworkDrifted,
}: ReportSummaryProps) {
  return (
    <div className="report-summary" id="report-summary">
      <h2>Executive summary</h2>
      {/*
        C6 F3: 'live-findings', not 'cached-only'. Three of the four stats
        this very component renders below -- strengths, to-strengthen and
        gaps -- are `useFindingsData`'s output
        (components/report/useFindingsData.ts), recomputed on every view
        from statically-imported `questionBank.json` /
        `assessmentAreas.json`, i.e. today's deployed content. Only
        `overallScore` and `completedStagesCount` come from the cached
        report. The unqualified "nothing is recalculated when viewed" copy
        this banner used to carry was therefore false, and false directly
        above the numbers it was false about. See
        `lib/report/provenance.ts#DriftBannerScope`.
      */}
      {frameworkDrifted && (
        <div className="report-drift-banner" role="alert" id="report-drift-banner">
          {driftBannerText('live-findings')}
        </div>
      )}
      <p className="report-provenance" id="report-provenance">
        {formatProvenanceLine({
          semver: frameworkSemver,
          pinnedDate: frameworkPinnedDate,
          contentHash: frameworkContentHash,
        })}
      </p>
      <div className="report-summary__grid">
        <div className="report-summary__overall">
          <div className="score-ring" style={{ '--score-color': levelColors[overallLevel] } as React.CSSProperties} role="img" aria-label={`Overall readiness score: ${overallScore}%, ${levelLabels[overallLevel]}`}>
            <span className="score-ring__value">{overallScore}%</span>
            <span className="score-ring__label">{levelLabels[overallLevel]}</span>
          </div>
          <p className="report-summary__provisional" role="note">
            {provisionalScoreNote()}
          </p>
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
