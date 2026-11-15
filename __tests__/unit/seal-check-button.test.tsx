import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SealCheckButton, sealCheckMessage, checkResponseMessage, sealCheckPath } from '@/components/review/SealCheckButton';
import { REVIEW_COPY } from '@/lib/review/copy';

/**
 * The "Check this seal" control of S-16 (UX-19, M-29). vitest runs in the `node` environment with no jsdom (an
 * install is a download, G-23), so this file reads the markup from react-dom/server and the pure functions the
 * click runs; the click itself, the announcement and keyboard use are REV-b's S-16 end-to-end test.
 */
describe('SealCheckButton (S-16 slot)', () => {
  it('UX-19 M-29: the three results read exactly as M-29', () => {
    expect(sealCheckMessage({ kind: 'valid', erasedFields: 0, erasedFiles: 0, erasedOn: null, clockWarnings: [] })).toBe(REVIEW_COPY.check.valid);
    expect(sealCheckMessage({ kind: 'valid', erasedFields: 1, erasedFiles: 0, erasedOn: '2026-11-03', clockWarnings: [] }))
      .toBe(REVIEW_COPY.check.validErasedOne('3 Nov 2026'));
    expect(sealCheckMessage({ kind: 'valid', erasedFields: 2, erasedFiles: 0, erasedOn: '2026-11-03', clockWarnings: [] }))
      .toBe(REVIEW_COPY.check.validErasedMany(2, '3 Nov 2026'));
    expect(sealCheckMessage({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].reason' }))
      .toBe(REVIEW_COPY.check.mismatch);
    expect(sealCheckMessage({ kind: 'fingerprint_mismatch' }))
      .toBe(REVIEW_COPY.check.mismatch);
  });

  it('UX-19 (owner question B10 default): clock warnings are not shown, and an erased file alone reads as a plain match', () => {
    expect(sealCheckMessage({ kind: 'valid', erasedFields: 0, erasedFiles: 1, erasedOn: '2026-11-03', clockWarnings: ['decisions[Q-PP-01]'] })).toBe(REVIEW_COPY.check.valid);
  });

  it('UX-19 NFR-A11Y-02 NFR-A11Y-05: a native button named "Check this seal" and an empty polite status region, no colour-only state', () => {
    const html = renderToStaticMarkup(<SealCheckButton orgSlug="o" projectId="p" reviewId="r" sealId="s" />);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Check this seal<\/button>/);
    expect(html).toMatch(/<[a-z]+[^>]*role="status"[^>]*><\/[a-z]+>/);
    expect(html).not.toMatch(/style="[^"]*color/);
  });

  it('UX-19 UX-27 NFR-SEC-02: the check is a GET of route 14 with each path segment encoded', () => {
    expect(sealCheckPath({ orgSlug: 'org a', projectId: 'p/1', reviewId: 'r', sealId: 's?x' }))
      .toBe('/api/v1/orgs/org%20a/projects/p%2F1/reviews/r/seals/s%3Fx/check');
  });

  it('UX-19 NFR-SEC-20: a 429 shows the wait, any other failure says the check did not run', () => {
    expect(checkResponseMessage(429, { code: 'rate_limited', retryAfterSeconds: 125 })).toBe('Too many checks. Try again in 3 minutes.');
    expect(checkResponseMessage(429, { code: 'rate_limited', retryAfterSeconds: 40 })).toBe('Too many checks. Try again in 40 seconds.');
    expect(checkResponseMessage(429, { code: 'rate_limited', retryAfterSeconds: 60 })).toBe('Too many checks. Try again in 1 minute.');
    expect(checkResponseMessage(500, { code: 'internal_error' })).toBe(REVIEW_COPY.check.didNotRun);
    expect(checkResponseMessage(200, { kind: 'valid', erasedFields: 0, erasedFiles: 0, erasedOn: null, clockWarnings: [] })).toBe(REVIEW_COPY.check.valid);
    expect(checkResponseMessage(200, { kind: 'surprise' })).toBe(REVIEW_COPY.check.didNotRun);   // a reply the page cannot read is not a result
  });
});
