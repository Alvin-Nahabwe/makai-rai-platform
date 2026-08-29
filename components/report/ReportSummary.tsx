'use client';

import { formatProvenanceLine, driftBannerText, provisionalScoreNote, formatScoringLine, maturityRingAriaLabel } from '@/lib/report/provenance';
import { BAND_MINIMUMS } from '@/lib/report/maturityBands';
import { VERDICT_WITHHELD_LABEL } from '@/data/constants';
import type { PracticeCoverage } from '@/types/domain';

interface ReportSummaryProps {
  /** Assessed MATURITY -- a weighted-average percentage, not a combined
   * "readiness" score. See `types/domain.ts#ReportData.overallScore`. */
  overallScore: number;
  overallLevel: string;
  /** Checklist coverage summed across every completed stage's areas --
   * the second, independent reading from `EvidenceScore`/`ReportData`.
   * Rendered as a plain count beside the maturity ring, never as a
   * percentage and never with a level colour: a coverage count carries no
   * band (Task 5/5b's identical rule for `AreaCard`/`PrincipleScorecard`).
   * `null` means no practices question exists anywhere in the completed
   * stages, and renders as `No practices assessed`, never `0` or `0 of 0`. */
  overallPractices: PracticeCoverage | null;
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
  /** ENG-03 prerequisite: `reportData.scoringVersion`. Undefined for any
   * assessment completed before methodology versioning existed, which the
   * rendered line states rather than hides. */
  scoringVersion?: string;
  /** O-14, completed half: `isFrameworkDrifted(assessment.status,
   * resolution.matches)`, computed by the caller (this component has
   * neither piece of information on its own). */
  frameworkDrifted: boolean;
  /**
   * `lib/report/maturityBands.ts#labelIsShowable`, computed ONCE by the
   * report page (beside `overallLevel`) and passed down as a plain
   * boolean -- a SEPARATE prop from `scoringVersion` above, which this
   * component still renders unconditionally via `formatScoringLine`
   * (knowing which methodology scored a report is useful whether or not
   * its bands can be labelled). maturity-band-reanchor Task 7: false
   * means the ring must still show `overallScore`, but never a band word
   * or a band colour derived from `overallLevel`.
   */
  labelIsShowable: boolean;
}

/**
 * Renders the executive summary section with the overall maturity ring,
 * the practice-coverage count beside it (Task 6 -- see `overallPractices`'s
 * own doc comment for why this is a separate, unbanded count rather than a
 * second percentage), key stats (strengths, attentions, gaps, cross-stage
 * effects), and the report's provenance line (O-15) -- which framework
 * version this assessment was answered against, and when it was pinned. When the
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
  overallPractices,
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
  scoringVersion,
  frameworkDrifted,
  labelIsShowable,
}: ReportSummaryProps) {
  const ringLabel = labelIsShowable ? levelLabels[overallLevel] : VERDICT_WITHHELD_LABEL;
  const ringColor = labelIsShowable ? levelColors[overallLevel] : 'var(--color-verdict-withheld)';
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
      <p className="report-provenance report-provenance--scoring" id="report-scoring-version">
        {formatScoringLine(scoringVersion)}
      </p>
      <p className="report-provenance" id="report-provenance">
        {formatProvenanceLine({
          semver: frameworkSemver,
          pinnedDate: frameworkPinnedDate,
          contentHash: frameworkContentHash,
        })}
      </p>
      <div className="report-summary__grid">
        <div className="report-summary__overall">
          <div className="score-ring" style={{ '--score-color': ringColor } as React.CSSProperties} role="img" aria-label={maturityRingAriaLabel(overallScore, ringLabel)}>
            <span className="score-ring__value">{overallScore}%</span>
            <span className="score-ring__label">{ringLabel}</span>
          </div>
          <p className="report-summary__provisional" role="note">
            {provisionalScoreNote()}
          </p>
          {/*
            Task 6: the second independent reading, stated as a count
            beside the maturity ring -- no percentage, no level colour (a
            coverage count carries no band, the same rule Task 5/5b already
            apply to AreaCard/PrincipleScorecard). Wording is the SAME copy
            those two components render for the identical concept: "N of M
            practices in place" / "No practices assessed", never "0" or
            "0 of 0" when nothing was ticked.
          */}
          <div className="report-summary__practices">
            <span className="report-summary__practices-label">Practices</span>
            {overallPractices !== null ? (
              <span className="report-summary__practices-value">
                {`${overallPractices.inPlace} of ${overallPractices.total} practices in place`}
              </span>
            ) : (
              <span className="report-summary__practices-value report-summary__practices-value--muted">No practices assessed</span>
            )}
          </div>
          <p className="report-summary__desc">
            {/*
              Was "Overall readiness across N completed stages" -- accurate
              when overallScore was the report's one combined figure, false
              by implication now that it is one of two independent
              readings (see maturityRingAriaLabel's comment). "Assessed
              maturity" names the SAME reading the ring's aria-label now
              names, rather than a re-worded claim of completeness.
            */}
            Assessed maturity across {completedStagesCount} completed stage{completedStagesCount > 1 ? 's' : ''}.
            {/*
              Coordinator fix round 2 (Task 7). These three sentences are a
              BAND VERDICT in prose -- the same fact the ring word/colour
              above already gate on `labelIsShowable` -- and were left
              ungated: the spec's own §3.2 filed this line range under the
              "ladder definitions" table only, never the "surfaces D5/D9
              must reach" table, so it received the boundary fix and never
              the withholding fix. Live on the dev database: 26 of 139
              completed reports (all scored under the superseded 5.0.0
              methodology) rendered "Verdict withheld" on the ring directly
              above "You're in good shape" in this very paragraph. Gated as
              one group, not per-line: it is one verdict, not three
              independent claims, and the leading coverage sentence above
              stays unconditional -- that one is a fact about how many
              stages were completed, not a verdict about how well.
            */}
            {labelIsShowable && (
              <>
                {overallScore < BAND_MINIMUMS.developing && ' There are gaps that need fixing.'}
                {overallScore >= BAND_MINIMUMS.developing && overallScore < BAND_MINIMUMS.strong && ' Solid start, but some areas still need work.'}
                {overallScore >= BAND_MINIMUMS.strong && ' You\'re in good shape. Keep it up as your system evolves.'}
              </>
            )}
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
