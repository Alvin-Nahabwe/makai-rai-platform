import { describe, it, expect } from 'vitest';
import { AreaCard } from '../../components/report/AreaCard';
import { extractText } from '../helpers/extractText';

const AREA = { id: 'PP-01', name: 'Problem Formulation', stage: 'pre-processing',
               principle: 'Proportionality & Do Not Harm', controls: [] };
const BASE = { area: AREA, tier: 'attention' as const, findings: [], controlsMap: {},
               stageLabels: {}, expanded: false, onToggle: () => {} };

// AreaCard is hook-free (verified), so it is called directly -- see D-169.
const textOf = (score: unknown) => extractText(AreaCard({ ...BASE, score } as never));

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
