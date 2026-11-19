import { describe, expect, it } from 'vitest';
import {
  CONTROLS_AFTER_APPROVAL, DRAFT_PROJECT_MARK, NOT_RECORDED_YET, NOT_SEALED, NO_RISK_AREA_GROUP, REMOVED_QUESTION_GROUP, TYPED_AT_ISSUE, draftLine, draftReviewLine,
} from '@/lib/documents/copy';
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

  it('the draft document copy holds no claim (Task 5)', () => {
    assertNoClaims('documents draft copy', {
      NOT_RECORDED_YET, TYPED_AT_ISSUE, NOT_SEALED, CONTROLS_AFTER_APPROVAL, DRAFT_PROJECT_MARK,
      none: draftReviewLine('Pre-processing', null, null),
      open: draftReviewLine('Pre-processing', 'Pre-processing review 1', null),
      lastSealed: draftReviewLine('Pre-processing', null, 'Pre-processing review 1'),
      draftLine: draftLine('2026-11-19T14:05:09.000Z'),
    });
  });

  it('the page 1 group headings hold no claim (Task 7)', () => {
    assertNoClaims('working report page 1 headings', { NO_RISK_AREA_GROUP, REMOVED_QUESTION_GROUP });
  });

  it('the draft line prints the platform zone, as the design fixes it', () => {
    expect(draftLine('2026-11-19T14:05:09.000Z')).toBe('Draft · from answers as of 19 Nov 2026, 17:05 EAT');
  });
});
