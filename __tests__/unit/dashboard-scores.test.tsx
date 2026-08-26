import { describe, it, expect } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { GapHeatmap, LEVEL_STYLES } from '@/components/dashboard/GapHeatmap';
import { RadarChart } from '@/components/dashboard/RadarChart';
import { extractText } from '../helpers/extractText';
import { getLevel } from '@/lib/report/maturityBands';

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
   * D-219 fix round 1 (self-review, maturity-band-reanchor Task 5). `hasScore`
   * used to gate only on `!== undefined && !== null`, so a NON-FINITE
   * `.maturity` (NaN or +/-Infinity) -- reachable from an old cached report
   * predating D-216's guard, or from `meanMaturity` propagating a NaN input
   * through its own unguarded `reduce` -- read as "has a score" and rendered
   * literally: `{score}%` -> the text "NaN%", and `LEVEL_STYLES[getLevel(score)]`
   * ('notAssessed') is `undefined` (no such key), so the cell also lost its
   * background/foreground pair. Same failure class this whole branch keeps
   * finding: a check whose property (definedness) was narrower than the
   * obligation it claimed to discharge (validity). Fixed by folding
   * `Number.isFinite` into `hasScore` itself, so a non-finite reading is
   * treated exactly like an absent one -- the same convention `getLevel`
   * already applies one layer up.
   */
  it('renders a non-finite maturity reading as a dash, never as "NaN%"', () => {
    const rows = [{ id: 'a1', completedAt: '2026-08-19T00:00:00Z', reportData: {
      stageScores: { 'pre-processing': {
        'PP-03': { maturity: NaN, practices: null },
      } },
    } }];

    const out = extractText(GapHeatmap({ assessments: rows } as never));

    expect(out).toContain('—');
    expect(out).not.toContain('NaN');
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

  /**
   * Final whole-branch review, Important 2. `principles` is the UNION across
   * every compared assessment, not one assessment's own cells -- a 1-stage
   * assessment compared against a 3-stage one is null (radius 0, collapsed
   * to the chart's centre) on every principle the shorter one never reached,
   * which Recharts cannot distinguish from "assessed and scored 0%". The
   * geometry itself is not fixable (no upstream option), so the mitigation
   * is a caption naming, per assessment, exactly which union principles it
   * never assessed. This pins that the caption appears and names the right
   * principle for the shorter assessment.
   */
  it('captions which principles a shorter assessment never reached, alongside a longer one', () => {
    const rows = [
      {
        id: 'short', version: 1, completedAt: '2026-01-01T00:00:00Z',
        reportData: {
          principleScores: {
            'pre-processing': { 'Fairness & Non-discrimination': { maturity: 50, practices: null } },
          },
        },
      },
      {
        id: 'long', version: 2, completedAt: '2026-06-01T00:00:00Z',
        reportData: {
          principleScores: {
            'pre-processing': { 'Fairness & Non-discrimination': { maturity: 70, practices: null } },
            'post-processing': { 'Safety & Security': { maturity: 90, practices: null } },
          },
        },
      },
    ];

    const out = extractText(RadarChart({ assessments: rows } as never));

    // The short assessment never touched Safety & Security -- the caption
    // must say so by name, not leave the collapsed vertex unexplained.
    expect(out).toContain('did not assess');
    expect(out).toContain('Safety & Security');
    // The long assessment covers both principles the union contains, so it
    // must not be captioned as missing anything.
    expect(out).not.toMatch(/long.*did not assess/);
  });

  /**
   * The mirror case: every compared assessment covers the same set of
   * principles, so the union collapse this test guards against cannot
   * occur. The caption must not appear at all -- a caption naming zero
   * missing principles, or naming principles that were in fact assessed,
   * would be its own false alarm.
   */
  it('renders no caption when every compared assessment covers the same principles', () => {
    const rows = [
      {
        id: 'a', version: 1, completedAt: '2026-01-01T00:00:00Z',
        reportData: {
          principleScores: {
            'pre-processing': { 'Fairness & Non-discrimination': { maturity: 50, practices: null } },
          },
        },
      },
      {
        id: 'b', version: 2, completedAt: '2026-06-01T00:00:00Z',
        reportData: {
          principleScores: {
            'pre-processing': { 'Fairness & Non-discrimination': { maturity: 70, practices: null } },
          },
        },
      },
    ];

    const out = extractText(RadarChart({ assessments: rows } as never));

    expect(out).not.toContain('did not assess');
  });
});

/**
 * Fix round 2 (coordinator, maturity-band-reanchor Task 5 review, Finding 2
 * promoted from Minor). `GapHeatmap`'s ORIGINAL defect, before D-219, was
 * precisely a band with no colour: it shipped three styles
 * (green/amber/red) for its own 70/40 split. Nothing here ever proved the
 * analogous property for the current, shared 4-real-band ladder -- that
 * `LEVEL_STYLES` has a pair for every band `getLevel` can actually return.
 *
 * The set of reachable bands is GENERATED by sweeping `getLevel` across its
 * own domain, not by re-typing 'strong'/'developing'/'needsWork'/'critical'
 * by hand -- a hand-typed list here would just be a fourth copy of the
 * exact ladder D-219 exists to collapse into one place
 * (lib/report/maturityBands.ts). A fifth band added later, or a boundary
 * moved, is caught automatically because this test re-derives the set every
 * run instead of trusting a snapshot of today's four names.
 */
describe('GapHeatmap.LEVEL_STYLES covers every band getLevel can return', () => {
  function reachableBandKeys(): string[] {
    const seen = new Set<string>();
    for (let score = 0; score <= 100; score += 0.5) {
      seen.add(getLevel(score));
    }
    return Array.from(seen);
  }

  it('has a style entry for every reachable band', () => {
    const bands = reachableBandKeys();
    // Non-vacuity: the sweep must actually surface more than one band, or
    // "every band has a style" would pass trivially over an empty or
    // single-band set.
    expect(bands.length).toBeGreaterThan(1);
    for (const band of bands) {
      expect(LEVEL_STYLES[band], `LEVEL_STYLES has no entry for '${band}'`).toBeDefined();
    }
  });

  it('never surfaces notAssessed from a finite 0-100 score -- absence is the separate "empty" style, not a band', () => {
    // getLevel only answers 'notAssessed' for null/undefined/NaN/Infinity
    // (lib/report/maturityBands.ts), never for a finite in-range score --
    // pinned here because the production call site relies on exactly this
    // to route an absent/invalid reading to 'empty' before it ever reaches
    // LEVEL_STYLES, rather than needing an entry keyed 'notAssessed' itself.
    expect(reachableBandKeys()).not.toContain('notAssessed');
  });

  it('gives every defined style pair a visually distinct background/foreground combination', () => {
    // Values, not exact hex -- pinning the actual colours would assert a
    // design decision instead of the property (distinctness) that matters.
    const seen = new Map<string, string>();
    for (const [key, style] of Object.entries(LEVEL_STYLES)) {
      const pair = `${style.backgroundColor}/${style.color}`;
      const clashing = seen.get(pair);
      expect(clashing, `'${key}' and '${clashing}' share one background/foreground pair`).toBeUndefined();
      seen.set(pair, key);
    }
  });
});
