import { describe, it, expect } from 'vitest';
import { PrincipleScorecard } from '../../components/report/PrincipleScorecard';
import { extractText } from '../helpers/extractText';

// PrincipleScorecard is hook-free (verified), so it is called directly -- see D-169.
const textOf = (principle: unknown) => extractText(PrincipleScorecard({ principle } as never));

/**
 * A principle score says how many answers it rests on.
 *
 * Content-audit item 17. The eight principles are shown side by side, and the
 * arrangement implies they are comparable. They are not: measured on
 * 2026-08-31, Fairness rests on 22 questions and Sustainability on 2, five of
 * the 24 stage x principle cells are empty, and four hold a single question --
 * where a five-point scale can only ever produce five distinct percentages.
 *
 * The audit offered two ways out: balance the axis, or stop showing the scores
 * side by side. Balancing means writing roughly twenty questions with domain
 * expertise this pass does not have, and hiding throws away a reading users
 * have reason to want. Disclosing the basis is the third option and the honest
 * one -- the number stays, and so does what it is made of.
 *
 * This is the same move as `labelIsShowable` below: show the measurement,
 * withhold the unearned confidence.
 */
describe('a principle score discloses how many questions it rests on', () => {
  it('names the count beside the percentage', () => {
    const out = textOf({ name: 'Sustainability', pct: 51, level: 'developing',
                          practices: null, basis: 2 });
    expect(out).toContain('51%');
    expect(out, 'a reader cannot tell this rests on two answers').toContain('2 maturity questions');
  });

  it('says "question" in the singular for a one-question principle', () => {
    // Four cells hold exactly one. "1 maturity questions" would read as a bug
    // and undermine the disclosure it exists to make.
    const out = textOf({ name: 'Sustainability', pct: 51, level: 'developing',
                          practices: null, basis: 1 });
    expect(out).toContain('1 maturity question');
    expect(out).not.toContain('1 maturity questions');
  });

  it('says nothing about basis when maturity was never asked', () => {
    // pct null already renders "No maturity questions"; adding "0 maturity
    // questions" beside it would be the same fact twice, in two wordings.
    const out = textOf({ name: 'Awareness & Literacy', pct: null, level: 'notAssessed',
                          practices: { inPlace: 1, total: 2, byRole: {} }, basis: 0 });
    expect(out).toContain('No maturity questions');
    expect(out).not.toContain('0 maturity');
  });
});

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
