'use client';

import { PieChart, Pie, Cell } from 'recharts';

interface ScoreGaugeProps {
  score: number;
  size?: number;
}

const BRAND_COLOR = '#C06014';
const EMPTY_COLOR = '#E5E7EB';

export default function ScoreGauge({ score, size = 80 }: ScoreGaugeProps) {
  const clamped = Math.max(0, Math.min(100, score));
  const data = [
    { name: 'score', value: clamped },
    { name: 'remainder', value: 100 - clamped },
  ];

  const outerRadius = size / 2;
  const innerRadius = outerRadius * 0.7;

  return (
    <div className="score-gauge" style={{ width: size, height: size, position: 'relative' }}>
      <PieChart width={size} height={size}>
        <Pie
          data={data}
          cx={size / 2 - 1}
          cy={size / 2 - 1}
          innerRadius={innerRadius}
          outerRadius={outerRadius}
          startAngle={90}
          endAngle={-270}
          dataKey="value"
          stroke="none"
          animationDuration={800}
          animationBegin={100}
        >
          <Cell fill={BRAND_COLOR} />
          <Cell fill={EMPTY_COLOR} />
        </Pie>
      </PieChart>
      <span
        className="score-gauge__label"
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: size * 0.22,
          fontWeight: 700,
          color: '#1A1F36',
          pointerEvents: 'none',
        }}
      >
        {clamped}
      </span>
    </div>
  );
}
