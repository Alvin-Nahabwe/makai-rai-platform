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
import {
  axisSensitivityByPrinciple, worstSensitivity, thinAxes,
} from '@/lib/report/axisSensitivity';
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
  const sensitivityPerAssessment: Array<Record<string, number | undefined>> = [];

  for (const a of assessments) {
    const ps = a.reportData?.principleScores;
    if (!ps || Object.keys(ps).length === 0) continue;
    const scores = aggregatePrincipleScores(ps);
    sensitivityPerAssessment.push(axisSensitivityByPrinciple(ps));
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
   * to render a "gap" at one vertex of an otherwise-plotted polygon.
   *
   * Final whole-branch review, Important 2: an earlier version of this
   * comment claimed the gap was "not reachable today" because 0 of 19
   * shipped stage x principle cells lack a maturity-bearing question within
   * a SINGLE assessment. That is true, and irrelevant here -- `principles`
   * above is the UNION across every COMPARED assessment, not one
   * assessment's own cells. A principle a 3-stage assessment covers but a
   * 1-stage assessment never reached is legitimately absent from the
   * shorter assessment's own `scores` map, `a.scores[principle]` is
   * `undefined`, and the line below turns that into a real `null` that
   * Recharts then draws at radius 0 -- collapsed to the chart's centre,
   * indistinguishable at a glance from "assessed and scored 0%". This is
   * reachable with real, unremarkable content (any two assessments of
   * different stage-completeness), not a hypothetical.
   *
   * Mitigation shipped: rather than silently accept the misreading, the
   * caption rendered below the chart (`missingByAssessment`) names, per
   * assessment, exactly which principles it never assessed -- turning the
   * geometry's "0%" shape into a labelled "not assessed" for any reader who
   * looks past the polygon itself. The geometry limitation remains (there is
   * no Recharts-level fix), but the page no longer states or implies the gap
   * cannot occur.
   */
  const data = principles.map((principle) => {
    const entry: Record<string, string | number | null> = { principle };
    perAssessment.forEach((a, i) => {
      entry[`a${i}`] = a.scores[principle] ?? null;
    });
    return entry;
  });

  // Per assessment, which union principles it never assessed at all --
  // `a.scores[principle] === undefined` means no stage of THIS assessment
  // ever produced a principleScores entry for it (as opposed to producing
  // one with a null maturity reading, which today's content never does; see
  // the comment above `data`). Rendered as a caption beneath the chart so a
  // polygon vertex collapsed to the centre reads as "not assessed", not as
  // "scored 0%".
  const missingByAssessment = perAssessment.map(
    (a) => principles.filter((p) => a.scores[p] === undefined),
  );

  // Content-audit item 17. The polygon cannot say that two axes rest on very
  // different amounts of evidence -- every vertex is drawn the same way. This
  // file's established answer to "the geometry cannot say this honestly" is a
  // caption (see `missingByAssessment` above), not a new visual encoding the
  // reader has to decode.
  const sensitivity = worstSensitivity(sensitivityPerAssessment);
  const thin = thinAxes(sensitivity);

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
      {thin.length > 0 && (
        <div className="radar-chart__caveat" style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
          <p style={{ margin: '2px 0' }}>
            Drawn as equal axes, but not equally measured — one answer moves{' '}
            {thin.map((p, i) => (
              <span key={p}>
                {i > 0 && (i === thin.length - 1 ? ' and ' : ', ')}
                {p} by {sensitivity[p]!.toFixed(1)} points
              </span>
            ))}
            . Each rests on very few questions in at least one stage, so{' '}
            {thin.length === 1 ? 'its position is' : 'their positions are'} less
            settled than the rest — a weaker signal, not a smaller score.
          </p>
        </div>
      )}
      {missingByAssessment.some((m) => m.length > 0) && (
        <div className="radar-chart__caveat" style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
          {perAssessment.map((a, i) => missingByAssessment[i].length > 0 && (
            <p key={i} style={{ margin: '2px 0' }}>
              {a.label} did not assess: {missingByAssessment[i].join(', ')}.
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// Named export above is what the unit test imports directly (components in
// this directory are hook-free and are called as plain functions, D-169);
// default export kept so existing default-import call sites (e.g. the
// compare page) keep working untouched.
export default RadarChart;
