import { describe, it, expect } from 'vitest';
import { AreaCard } from '../../components/report/AreaCard';
import { extractText } from '../helpers/extractText';

const AREA = { id: 'PP-01', name: 'Problem Formulation', stage: 'pre-processing',
               principle: 'Proportionality & Do Not Harm', controls: [] };
const BASE = { area: AREA, tier: 'attention' as const, findings: [], controlsMap: {},
               stageLabels: {}, expanded: false, onToggle: () => {} };

// AreaCard is hook-free (verified), so it is called directly -- see D-169.
const textOf = (score: unknown) => extractText(AreaCard({ ...BASE, score } as never));
// For the practices-list tests below, which need to vary `practices` and
// `expanded` alongside `score` rather than just `score` on its own.
const renderCard = (overrides: Record<string, unknown>) =>
  extractText(AreaCard({ ...BASE, ...overrides } as never));

describe('an area card shows both readings, in their own units', () => {
  it('renders practices as a count and maturity as a percentage', () => {
    const out = textOf({ maturity: 25, practices: { inPlace: 7, total: 12, byRole: {} } });
    expect(out).toContain('25%');
    expect(out).toContain('7 of 12 practices in place');
  });

  it('says practices were not assessed rather than showing a zero', () => {
    // maturity is deliberately NOT a multiple of 10: "40%" itself contains
    // the substring "0%", which would make `not.toContain('0%')` fail for
    // reasons that have nothing to do with the practices branch under test.
    const out = textOf({ maturity: 41, practices: null });
    expect(out).toContain('No practices assessed');
    expect(out).not.toContain('0 of 0');
    expect(out).not.toContain('0%');
  });

  it('says maturity was not asked rather than showing zero percent', () => {
    const out = textOf({ maturity: null, practices: { inPlace: 2, total: 3, byRole: {} } });
    expect(out).toContain('No maturity questions');
    expect(out).not.toContain('0%');
  });
});

/**
 * Task 5b: the enumerable list behind the practices count -- approved spec
 * §3.3, "with the ticked and unticked items enumerable beneath it and each
 * item's role shown". Collapsed by default behind the SAME expanded/
 * onToggle control the findings section already uses (no second disclosure
 * mechanism), and gated on `score.practices !== null` independently of
 * whatever `practices` array a caller passes, so a null reading can never
 * leak items underneath it.
 */
describe('the practices count has an enumerable list beneath it', () => {
  const TWO_PRACTICES = [
    { label: 'Bias testing conducted before deployment', role: 'primary' as const, checked: true },
    { label: 'Fairness audit documented', role: 'supporting' as const, checked: false },
  ];

  it('lists every item with its role, expanded', () => {
    const out = renderCard({
      score: { maturity: 60, practices: { inPlace: 1, total: 2, byRole: {} } },
      practices: TWO_PRACTICES,
      expanded: true,
    });
    expect(out).toContain('Bias testing conducted before deployment');
    expect(out).toContain('primary');
    expect(out).toContain('Fairness audit documented');
    expect(out).toContain('supporting');
  });

  it('shows an unticked item as not yet in place, never as a failure', () => {
    const out = renderCard({
      score: { maturity: 60, practices: { inPlace: 1, total: 2, byRole: {} } },
      practices: TWO_PRACTICES,
      expanded: true,
    });
    expect(out).toContain('Not yet in place');
    // The unticked item's own copy, not just an absence of a specific word:
    // no failure/error framing anywhere the item renders.
    expect(out).not.toMatch(/missing|fail|wrong|error|✗/i);
  });

  it('stays collapsed by default -- items do not leak when the card is not expanded', () => {
    const out = renderCard({
      score: { maturity: 60, practices: { inPlace: 1, total: 2, byRole: {} } },
      practices: TWO_PRACTICES,
      expanded: false,
    });
    expect(out).not.toContain('Bias testing conducted before deployment');
    expect(out).not.toContain('Fairness audit documented');
  });

  it('renders no list, and no leaked items, when practices is null', () => {
    const out = renderCard({
      score: { maturity: 60, practices: null },
      // Deliberately passed anyway, to prove the render gates on
      // `score.practices`, not merely on whether an items array exists.
      practices: [{ label: 'Should never render', role: 'primary' as const, checked: true }],
      expanded: true,
    });
    expect(out).toContain('No practices assessed');
    expect(out).not.toContain('Should never render');
  });

  it('lists exactly as many items as the count says are in place and total', () => {
    const out = renderCard({
      score: { maturity: 60, practices: { inPlace: 2, total: 3, byRole: {} } },
      practices: [
        { label: 'A', role: 'primary' as const, checked: true },
        { label: 'B', role: 'supporting' as const, checked: true },
        { label: 'C', role: 'supplementary' as const, checked: false },
      ],
      expanded: true,
    });
    const inPlaceCount = (out.match(/In place/g) || []).length;
    const notYetCount = (out.match(/Not yet in place/g) || []).length;
    expect(inPlaceCount).toBe(2);
    expect(notYetCount).toBe(1);
    expect(inPlaceCount + notYetCount).toBe(3);
  });
});
