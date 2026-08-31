import type { EvidenceScore } from '@/types/domain';

/**
 * How far one answer can move a radar axis before the axis is called thin.
 *
 * Content-audit item 17. The radar draws eight principles as identical axes,
 * but they are not equally resourced: measured on shipped content, Fairness &
 * Non-discrimination's score is a mean over 18 maturity questions and
 * Sustainability's over 2. Side by side they read as equally solid.
 *
 * The scorecard discloses the question COUNT, which is right there because the
 * scorecard is already per-stage. It is the WRONG quantity for the radar,
 * which plots a mean of per-stage scores: an axis's volatility is set by its
 * thinnest stage, not its total. Safety & Security has 9 questions but rests
 * on ONE in pre-processing, so a single answer moves its plotted position 8.3
 * points -- more than Awareness & Literacy, which has 3 questions in total. A
 * count-based threshold flags Awareness and clears Safety, which is backwards.
 *
 * 8 points is the chosen line: above it, one person changing one answer by one
 * step visibly relocates the axis, which is the property that makes comparing
 * axes misleading.
 */
export const SENSITIVITY_THRESHOLD_POINTS = 8;

/** One likert-5 step is a quarter of the range: 25 points of a stage's score. */
const POINTS_PER_STEP = 25;

/**
 * Worst-case points one answer can move each principle's plotted value.
 *
 * `undefined` where it cannot be known -- never a fabricated number. Every
 * assessment completed before `basisCount` shipped stores readings without it,
 * and a guessed sensitivity would flag or clear an axis on evidence that does
 * not exist.
 */
export function axisSensitivityByPrinciple(
  principleScores: Record<string, Record<string, EvidenceScore>>,
): Record<string, number | undefined> {
  const perPrinciple: Record<string, { bases: number[]; incomplete: boolean }> = {};

  for (const stageScores of Object.values(principleScores)) {
    for (const [principle, score] of Object.entries(stageScores)) {
      const entry = (perPrinciple[principle] ??= { bases: [], incomplete: false });
      // A stage with no reading is absent from the mean (meanMaturity excludes
      // nulls), so it must not enlarge the divisor either -- counting it would
      // understate how far one answer can move the axis.
      if (score.maturity === null) continue;
      if (typeof score.basisCount !== 'number' || score.basisCount <= 0) {
        entry.incomplete = true;
        continue;
      }
      entry.bases.push(score.basisCount);
    }
  }

  const out: Record<string, number | undefined> = {};
  for (const [principle, { bases, incomplete }] of Object.entries(perPrinciple)) {
    // Partial data is unknown data: a sensitivity computed from the stages
    // that happen to carry the field would be a confident number from half a
    // picture.
    out[principle] = incomplete || bases.length === 0
      ? undefined
      : POINTS_PER_STEP / (bases.length * Math.min(...bases));
  }
  return out;
}

/**
 * The principles whose axes are too volatile to read as equal, worst first so
 * the caption leads with the axis least worth trusting.
 */
export function thinAxes(sensitivity: Record<string, number | undefined>): string[] {
  return Object.entries(sensitivity)
    .filter((e): e is [string, number] =>
      typeof e[1] === 'number' && e[1] > SENSITIVITY_THRESHOLD_POINTS)
    .sort((a, b) => b[1] - a[1])
    .map(([principle]) => principle);
}

/**
 * Folds the assessments the radar compares into one reading per axis, keeping
 * the WORST.
 *
 * Not last-write-wins, which is what a plain `Object.assign` of per-assessment
 * maps would do -- the same defect RadarChart.tsx already documents for its
 * score aggregation. The values genuinely differ between assessments: the
 * basis is response-dependent, because six `*-EXTRA-*` questions carry a
 * `crossStageCondition` and unlock only when an earlier stage was answered
 * weakly. An organisation that scores badly is therefore measured over MORE
 * questions, on the identical framework version.
 *
 * The caption warns that an axis is not solid enough to compare, so the least
 * solid assessment on the chart governs. A known value always beats an unknown
 * one: an assessment stored before `basisCount` existed says nothing about the
 * axis, and nothing is not the same as steady.
 */
export function worstSensitivity(
  perAssessment: Array<Record<string, number | undefined>>,
): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  for (const one of perAssessment) {
    for (const [principle, value] of Object.entries(one)) {
      if (!(principle in out)) out[principle] = value;
      else if (typeof value === 'number') {
        const existing = out[principle];
        out[principle] = typeof existing === 'number' ? Math.max(existing, value) : value;
      }
    }
  }
  return out;
}
