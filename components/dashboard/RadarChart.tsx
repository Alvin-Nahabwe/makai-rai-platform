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

interface AssessmentData {
  id: string;
  version: number;
  completedAt: string | Date | null;
  reportData: {
    principleScores?: Record<string, Record<string, number>>;
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
 * Aggregate per-stage principle scores into a single mean per principle.
 * principleScores shape: { stageName: { principleName: 0-100 } }
 */
function aggregatePrincipleScores(
  principleScores: Record<string, Record<string, number>>,
): Record<string, number> {
  const sums: Record<string, { total: number; count: number }> = {};
  for (const stageScores of Object.values(principleScores)) {
    for (const [principle, score] of Object.entries(stageScores)) {
      if (!sums[principle]) sums[principle] = { total: 0, count: 0 };
      sums[principle].total += score;
      sums[principle].count += 1;
    }
  }
  const result: Record<string, number> = {};
  for (const [principle, { total, count }] of Object.entries(sums)) {
    result[principle] = Math.round(total / count);
  }
  return result;
}

export default function RadarChart({ assessments }: RadarChartProps) {
  if (assessments.length === 0) return null;

  // Collect all unique principle names across all assessments
  const allPrinciples = new Set<string>();
  const perAssessment: { label: string; scores: Record<string, number> }[] = [];

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

  // Build data array for Recharts: one entry per principle
  const data = principles.map((principle) => {
    const entry: Record<string, string | number> = { principle };
    perAssessment.forEach((a, i) => {
      entry[`a${i}`] = a.scores[principle] ?? 0;
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
