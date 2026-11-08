import { describe, it, expect } from 'vitest';
import { stageReviewName } from '@/lib/seal/reviewName';
import { formatFingerprint } from '@/lib/seal/format';

describe('lib/seal/reviewName.ts and lib/seal/format.ts', () => {
  it('FR-REV-01 (helper): the platform names a review by its stage and number', () => {
    expect(stageReviewName('in-processing', 1)).toBe('In-processing review 1');
    expect(stageReviewName('pre-processing', 2)).toBe('Pre-processing review 2');
    expect(stageReviewName('post-processing', 3)).toBe('Post-processing review 3');
  });

  it('FR-REV-01 (helper): a review number that is not a whole number from 1 is refused', () => {
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => stageReviewName('pre-processing', n), String(n)).toThrow(TypeError);
  });

  it('UX-18 (7.5.8): a fingerprint shows in groups of four, the short form first 8 and last 4', () => {
    const f = '8b2104fa' + '0'.repeat(52) + '9e3d';
    expect(formatFingerprint(f, 'short')).toBe('8b21 04fa ... 9e3d');
    expect(formatFingerprint(f, 'full').split(' ')).toHaveLength(16);
    expect(formatFingerprint(f, 'full').replace(/ /g, '')).toBe(f);
  });

  it('UX-18 (7.5.8): a value that is not a lower-case SHA-256 hex fingerprint is refused, not shown cut', () => {
    for (const bad of ['', 'abc', '8B21' + '0'.repeat(60), '0'.repeat(63) + 'g', '0'.repeat(65)]) {
      expect(() => formatFingerprint(bad, 'short'), bad).toThrow(TypeError);
    }
  });
});
