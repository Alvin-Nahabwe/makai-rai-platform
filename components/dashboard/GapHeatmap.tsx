'use client';

interface AssessmentData {
  id: string;
  version: number;
  completedAt: string | Date | null;
  reportData: {
    stageScores?: Record<string, Record<string, number>>;
    [key: string]: unknown;
  } | null;
}

interface GapHeatmapProps {
  assessments: AssessmentData[];
}

/** Classify a 0-100 score into a level for cell coloring. */
function scoreLevel(score: number): 'green' | 'amber' | 'red' {
  if (score >= 70) return 'green';
  if (score >= 40) return 'amber';
  return 'red';
}

const LEVEL_STYLES: Record<string, React.CSSProperties> = {
  green: { backgroundColor: '#D1FAE5', color: '#065F46', fontWeight: 600 },
  amber: { backgroundColor: '#FEF3C7', color: '#92400E', fontWeight: 600 },
  red: { backgroundColor: '#FEE2E2', color: '#991B1B', fontWeight: 600 },
  empty: { backgroundColor: '#F9FAFB', color: '#9CA3AF' },
};

/**
 * Flatten per-stage area scores into a single map of areaId -> score (averaged).
 * stageScores shape: { stageName: { areaId: 0-100 } }
 */
function flattenAreaScores(
  stageScores: Record<string, Record<string, number>>,
): Record<string, number> {
  const sums: Record<string, { total: number; count: number }> = {};
  for (const areaScores of Object.values(stageScores)) {
    for (const [areaId, score] of Object.entries(areaScores)) {
      if (!sums[areaId]) sums[areaId] = { total: 0, count: 0 };
      sums[areaId].total += score;
      sums[areaId].count += 1;
    }
  }
  const result: Record<string, number> = {};
  for (const [areaId, { total, count }] of Object.entries(sums)) {
    result[areaId] = Math.round(total / count);
  }
  return result;
}

/** Format an area ID into a human-readable label. */
function formatAreaLabel(areaId: string): string {
  return areaId
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function GapHeatmap({ assessments }: GapHeatmapProps) {
  // Filter to assessments with stageScores
  const valid = assessments.filter(
    (a) => a.reportData?.stageScores && Object.keys(a.reportData.stageScores).length > 0,
  );
  if (valid.length === 0) return null;

  // Flatten all assessments' area scores
  const perAssessment = valid.map((a) => ({
    label: a.completedAt
      ? `v${a.version} (${new Date(a.completedAt).toLocaleDateString()})`
      : `v${a.version}`,
    scores: flattenAreaScores(a.reportData!.stageScores!),
  }));

  // Collect all unique area IDs
  const allAreas = new Set<string>();
  perAssessment.forEach((a) =>
    Object.keys(a.scores).forEach((id) => allAreas.add(id)),
  );
  const areas = Array.from(allAreas).sort();

  if (areas.length === 0) return null;

  return (
    <div className="heatmap-container" style={{ overflowX: 'auto' }}>
      <table
        style={{
          width: '100%',
          borderCollapse: 'separate',
          borderSpacing: 0,
          fontSize: 13,
        }}
      >
        <thead>
          <tr>
            <th
              style={{
                textAlign: 'left',
                padding: '10px 12px',
                backgroundColor: '#F9FAFB',
                borderBottom: '2px solid #E5E7EB',
                position: 'sticky',
                left: 0,
                zIndex: 1,
                minWidth: 180,
                fontSize: 12,
                color: '#6B7280',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Assessment Area
            </th>
            {perAssessment.map((a, i) => (
              <th
                key={i}
                style={{
                  textAlign: 'center',
                  padding: '10px 12px',
                  backgroundColor: '#F9FAFB',
                  borderBottom: '2px solid #E5E7EB',
                  fontSize: 12,
                  color: '#6B7280',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                {a.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {areas.map((areaId, rowIdx) => (
            <tr key={areaId}>
              <td
                style={{
                  padding: '8px 12px',
                  borderBottom: '1px solid #E5E7EB',
                  position: 'sticky',
                  left: 0,
                  backgroundColor: rowIdx % 2 === 0 ? '#fff' : '#FAFAFA',
                  fontWeight: 500,
                  color: '#374151',
                  zIndex: 1,
                }}
              >
                {formatAreaLabel(areaId)}
              </td>
              {perAssessment.map((a, colIdx) => {
                const score = a.scores[areaId];
                const hasScore = score !== undefined;
                const level = hasScore ? scoreLevel(score) : 'empty';
                return (
                  <td
                    key={colIdx}
                    style={{
                      textAlign: 'center',
                      padding: '8px 12px',
                      borderBottom: '1px solid #E5E7EB',
                      borderRadius: 4,
                      ...LEVEL_STYLES[level],
                    }}
                    title={hasScore ? `${areaId}: ${score}%` : 'N/A'}
                  >
                    {hasScore ? `${score}%` : '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Legend */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          marginTop: 12,
          fontSize: 12,
          color: '#6B7280',
        }}
      >
        <span>
          <span
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 2,
              backgroundColor: '#D1FAE5',
              marginRight: 4,
              verticalAlign: 'middle',
            }}
          />
          ≥ 70 (Good)
        </span>
        <span>
          <span
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 2,
              backgroundColor: '#FEF3C7',
              marginRight: 4,
              verticalAlign: 'middle',
            }}
          />
          40–69 (Needs Attention)
        </span>
        <span>
          <span
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 2,
              backgroundColor: '#FEE2E2',
              marginRight: 4,
              verticalAlign: 'middle',
            }}
          />
          &lt; 40 (Gap)
        </span>
      </div>
    </div>
  );
}
