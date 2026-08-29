'use client';

import type { EvidenceScore } from '@/types/domain';
import { meanMaturity } from '@/lib/engine/AssessmentEngine.js';
import { getLevel, levelRange, labelIsShowable } from '@/lib/report/maturityBands';
import { levelLabels } from '@/data/constants';
import { withheldVerdictNote } from '@/lib/report/provenance';

interface AssessmentData {
  id: string;
  version: number;
  completedAt: string | Date | null;
  /**
   * `Assessment.scoringVersion` -- `string | null` (the Prisma column), not
   * `string | undefined` (`labelIsShowable`'s parameter type): the compare
   * page's Prisma select returns the column as-is, so this component
   * converts at its own read site (`?? undefined`) rather than the caller
   * silently narrowing a `null` to `false` via a bare cast (maturity-band-
   * reanchor Task 7 brief's own named type-seam trap).
   */
  scoringVersion?: string | null;
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
// Exported (not just module-private) so a test can assert this map covers
// every band `getLevel` can actually return, generated from the band module
// rather than hand-listed -- see __tests__/unit/dashboard-scores.test.tsx.
// This is the mechanical form of the fix round 2 coordinator finding: the
// widget's ORIGINAL defect (before D-219) was precisely a band with no
// colour -- it shipped three styles (green/amber/red) for a 70/40 split,
// and nothing would have failed loudly if a fourth had been added without a
// fourth style. That risk still exists structurally (this map is still
// hand-authored), so the test closes it going forward rather than trusting
// this comment.
export const LEVEL_STYLES: Record<string, React.CSSProperties> = {
  strong: { backgroundColor: '#D1FAE5', color: '#065F46', fontWeight: 600 },
  developing: { backgroundColor: '#FEF9C3', color: '#854D0E', fontWeight: 600 },
  needsWork: { backgroundColor: '#FFEDD5', color: '#9A3412', fontWeight: 600 },
  critical: { backgroundColor: '#FEE2E2', color: '#991B1B', fontWeight: 600 },
  empty: { backgroundColor: '#F9FAFB', color: '#9CA3AF' },
  /**
   * maturity-band-reanchor Task 7. NOT a band `getLevel` can return --
   * `reachableBandKeys()` in __tests__/unit/dashboard-scores.test.tsx never
   * produces it, by construction (that sweep only calls `getLevel`, which
   * knows nothing about `labelIsShowable`). Selected instead of any band
   * pair above whenever a column's assessment predates the current band
   * vocabulary, for a cell that DOES have a score (an absent score keeps
   * using 'empty', a different claim -- see the cell logic below). A
   * distinct pair from every band AND from 'empty', consistent with
   * `--color-verdict-withheld` (app/globals.css) being deliberately
   * neither a `levelColors` lookup nor `notAssessed`'s grey.
   */
  withheld: { backgroundColor: '#F4F4F5', color: 'var(--color-verdict-withheld)', fontWeight: 600 },
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
    // Derived ONCE per assessment/column here, not per cell below -- see
    // the `AssessmentData.scoringVersion` doc comment for the `?? undefined`
    // conversion.
    labelShowable: labelIsShowable(a.scoringVersion ?? undefined),
  }));

  // Collect all unique area IDs
  const allAreas = new Set<string>();
  perAssessment.forEach((a) =>
    Object.keys(a.scores).forEach((id) => allAreas.add(id)),
  );
  const areas = Array.from(allAreas).sort();

  if (areas.length === 0) return null;

  // maturity-band-reanchor Task 7: same principle as report/page.tsx's
  // legend replacement (Step 6) -- a legend explaining four bands, above a
  // table showing none of them, is worse than no legend. Unlike that
  // single-report page, this widget compares MULTIPLE assessments that can
  // straddle the methodology change, so the legend is only dropped when
  // NOT ONE compared column can show a band -- a mix keeps the legend,
  // since it is still true of the columns that can.
  const anyLabelShowable = perAssessment.some((a) => a.labelShowable);

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
                // PROVENANCE CORRECTION (coordinator, fix round 2 of the
                // maturity-band-reanchor Task 5 review): the "NaN%" gap this
                // comment used to credit to Task 5's own edit PRE-DATES this
                // task. At 6d0ccb1 (before Task 5 touched this file):
                // `const hasScore = score !== undefined && score !== null;`
                // (line 184) already admitted NaN, `const level = hasScore ?
                // scoreLevel(score) : 'empty';` (line 185) then called the
                // OLD ladder on it, and `scoreLevel(NaN) === 'red'` (run and
                // confirmed by the coordinator) -- so the cell already
                // rendered `{hasScore ? \`${score}%\` : '—'}` (line 198)
                // as the literal text "NaN%" under a red style, long before
                // this task existed. Task 5's self-review found a real,
                // pre-existing defect via TDD; it did not introduce one.
                //
                // D-219 fix round 2 (self-review, altitude pass): a first
                // version of THIS task's fix hand-rolled `Number.isFinite(score)`
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
                // maturity-band-reanchor Task 7: a score that exists but
                // cannot be honestly classified under the current bands
                // (`!a.labelShowable`) gets the neutral 'withheld' pair,
                // never a band pair -- distinct from 'empty', which means
                // "no score exists here at all", a different claim.
                const level = !hasScore ? 'empty' : a.labelShowable ? bandLevel : 'withheld';
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

        maturity-band-reanchor Task 7: only rendered when at least one
        compared column can actually show a band -- see `anyLabelShowable`
        above. Otherwise replaced by the same withheld-verdict sentence
        report/page.tsx uses, since the underlying fact is identical.
      */}
      {anyLabelShowable ? (
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
      ) : (
        <p style={{ marginTop: 12, fontSize: 12, color: '#6B7280' }}>{withheldVerdictNote()}</p>
      )}
    </div>
  );
}

// Named export above is what the unit test imports directly (components in
// this directory are hook-free and are called as plain functions, D-169);
// default export kept so existing default-import call sites (e.g. the
// compare page) keep working untouched.
export default GapHeatmap;
