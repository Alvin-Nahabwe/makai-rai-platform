import { describe, expect, it } from 'vitest';
import {
  CONTROLS_AFTER_APPROVAL, DRAFT_PROJECT_MARK, NOT_RECORDED_YET, NOT_SEALED, NO_RISK_AREA_GROUP, REMOVED_QUESTION_GROUP, TYPED_AT_ISSUE, WORKING_REPORT_PAGE, WORKING_REPORT_TITLE, draftLine, draftReviewLine,
} from '@/lib/documents/copy';
import { STAGE_END_COPY } from '@/lib/question/end/copy';
import { PROJECT_COPY } from '@/lib/project/copy';
import { REVIEW_COPY } from '@/lib/review/copy';
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

  it('page 1 of the working report PDF holds no claim (Task 8)', () => {
    assertNoClaims('working report PDF copy', {
      WORKING_REPORT_TITLE, ...WORKING_REPORT_PAGE, omitted: WORKING_REPORT_PAGE.omitted(1), omittedMany: WORKING_REPORT_PAGE.omitted(3),
    });
  });

  it('the working report page and its rail entry hold no claim (Task 10)', () => {
    const W = PROJECT_COPY.workingReport;
    assertNoClaims('working report page copy', {
      title: PROJECT_COPY.titles.workingReport, railLink: W.railLink, downloadHeading: W.downloadHeading, downloadAll: W.downloadAll,
      partsHeading: W.partsHeading, partLink: W.partLink('Data card'), planTitle: W.planTitle('Mitigation plan', 'Pre-processing'),
      placeOfStage: W.placeOf('Pre-processing', null), placeOfQuestion: W.placeOf('Pre-processing', 'Q-PP-01'),
    });
  });

  it('the project page progress, the report link and the what-you-get line hold no claim (Task 12)', () => {
    const O = PROJECT_COPY.overview;
    assertNoClaims('project page progress copy', {
      whatYouGet: O.whatYouGet, openReport: O.openReport, progressName: O.progressName(15, 24),
      nextContinue: O.nextQuestion(16, true), nextView: O.nextQuestion(16, false), doesNotApply: O.doesNotApply,
    });
  });

  it('the seal step and its refusals hold no claim (Task 13)', () => {
    const S = REVIEW_COPY.sealStep;
    assertNoClaims('seal step copy', {
      ask: S.ask, waiting: S.waiting, seal: S.seal, openAndSeal: S.openAndSeal, sealed: S.sealed,
      lostAsk: S.lost(S.ask), lostOpenAndSeal: S.lost(S.openAndSeal), serverAsk: S.server(S.ask), serverOpenAndSeal: S.server(S.openAndSeal),
      numberTakenAsk: S.numberTaken(S.ask), numberTakenOpenAndSeal: S.numberTaken(S.openAndSeal), whatMeansSeal: S.whatMeans('seal'),
    });
  });

  it('the end-of-stage screen and the links to it hold no claim (Task 14)', () => {
    const E = STAGE_END_COPY;
    assertNoClaims('end of stage copy', {
      heading: E.heading, link: E.link, openReport: E.openReport, start: E.start('In-processing'), view: E.view('In-processing'),
      openHeading: E.openHeading, nothingOpen: E.nothingOpen, more: E.more(2), moreOne: E.more(1), title: E.title, whatMeans: E.whatMeans('risk area'),
    });
  });

  it('the draft line prints the platform zone, as the design fixes it', () => {
    expect(draftLine('2026-11-19T14:05:09.000Z')).toBe('Draft · from answers as of 19 Nov 2026, 17:05 EAT');
  });
});
