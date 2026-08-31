import { describe, it, expect } from 'vitest';
import { RadarChart } from '@/components/dashboard/RadarChart';
import { extractText } from '../helpers/extractText';

/**
 * Content-audit item 17, radar half — the rendered caption.
 *
 * The logic is covered in axis-sensitivity.test.ts. These check the number
 * actually reaches the reader, which is the whole point: a correct computation
 * that renders nothing leaves the chart exactly as misleading as before.
 */

const assessment = (
  version: number,
  principleScores: Record<string, Record<string, unknown>>,
) => ({
  version,
  completedAt: '2026-08-31T00:00:00.000Z',
  reportData: { principleScores },
});

const render = (...assessments: unknown[]) =>
  extractText(RadarChart({ assessments } as never));

describe('the radar discloses axes one answer can move', () => {
  it('names a volatile axis and says how far one answer moves it', () => {
    const text = render(assessment(1, {
      'pre-processing': { Sustainability: { maturity: 50, practices: null, basisCount: 1 } },
      'post-processing': { Sustainability: { maturity: 50, practices: null, basisCount: 1 } },
    }));
    expect(text).toMatch(/Sustainability by 12\.5 points/);
    expect(text).toMatch(/not equally measured/i);
  });

  it('says nothing when every axis is steady', () => {
    const text = render(assessment(1, {
      'pre-processing': { Fairness: { maturity: 50, practices: null, basisCount: 8 } },
      'in-processing': { Fairness: { maturity: 50, practices: null, basisCount: 6 } },
    }));
    expect(text).not.toMatch(/not equally measured/i);
  });

  it('says nothing for an assessment stored before basisCount existed', () => {
    // The caption must not appear for legacy data, where the sensitivity is
    // unknown rather than acceptable.
    const text = render(assessment(1, {
      'pre-processing': { Sustainability: { maturity: 50, practices: null } },
    }));
    expect(text).not.toMatch(/not equally measured/i);
  });

  it('warns on the worst compared assessment, not the last one merged', () => {
    // A steady later assessment must not hide a volatile earlier one.
    const text = render(
      assessment(1, {
        'pre-processing': { Sustainability: { maturity: 50, practices: null, basisCount: 1 } },
        'post-processing': { Sustainability: { maturity: 50, practices: null, basisCount: 1 } },
      }),
      assessment(2, {
        'pre-processing': { Sustainability: { maturity: 50, practices: null, basisCount: 9 } },
        'post-processing': { Sustainability: { maturity: 50, practices: null, basisCount: 9 } },
      }),
    );
    expect(text).toMatch(/Sustainability by 12\.5 points/);
  });
});
