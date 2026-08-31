import { describe, it, expect } from 'vitest';
import {
  axisSensitivityByPrinciple,
  thinAxes,
  worstSensitivity,
  SENSITIVITY_THRESHOLD_POINTS,
} from '@/lib/report/axisSensitivity';
import type { EvidenceScore } from '@/types/domain';

/**
 * Content-audit item 17, radar half.
 *
 * The radar draws eight axes identically, but they are not equally resourced.
 * The scorecard's answer was to print the question COUNT -- correct there,
 * because the scorecard is already per-stage. It is the wrong quantity for the
 * radar, which plots a MEAN OF PER-STAGE scores: a principle's volatility is
 * driven by its thinnest stage, not its total.
 *
 * Measured on shipped content, Safety & Security has 9 questions but rests on
 * a single question in pre-processing -- one answer moves its radar position
 * 8.3 points, worse than Awareness & Literacy with 3 questions total. A
 * count-based rule flags Awareness and clears Safety, backwards on the merits.
 *
 * So the axis is flagged on SENSITIVITY: how far one answer, moved one step,
 * can shift the plotted value.
 */

const score = (maturity: number | null, basisCount?: number): EvidenceScore =>
  ({ maturity, practices: null, ...(basisCount === undefined ? {} : { basisCount }) }) as EvidenceScore;

describe('axisSensitivityByPrinciple', () => {
  it('is 12.5 for a principle resting on one question in each of two stages', () => {
    // One step is a quarter of a likert-5 range: 25 points on that stage's own
    // score, halved by averaging across two stages.
    const s = axisSensitivityByPrinciple({
      'pre-processing': { Sustainability: score(50, 1) },
      'post-processing': { Sustainability: score(50, 1) },
    });
    expect(s.Sustainability).toBeCloseTo(12.5, 5);
  });

  it('is driven by the THINNEST stage, not the total question count', () => {
    // The Safety & Security shape: 9 questions, but pre-processing holds one.
    const s = axisSensitivityByPrinciple({
      'pre-processing': { 'Safety & Security': score(50, 1) },
      'in-processing': { 'Safety & Security': score(50, 4) },
      'post-processing': { 'Safety & Security': score(50, 4) },
    });
    expect(s['Safety & Security']).toBeCloseTo(25 / 3, 5);

    // Same 9 questions spread evenly are far steadier -- proving the rule
    // reads the distribution and not the sum.
    const even = axisSensitivityByPrinciple({
      'pre-processing': { 'Safety & Security': score(50, 3) },
      'in-processing': { 'Safety & Security': score(50, 3) },
      'post-processing': { 'Safety & Security': score(50, 3) },
    });
    expect(even['Safety & Security']).toBeCloseTo(25 / 9, 5);
    expect(even['Safety & Security']).toBeLessThan(s['Safety & Security']!);
  });

  it('ignores stages that produced no reading, rather than counting them as data', () => {
    // A null-maturity stage contributes nothing to the mean, so it must not
    // enlarge the divisor -- doing so would understate the volatility.
    const s = axisSensitivityByPrinciple({
      'pre-processing': { Awareness: score(50, 3) },
      'in-processing': { Awareness: score(null, 0) },
      'post-processing': { Awareness: score(null, 0) },
    });
    expect(s.Awareness).toBeCloseTo(25 / 3, 5);
  });

  it('is undefined when the stored assessment predates basisCount', () => {
    // Never a number for legacy data: a fabricated sensitivity would flag or
    // clear an axis on evidence that does not exist.
    const s = axisSensitivityByPrinciple({
      'pre-processing': { Sustainability: score(50) },
    });
    expect(s.Sustainability).toBeUndefined();
  });

  it('is undefined when only SOME stages carry the field', () => {
    // A partial basis would compute a confident number from half the picture.
    const s = axisSensitivityByPrinciple({
      'pre-processing': { Sustainability: score(50, 1) },
      'post-processing': { Sustainability: score(50) },
    });
    expect(s.Sustainability).toBeUndefined();
  });
});

describe('thinAxes', () => {
  it(`flags an axis only above ${SENSITIVITY_THRESHOLD_POINTS} points`, () => {
    expect(thinAxes({ A: 12.5, B: 8.4, C: 8, D: 2 })).toEqual(['A', 'B']);
  });

  it('never flags an axis whose sensitivity is unknown', () => {
    // Legacy assessments must not be labelled thin on absent evidence.
    expect(thinAxes({ A: undefined, B: 12.5 })).toEqual(['B']);
  });

  it('returns the most volatile axis first, so the caption leads with the worst', () => {
    expect(thinAxes({ Mild: 8.4, Worst: 12.5, Mid: 9 })).toEqual(['Worst', 'Mid', 'Mild']);
  });

  it('flags nothing on a balanced axis set', () => {
    expect(thinAxes({ A: 2, B: 1.4, C: 3 })).toEqual([]);
  });
});

describe('worstSensitivity — merging the assessments the radar compares', () => {
  it('takes the WORST across assessments, not the newest', () => {
    // The basis is response-dependent: six *-EXTRA-* questions unlock only
    // when an earlier stage was answered weakly, so two assessments on the
    // SAME framework version legitimately disagree about it. Last-write-wins
    // would let whichever happened to be merged last decide the caption.
    expect(worstSensitivity([{ A: 4 }, { A: 12.5 }, { A: 6 }])).toEqual({ A: 12.5 });
  });

  it('keeps a known value rather than letting a legacy assessment erase it', () => {
    // An assessment stored before basisCount existed knows nothing about the
    // axis. Nothing is not the same as steady.
    expect(worstSensitivity([{ A: 12.5 }, { A: undefined }])).toEqual({ A: 12.5 });
  });

  it('stays undefined when no assessment can say', () => {
    expect(worstSensitivity([{ A: undefined }, { A: undefined }])).toEqual({ A: undefined });
  });

  it('keeps an axis only one assessment measured', () => {
    // The radar\'s axis set is the UNION across compared assessments.
    expect(worstSensitivity([{ A: 9 }, { B: 3 }])).toEqual({ A: 9, B: 3 });
  });
});
