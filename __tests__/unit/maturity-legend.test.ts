import { describe, it, expect } from 'vitest';
import { legendRangeSuffix } from '@/app/(authenticated)/orgs/[slug]/assessment/[id]/report/page';
import { levelLabels } from '@/data/constants';
import { levelRange } from '@/lib/report/maturityBands';

/**
 * Final whole-branch review, Important 1 (BLOCKING). The report's maturity
 * legend used to pick a percentage band with a ternary whose fall-through was
 * '0–24%'. `levelLabels` (data/constants.ts) grew a fifth key, `notAssessed`,
 * when Task 4 added the "no maturity question in the current framework" tier
 * -- the fall-through caught that key too, so the report's OWN explanatory
 * legend rendered "Not Assessed (0–24%)" on every completed report: stating
 * that not-assessed IS the failing band, the exact conflation this branch
 * exists to remove. No test covered the legend, which is why it shipped and
 * survived three separate task reviews plus the first whole-branch pass.
 *
 * `legendRangeSuffix` is exported from the (hook-heavy,
 * untestable-by-direct-call) report page specifically so this can be pinned
 * without jsdom or testing-library (D-169).
 *
 * D-219 (maturity-band-reanchor Task 5): `legendRangeSuffix` now derives its
 * text from `lib/report/maturityBands.ts#levelRange`/`BAND_MINIMUMS`
 * (87.5/62.5/37.5) rather than a hand-maintained integer-range map, so the
 * four hardcoded strings below changed to match, and the old
 * `/^ \(\d+–\d+%\)$/` regex is gone -- it encoded the integer-range form
 * ('75–100%') these fractional boundaries cannot take
 * ('62.5% to under 87.5%').
 */
describe('the maturity legend never states a percentage band for "Not Assessed"', () => {
  it('has no range for notAssessed', () => {
    expect(levelRange('notAssessed')).toBeNull();
  });

  it('renders no parenthetical at all for notAssessed', () => {
    // The exact regression: a fall-through gave notAssessed the SAME
    // parenthetical as critical ('0–24%'). Empty string, not a band.
    expect(legendRangeSuffix('notAssessed')).toBe('');
  });

  it('still renders the correct band for each real percentage tier', () => {
    expect(legendRangeSuffix('strong')).toBe(' (87.5% and above)');
    expect(legendRangeSuffix('developing')).toBe(' (62.5% to under 87.5%)');
    expect(legendRangeSuffix('needsWork')).toBe(' (37.5% to under 62.5%)');
    expect(legendRangeSuffix('critical')).toBe(' (under 37.5%)');
  });

  it('covers every key levelLabels actually declares, so a future tier cannot be silently missed', () => {
    for (const key of Object.keys(levelLabels)) {
      if (key === 'notAssessed') {
        expect(legendRangeSuffix(key), key).toBe('');
      } else {
        expect(legendRangeSuffix(key), key).not.toBe('');
      }
    }
  });
});
