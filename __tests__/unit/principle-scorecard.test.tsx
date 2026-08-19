import { describe, it, expect } from 'vitest';
import { PrincipleScorecard } from '../../components/report/PrincipleScorecard';
import { extractText } from '../helpers/extractText';

// PrincipleScorecard is hook-free (verified), so it is called directly -- see D-169.
const textOf = (principle: unknown) => extractText(PrincipleScorecard({ principle } as never));

describe('a principle scorecard shows both readings, in their own units', () => {
  it('renders practices as a count and maturity as a percentage', () => {
    const out = textOf({ name: 'Fairness & Non-discrimination', pct: 60, level: 'developing',
                          practices: { inPlace: 3, total: 5, byRole: {} } });
    expect(out).toContain('60%');
    expect(out).toContain('3 of 5 practices in place');
  });

  it('says practices were not assessed rather than showing a zero', () => {
    // pct is deliberately NOT a multiple of 10: "50%" itself contains the
    // substring "0%", which would make `not.toContain('0%')` fail for
    // reasons that have nothing to do with the practices branch under test.
    const out = textOf({ name: 'Sustainability', pct: 51, level: 'developing', practices: null });
    expect(out).toContain('No practices assessed');
    expect(out).not.toContain('0 of 0');
    expect(out).not.toContain('0%');
  });

  it('says maturity was not asked rather than showing zero percent', () => {
    const out = textOf({ name: 'Awareness & Literacy', pct: null, level: 'notAssessed',
                          practices: { inPlace: 1, total: 2, byRole: {} } });
    expect(out).toContain('No maturity questions');
    expect(out).not.toContain('0%');
  });

  /**
   * Fix round 1 (Task 6 review, Finding 1). `AreaCard` and `ReportSummary`
   * both label their maturity percentage "Assessed maturity" -- the label
   * is the mitigation for a "gap"/weak tier badge legitimately sitting
   * beside a strong percentage (independent derivations, ~5.2% of
   * readings): it tells a reader the number is a measurement, not a
   * second verdict. This card was the one surface of the three that left
   * the non-null percentage unlabelled.
   */
  it('labels the maturity percentage "Assessed maturity", matching AreaCard and ReportSummary', () => {
    const out = textOf({ name: 'Fairness & Non-discrimination', pct: 60, level: 'developing',
                          practices: { inPlace: 3, total: 5, byRole: {} } });
    expect(out).toContain('Assessed maturity');
  });
});
