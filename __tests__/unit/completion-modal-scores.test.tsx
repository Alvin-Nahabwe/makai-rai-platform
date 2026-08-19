import { describe, it, expect } from 'vitest';
import { renderAreaScoreRows } from '@/components/assessment/CompletionModal';
import type { AreaScoreMap } from '@/types/domain';
import { extractText } from '../helpers/extractText';

/**
 * Task 11 seam test.
 *
 * `CompletionModal` (a stage-completion dialog) was still typed
 * `areaScores: Record<string, number>` and rendered `{score}%` where
 * `score` was the whole `EvidenceScore` object `calculateAreaScores` has
 * returned since Task 1 -- React's "Objects are not valid as a child of
 * React.Component" error, thrown live on every stage completion. No test
 * caught it because nothing exercised this component against the shape
 * the engine actually produces.
 *
 * `CompletionModal` itself is hook-bearing (`useRef`/`useEffect` manage the
 * native `<dialog>`'s open state) and so cannot be called directly outside
 * a real render -- D-169, this repo has no jsdom/@testing-library/react,
 * and React throws "Invalid hook call" for a hook invoked outside one.
 * `renderAreaScoreRows` is the exact score-row markup -- the expression
 * that crashed -- factored out into a hook-free, directly-callable,
 * exported function specifically so this seam stays pinned (same split
 * `AssessmentEngine.js#meanMaturity`/`useFindingsData.ts#computeFindingsData`
 * already use for the identical reason); `CompletionModal` itself renders
 * by calling this function, so this test exercises the real code path, not
 * a re-implementation of it.
 */
describe('CompletionModal renders the maturity reading, not the EvidenceScore object (Task 11 seam)', () => {
  it("shows each area's maturity percentage, never the raw EvidenceScore object", () => {
    const areaScores: AreaScoreMap = {
      'PP-01': { maturity: 41, practices: { inPlace: 2, total: 3, byRole: {} } },
      'PP-02': { maturity: 63, practices: null },
    };
    const out = extractText(renderAreaScoreRows(areaScores, '#C06014'));

    expect(out).toContain('PP-01');
    expect(out).toContain('41%');
    expect(out).toContain('PP-02');
    expect(out).toContain('63%');
    // The exact failure mode the original bug produced: `{score}%` with
    // `score` the whole object renders as "[object Object]%" (or throws,
    // depending on the React version's child-validation path) rather than
    // a percentage. Silently stringifying the object would itself be a
    // wrong pass this assertion is here to catch.
    expect(out).not.toContain('[object Object]');
    expect(out).not.toMatch(/NaN/);
  });

  it('says no maturity questions rather than showing 0%, for an area with no maturity reading', () => {
    const areaScores: AreaScoreMap = {
      'PP-03': { maturity: null, practices: { inPlace: 1, total: 4, byRole: {} } },
    };
    const out = extractText(renderAreaScoreRows(areaScores, '#C06014'));

    expect(out).toContain('No maturity questions');
    expect(out).not.toContain('0%');
    expect(out).not.toMatch(/NaN/);
  });
});
