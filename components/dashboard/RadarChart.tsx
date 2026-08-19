'use client';

import {
  RadarChart as RechartsRadar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  ResponsiveContainer,
  Legend,
  Tooltip,
} from 'recharts';

import type { EvidenceScore } from '@/types/domain';
import { meanMaturity } from '@/lib/engine/AssessmentEngine.js';

interface AssessmentData {
  id: string;
  version: number;
  completedAt: string | Date | null;
  reportData: {
    /**
     * Owner's ruling (Task 8 brief): this widget plots the MATURITY reading
     * only. `EvidenceScore` carries both readings; only `.maturity` is read
     * below.
     *
     * This local type used to be `Record<string, Record<string, number>>`,
     * predating the engine's EvidenceScore split. `tsc` did not flag the
     * mismatch because this type is never imported from the engine -- it was
     * silently reading the whole `EvidenceScore` object where a number was
     * expected, i.e. `[object Object]`.
     */
    principleScores?: Record<string, Record<string, EvidenceScore>>;
    [key: string]: unknown;
  } | null;
}

interface RadarChartProps {
  assessments: AssessmentData[];
}

const COLORS = [
  '#C06014', // brand
  '#2563EB', // blue
  '#059669', // green
  '#7C3AED', // purple
  '#DB2777', // pink
  '#D97706', // amber
  '#0891B2', // cyan
  '#4F46E5', // indigo
];

/**
 * Aggregate per-stage principle scores into a single mean maturity per
 * principle. principleScores shape: { stageName: { principleName:
 * EvidenceScore } }.
 *
 * Unlike GapHeatmap's areas, principles RECUR across stages (measured: 7 of
 * 8) -- a principle like "Fairness & Non-discrimination" gets its own
 * EvidenceScore in most stages that assess it. Every stage's occurrence for
 * a principle is pushed onto that principle's own list below, so a later
 * stage's reading is combined with an earlier one, never overwrites it. A
 * flat `sums[principle] = ...` keyed only by name (the shape this replaced)
 * is exactly the trap Task 2 hit: it looks correct because JS objects merge
 * silently, and only 1 of 8 principles (the one that happens to appear in
 * just a single stage) would have exposed the bug by accident.
 *
 * Delegates the "average, excluding null maturity" rule to `meanMaturity`
 * (lib/engine/AssessmentEngine.js) rather than re-deriving it here -- same
 * function GapHeatmap reuses, see its doc comment for why null must be
 * excluded, not zeroed. Returns `null` for a principle with no maturity
 * reading anywhere, which the caller must not coerce to a plotted 0.
 */
function aggregatePrincipleScores(
  principleScores: Record<string, Record<string, EvidenceScore>>,
): Record<string, number | null> {
  const byPrinciple: Record<string, Record<string, EvidenceScore>[]> = {};
  for (const stageScores of Object.values(principleScores)) {
    for (const [principle, score] of Object.entries(stageScores)) {
      (byPrinciple[principle] ??= []).push({ [principle]: score });
    }
  }
  const result: Record<string, number | null> = {};
  for (const [principle, maps] of Object.entries(byPrinciple)) {
    result[principle] = meanMaturity(maps);
  }
  return result;
}

export function RadarChart({ assessments }: RadarChartProps) {
  if (assessments.length === 0) return null;

  // Collect all unique principle names across all assessments
  const allPrinciples = new Set<string>();
  const perAssessment: { label: string; scores: Record<string, number | null> }[] = [];

  for (const a of assessments) {
    const ps = a.reportData?.principleScores;
    if (!ps || Object.keys(ps).length === 0) continue;
    const scores = aggregatePrincipleScores(ps);
    Object.keys(scores).forEach((p) => allPrinciples.add(p));
    const date = a.completedAt
      ? new Date(a.completedAt).toLocaleDateString()
      : `v${a.version}`;
    perAssessment.push({ label: `Assessment ${a.version} (${date})`, scores });
  }

  if (allPrinciples.size === 0) return null;

  const principles = Array.from(allPrinciples).sort();

  /*
   * Build data array for Recharts: one entry per principle. `?? null`, not
   * `?? 0` -- the trap this widget shipped with: coercing "no reading" to a
   * literal 0 would claim "assessed and terrible" for a principle that was
   * never asked. `null` is preserved distinctly for any tooltip/legend
   * consumer of this data (and the underlying value is honest either way).
   *
   * One caveat, documented rather than silently accepted: Recharts' own
   * <Radar> geometry maps a null/undefined value to radius 0 regardless
   * (see node_modules/recharts/es6/polar/Radar.js: `computeRadarPoints`'s
   * `radius = isNullish(pointValue) ? 0 : ...`) -- there is no upstream way
   * to render a "gap" at one vertex of an otherwise-plotted polygon. That
   * limitation is not reachable today: 0 of 19 shipped stage x principle
   * cells lack a maturity-bearing question (see meanMaturity's doc comment
   * in AssessmentEngine.js), so no principle a real assessment reports here
   * is ever actually null. This fix keeps the DATA honest for when that
   * stops being true, rather than pretending the rendering gap is solved.
   */
  const data = principles.map((principle) => {
    const entry: Record<string, string | number | null> = { principle };
    perAssessment.forEach((a, i) => {
      entry[`a${i}`] = a.scores[principle] ?? null;
    });
    return entry;
  });

  return (
    <div className="chart-container" style={{ width: '100%', height: 400 }}>
      <ResponsiveContainer width="100%" height="100%">
        <RechartsRadar data={data} cx="50%" cy="50%" outerRadius="80%">
          <PolarGrid stroke="#E5E7EB" />
          <PolarAngleAxis
            dataKey="principle"
            tick={{ fontSize: 11, fill: '#6B7280' }}
          />
          <PolarRadiusAxis
            angle={30}
            domain={[0, 100]}
            tick={{ fontSize: 10, fill: '#9CA3AF' }}
          />
          {perAssessment.map((a, i) => (
            <Radar
              key={i}
              name={a.label}
              dataKey={`a${i}`}
              stroke={COLORS[i % COLORS.length]}
              fill={COLORS[i % COLORS.length]}
              fillOpacity={0.15}
              strokeWidth={2}
            />
          ))}
          <Tooltip
            contentStyle={{
              backgroundColor: '#1A1F36',
              border: 'none',
              borderRadius: 8,
              color: '#F3F4F6',
              fontSize: 12,
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, paddingTop: 16 }}
          />
        </RechartsRadar>
      </ResponsiveContainer>
    </div>
  );
}

// Named export above is what the unit test imports directly (components in
// this directory are hook-free and are called as plain functions, D-169);
// default export kept so existing default-import call sites (e.g. the
// compare page) keep working untouched.
export default RadarChart;
