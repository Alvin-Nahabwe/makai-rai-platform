'use client';

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

interface AssessmentData {
  id: string;
  version: number;
  overallScore: number | null;
  completedAt: string | Date | null;
}

interface TrendChartProps {
  assessments: AssessmentData[];
}

const BRAND_COLOR = '#C06014';

export default function TrendChart({ assessments }: TrendChartProps) {
  // Filter to assessments with scores and sort by completion date
  const scored = assessments
    .filter((a) => a.overallScore !== null && a.completedAt !== null)
    .sort(
      (a, b) =>
        new Date(a.completedAt!).getTime() - new Date(b.completedAt!).getTime(),
    );

  if (scored.length === 0) return null;

  const data = scored.map((a) => ({
    name: new Date(a.completedAt!).toLocaleDateString(),
    score: a.overallScore!,
    version: `v${a.version}`,
  }));

  return (
    <div className="chart-container" style={{ width: '100%', height: 300 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 8, right: 24, left: 8, bottom: 8 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 11, fill: '#6B7280' }}
            tickLine={false}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 11, fill: '#6B7280' }}
            tickLine={false}
            width={36}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1A1F36',
              border: 'none',
              borderRadius: 8,
              color: '#F3F4F6',
              fontSize: 12,
            }}
            labelStyle={{ color: '#9CA3AF' }}
            formatter={(value, _name, props) => [
              `${value}%`,
              (props as any).payload?.version ?? '',
            ]}
          />
          <ReferenceLine
            y={80}
            stroke="#059669"
            strokeDasharray="4 4"
            label={{ value: 'Target', fill: '#059669', fontSize: 10 }}
          />
          <Line
            type="monotone"
            dataKey="score"
            stroke={BRAND_COLOR}
            strokeWidth={2.5}
            dot={{ r: 5, fill: BRAND_COLOR, stroke: '#fff', strokeWidth: 2 }}
            activeDot={{ r: 7 }}
            name="Overall Score"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
