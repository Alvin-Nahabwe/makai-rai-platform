'use client';

import type { EvidenceScore } from '@/types/domain';
import { meanMaturity } from '@/lib/engine/AssessmentEngine.js';
import { getLevel, levelRange } from '@/lib/report/maturityBands';
import { levelLabels } from '@/data/constants';

interface AssessmentData {
  id: string;
  version: number;
  completedAt: string | Date | null;
  reportData: {
    /**
     * Owner's ruling (Task 8 brief): this widget plots the MATURITY reading
     * only -- it covers all 21 areas and is comparable across projects,
     * unlike practices coverage whose totals differ per area. `EvidenceScore`
     * carries both readings; only `.maturity` is read below.
     *
     * This local type used to be `Record<string, Record<string, number>>`,
     * predating the engine's EvidenceScore split. `tsc` did not flag the
     * mismatch because this type is never imported from the engine -- it was
     * silently reading the whole `EvidenceScore` object where a number was
     * expected, i.e. `[object Object]`.
     */
    stageScores?: Record<string, Record<string, EvidenceScore>>;
    [key: string]: unknown;
  } | null;
}

interface GapHeatmapProps {
  assessments: AssessmentData[];
}

/**
 * D-219 (maturity-band-reanchor Task 5): this used to be a third,
 * independent ladder (70/40), classifying the same assessed-maturity number
 * the report (75/50/25) and project pages (80/60/40) each classified
 * differently -- `lib/report/maturityBands.ts#getLevel` is now the one
 * ladder everywhere. `scoreLevel` deleted; cells key `LEVEL_STYLES` on
 * `getLevel`'s own keys below.
 *
 * NO COLOURS ARE EXPORTED from `maturityBands.ts` -- see that module's doc
 * comment. `LEVEL_STYLES` is this component's own background/foreground
 * PAIR authoring, a third colour mechanism alongside `levelColors` (hex,
 * data/constants.ts) and the report pages' `--color-risk-*` custom
 * properties, none of which are interchangeable with a table cell that needs
 * both a background AND a legible foreground. Four bands need four pairs,
 * not the three this widget shipped with -- `strong`'s pair is new here.
 */
const LEVEL_STYLES: Record<string, React.CSSProperties> = {
  strong: { backgroundColor: '#D1FAE5', color: '#065F46', fontWeight: 600 },
  developing: { backgroundColor: '#FEF9C3', color: '#854D0E', fontWeight: 600 },
  needsWork: { backgroundColor: '#FFEDD5', color: '#9A3412', fontWeight: 600 },
  critical: { backgroundColor: '#FEE2E2', color: '#991B1B', fontWeight: 600 },
  empty: { backgroundColor: '#F9FAFB', color: '#9CA3AF' },
};

/**
 * Flatten per-stage area scores into a single map of areaId -> maturity.
 * stageScores shape: { stageName: { areaId: EvidenceScore } }.
 *
 * Area ids are globally unique across stages (21 areas, 21 distinct ids,
 * verified) so, unlike RadarChart's principle aggregation below, an area
 * never actually needs combining across more than one stage's map -- but it
 * is grouped the same way regardless, so a future area that DID recur would
 * be combined rather than have one stage's reading silently overwrite
 * another's (the trap RadarChart's principle merge hit in Task 2).
 *
 * Delegates the "average, excluding null maturity" rule to `meanMaturity`
 * (lib/engine/AssessmentEngine.js) rather than re-deriving it here -- see
 * that function's doc comment for why null must be excluded, not zeroed.
 * Returns `null` for an area with no maturity reading anywhere, which the
 * caller renders as an empty cell, never as 0%.
 */
function flattenAreaScores(
  stageScores: Record<string, Record<string, EvidenceScore>>,
): Record<string, number | null> {
  const byArea: Record<string, Record<string, EvidenceScore>[]> = {};
  for (const areaScores of Object.values(stageScores)) {
    for (const [areaId, score] of Object.entries(areaScores)) {
      (byArea[areaId] ??= []).push({ [areaId]: score });
    }
  }
  const result: Record<string, number | null> = {};
  for (const [areaId, maps] of Object.entries(byArea)) {
    result[areaId] = meanMaturity(maps);
  }
  return result;
}

/** Format an area ID into a human-readable label. */
function formatAreaLabel(areaId: string): string {
  return areaId
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function GapHeatmap({ assessments }: GapHeatmapProps) {
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
                // Absence must render as an empty cell, never as 0% (a zero
                // value would read as "assessed and terrible" instead of
                // "not asked"). `undefined` covers an area this assessment's
                // stageScores never mentions; `null` covers meanMaturity's
                // "no reading anywhere" result; NaN/Infinity covers an old
                // cached report predating D-216's fix, or `meanMaturity`
                // propagating a NaN input unguarded -- all three are "no
                // data" here.
                //
                // D-219 fix round 2 (self-review, altitude pass): a first
                // version of this guard hand-rolled `Number.isFinite(score)`
                // alongside the undefined/null checks -- a SECOND, duplicate
                // copy of the exact validity predicate `getLevel` already
                // owns (`maturityBands.ts`: `pct == null ||
                // !Number.isFinite(pct)` -> 'notAssessed'). That is the
                // identical failure class D-219 exists to eliminate, one
                // abstraction lower: not a second copy of the THRESHOLDS,
                // but a second copy of "is this value classifiable at all."
                // `getLevel` is now the only place that answers that
                // question; this call site just reads its answer.
                const bandLevel = getLevel(score);
                const hasScore = bandLevel !== 'notAssessed';
                const level = hasScore ? bandLevel : 'empty';
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

      {/*
        Legend. D-219 (Task 5): four swatches now, not three -- one per real
        band `getLevel` can return (never `notAssessed` here; a cell with no
        reading renders the neutral 'empty' style above instead, with no
        legend entry of its own, matching the em-dash cell text). Labels and
        ranges are read from `levelLabels`/`levelRange`, not restated, so
        this legend cannot drift from the boundaries the cells above are
        actually coloured by -- the exact drift this task removes.
      */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          marginTop: 12,
          fontSize: 12,
          color: '#6B7280',
          flexWrap: 'wrap',
        }}
      >
        {(['strong', 'developing', 'needsWork', 'critical'] as const).map((level) => (
          <span key={level}>
            <span
              style={{
                display: 'inline-block',
                width: 12,
                height: 12,
                borderRadius: 2,
                backgroundColor: LEVEL_STYLES[level].backgroundColor as string,
                marginRight: 4,
                verticalAlign: 'middle',
              }}
            />
            {levelLabels[level]} ({levelRange(level)})
          </span>
        ))}
      </div>
    </div>
  );
}

// Named export above is what the unit test imports directly (components in
// this directory are hook-free and are called as plain functions, D-169);
// default export kept so existing default-import call sites (e.g. the
// compare page) keep working untouched.
export default GapHeatmap;
