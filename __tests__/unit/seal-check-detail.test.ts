import { describe, expect, it } from 'vitest';
import { checkResponseDetail, sealCheckDetail, sealCheckMessage } from '@/components/review/SealCheckButton';
import { REVIEW_COPY } from '@/lib/review/copy';

/** The seal check's "Technical details" (Task 18 Q3 (i)): the first difference is kept, out of the sentence. */
describe('SealCheckButton technical details', () => {
  it('M-29 (Task 18 Q3 (i)): a mismatch keeps the path of the first difference, for the Technical details disclosure only', () => {
    expect(sealCheckDetail({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].reason' })).toBe(REVIEW_COPY.check.firstDifference('decisions[Q-PP-01].reason'));
    expect(sealCheckDetail({ kind: 'fingerprint_mismatch' })).toBe(REVIEW_COPY.check.firstDifference('fingerprint'));
    expect(sealCheckDetail({ kind: 'valid', erasedFields: 0, erasedFiles: 0, erasedOn: null, clockWarnings: [] })).toBeNull();
    expect(checkResponseDetail(200, { kind: 'mismatch', firstDifference: 'manifest.project' })).toBe(REVIEW_COPY.check.firstDifference('manifest.project'));
    expect(checkResponseDetail(500, { kind: 'mismatch', firstDifference: 'manifest.project' })).toBeNull();
    expect(sealCheckMessage({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].reason' })).not.toContain('decisions[');
  });

});
