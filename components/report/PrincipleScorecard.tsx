'use client';

import { levelLabels, levelColors, VERDICT_WITHHELD_LABEL } from '@/data/constants';
import type { PracticeCoverage } from '@/types/domain';

interface PrincipleData {
  name: string;
  pct: number | null;
  level: string;
  practices: PracticeCoverage | null;
  /**
   * How many maturity questions this percentage is the mean of.
   *
   * Content-audit item 17: the eight principles are shown side by side, which
   * implies they are comparable, and they are not. Measured 2026-08-31,
   * Fairness rests on 22 questions and Sustainability on 2; four stage x
   * principle cells hold exactly one, where a five-point scale can only ever
   * produce five distinct percentages. Disclosing the count leaves the reading
   * intact and removes the false equivalence -- the same move as the withheld
   * band label below: show the measurement, withhold the unearned confidence.
   *
   * Optional so that callers which have not been threaded through yet render
   * exactly as before rather than showing a wrong number.
   */
  basis?: number;
}

interface PrincipleScorecardProps {
  principle: PrincipleData;
  /**
   * `lib/report/maturityBands.ts#labelIsShowable`, computed ONCE by the
   * report page (beside `overallLevel`) and threaded down as a plain
   * boolean -- never recomputed here. maturity-band-reanchor Task 7: a
   * report scored under a superseded methodology may still show its raw
   * percentage, but never a band word or a band colour derived from
   * `level` (a green dot beside a superseded number asserts exactly what
   * "Strong" asserts). See that module's own doc comment.
   */
  labelIsShowable: boolean;
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
 *
 * Fix round 1 (Task 6 review, Finding 1): the maturity reading now carries
 * the same "Assessed maturity" label `AreaCard.tsx` renders above its own
 * percentage -- this card was the one surface of the three that left the
 * number unlabelled. The label exists because area/principle tiers and
 * maturity are independent derivations (a "gap"/weak badge can legitimately
 * sit beside a strong percentage), and the label is what tells a reader the
 * number is a measurement, not a second verdict. Structure mirrors
 * `AreaCard`'s `.gap-card__reading`/`.gap-card__reading-label` (label
 * above value, same font-size/colour/letter-spacing), scoped under this
 * file's own `scorecard-card__` class prefix rather than importing
 * `gap-card__*` classes across files.
 */
export function PrincipleScorecard({ principle, labelIsShowable }: PrincipleScorecardProps) {
  const { name, pct, level, practices, basis } = principle;
  const badgeText = labelIsShowable ? levelLabels[level] : VERDICT_WITHHELD_LABEL;
  const bandColor = labelIsShowable ? levelColors[level] : 'var(--color-verdict-withheld)';
  return (
    <div className="scorecard-card card">
      <div className="scorecard-card__header">
        <h4>{name}</h4>
        <span
          className={labelIsShowable ? `badge badge--${level}` : 'badge'}
          style={labelIsShowable ? undefined : { color: 'var(--color-verdict-withheld)' }}
        >
          {badgeText}
        </span>
      </div>
      <div className="scorecard-card__score">
        <div className="scorecard-card__reading">
          <span className="scorecard-card__reading-label">Assessed maturity</span>
          {pct !== null ? (
            <span className="scorecard-card__pct" style={{ color: bandColor }}>{pct}%</span>
          ) : (
            <span className="scorecard-card__pct scorecard-card__pct--muted">No maturity questions</span>
          )}
        </div>
        {/* Only alongside a real percentage. When pct is null the card already
            says "No maturity questions", and "0 maturity questions" beside it
            would be the same fact twice, in two wordings. */}
        {pct !== null && typeof basis === 'number' && basis > 0 && (
          <div className="scorecard-card__basis">
            from {basis} maturity question{basis === 1 ? '' : 's'}
          </div>
        )}
        {pct !== null && (
          <div className="progress-bar">
            <div className="progress-bar__fill" style={{ width: `${pct}%`, backgroundColor: bandColor }}></div>
          </div>
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
