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
    // The gauge is a navigational summary, so it carries the qualification in
    // its label and tooltip rather than as body copy: a card in a list has no
    // room for the full sentence, but a bare number still presents a score
    // whose weighting has no published derivation as though it were measured.
    // The full note lives on the report itself (lib/report/provenance.ts).
    //
    // Final whole-branch review, F4: this used to say "Provisional overall
    // score". Since the practices/maturity split, the column this gauge
    // reads (`overallScore`) holds ONLY the assessed-maturity reading, not a
    // combined score -- the report and PDF both call it "Assessed maturity"
    // (lib/report/provenance.ts). "Overall score" implied a single figure
    // that no longer exists; relabelled to match.
    <div
      className="score-gauge"
      style={{ width: size, height: size, position: 'relative' }}
      role="img"
      aria-label={`Provisional assessed maturity: ${clamped} out of 100. The weighting behind this number has no published derivation yet; see the report for per-area findings.`}
      title="Provisional assessed maturity — see the report for per-area findings"
    >
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
