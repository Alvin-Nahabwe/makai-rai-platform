import { describe, it } from 'vitest';
import { TERM_WORKING_REPORT } from '@/lib/vocabulary/terms';
import { assertNoClaims } from '../helpers/copyClaims';

/**
 * "Path to outputs" (Phase 2, release 1): the claims lint scans only `app` and `components`, so each copy object this
 * release adds to `lib/*\/copy.ts` is run through `assertNoClaims` here. Each copy-adding task adds one `it` below.
 */
describe('path-to-outputs copy has no claims (SRS 7.5.3)', () => {
  it('the working-report term and its definition hold no claim', () => {
    assertNoClaims('TERM_WORKING_REPORT', { term: TERM_WORKING_REPORT.term, definition: TERM_WORKING_REPORT.definition });
  });
});
