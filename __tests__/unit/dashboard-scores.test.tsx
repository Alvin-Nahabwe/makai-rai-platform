import { describe, it, expect } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { GapHeatmap } from '@/components/dashboard/GapHeatmap';
import { RadarChart } from '@/components/dashboard/RadarChart';
import { extractText } from '../helpers/extractText';

/**
 * Recharts' <RadarChart> receives the whole aggregated dataset as a `data`
 * PROP, not as rendered text children -- `extractText` (which only reads
 * `.props.children`, by design: see its own doc comment) cannot see it.
 * RadarChart is hook-free and called directly (D-169); the nested Recharts
 * components inside its returned tree are never actually invoked, just
 * referenced as plain `{type, props}` element objects, so this walks the
 * same unevaluated tree looking for the one element carrying an array
 * `data` prop -- the <RechartsRadar> container -- and returns it.
 */
function findChartData(node: ReactNode): Record<string, unknown>[] | undefined {
  if (node === null || node === undefined || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findChartData(child);
      if (found) return found;
    }
    return undefined;
  }
  if ('props' in node) {
    const props = (node as ReactElement<Record<string, unknown>>).props ?? {};
    if (Array.isArray(props.data)) return props.data as Record<string, unknown>[];
    return findChartData(props.children as ReactNode);
  }
  return undefined;
}

// Both widgets are hook-free, so they are called directly (D-169).
describe('dashboard widgets read the maturity reading', () => {
  it('flattens area maturity, skipping areas that carry none', () => {
    const rows = [{ id: 'a1', completedAt: '2026-08-19T00:00:00Z', reportData: {
      stageScores: { 'pre-processing': {
        'PP-01': { maturity: 80, practices: null },
        'PP-02': { maturity: null, practices: { inPlace: 3, total: 4, byRole: {} } },
      } },
    } }];

    const out = extractText(GapHeatmap({ assessments: rows } as never));

    expect(out).toContain('80');
    // The failure mode this pins: reading the EvidenceScore object itself, or
    // averaging a null in, both of which render silently rather than throwing.
    expect(out).not.toContain('[object Object]');
    expect(out).not.toContain('NaN');
  });

  /**
   * PP-02 carries no maturity reading at all. An absent reading must render
   * as text (the heatmap's own em-dash placeholder), never as "0%" -- a zero
   * cell would read as "assessed and terrible" instead of "not asked" (same
   * convention AreaCard and PrincipleScorecard already use for the same
   * EvidenceScore.maturity === null case).
   */
  it('renders an unasked area as a dash, never as 0%', () => {
    const rows = [{ id: 'a1', completedAt: '2026-08-19T00:00:00Z', reportData: {
      stageScores: { 'pre-processing': {
        'PP-02': { maturity: null, practices: null },
      } },
    } }];

    const out = extractText(GapHeatmap({ assessments: rows } as never));

    expect(out).toContain('—');
    expect(out).not.toContain('0%');
  });

  /**
   * Principles recur across stages (measured: 7 of 8) -- unlike GapHeatmap's
   * areas, which are globally unique ids. This assessment has the SAME
   * principle scored in two different stages; the widget must average both
   * readings, not have the later stage silently overwrite the earlier one.
   * Task 2 hit exactly this bug with a by-name merge (`sums[principle] = ...`
   * keyed only by name); it looked correct because JS object assignment
   * merges silently.
   */
  it('combines, rather than overwrites, a principle scored in two different stages', () => {
    const rows = [{ id: 'a1', completedAt: '2026-08-19T00:00:00Z', reportData: {
      principleScores: {
        'pre-processing': {
          'Fairness & Non-discrimination': { maturity: 40, practices: null },
        },
        'in-processing': {
          'Fairness & Non-discrimination': { maturity: 80, practices: null },
        },
      },
    } }];

    const data = findChartData(RadarChart({ assessments: rows } as never));
    const entry = data?.find((d) => d.principle === 'Fairness & Non-discrimination');

    // Mean of 40 and 80. An overwrite bug would leave only the later
    // stage's reading and produce 80 here instead.
    expect(entry?.a0).toBe(60);
  });

  /**
   * A principle with no maturity reading anywhere must reach the chart's
   * data as `null`, never as a fabricated `0` -- the widget's own prior `??
   * 0` fallback was exactly this trap (spec: "a zero-value point... reads as
   * 'assessed and terrible'"). Recharts' own <Radar> geometry still maps a
   * null value to radius 0 (an upstream limitation documented at the data-
   * building call site in RadarChart.tsx) -- what this test can and does pin
   * is that the DATA this widget hands to the chart stays honest.
   */
  it('preserves an unread principle as null, never as a fabricated 0', () => {
    const rows = [{ id: 'a1', completedAt: '2026-08-19T00:00:00Z', reportData: {
      principleScores: {
        'pre-processing': {
          Sustainability: { maturity: null, practices: { inPlace: 2, total: 3, byRole: {} } },
        },
      },
    } }];

    const data = findChartData(RadarChart({ assessments: rows } as never));
    const entry = data?.find((d) => d.principle === 'Sustainability');

    expect(entry?.a0).toBeNull();
    expect(entry?.a0).not.toBe(0);
  });
});
