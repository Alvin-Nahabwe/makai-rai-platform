import { describe, it, expect } from 'vitest';
import { provisionalScoreNote, formatScoringLine } from '@/lib/report/provenance';
import { ReportSummary } from '@/components/report/ReportSummary';
import { ReportPdf } from '@/lib/pdf/ReportPdf';
import { extractText } from '../helpers/extractText';
import type { ReportData } from '@/types/domain';

/**
 * ENG-05. The Phase 1 design spec required that "the score renders with an
 * explicit provisional marker in UI and PDF until D-020 and D-031 both
 * close", and register row D-037 recorded that marker as SHIPPED. It never
 * existed on any surface — the row asserted a fact that was not true, which
 * is the laundered-deferral failure the register exists to prevent.
 *
 * The marker is required because VISION_AND_PLAN §4.1 calls the single
 * percentage "an opaque absolute" with "no defensible basis for collapsing
 * 21 areas into one percentage", and directs that it be "a rollup, not the
 * headline". Until the maturity rubric is derived, the honest position is to
 * show the number and say plainly what it is not.
 *
 * Both surfaces must draw the copy from ONE source. Two independent
 * implementations of one rule is exactly how ENG-03 was born.
 */

const BASE_SUMMARY_PROPS = {
  overallScore: 72,
  overallLevel: 'developing' as const,
  completedStagesCount: 3,
  strengthsCount: 4,
  attentionsCount: 5,
  gapsCount: 2,
  activeModifiersCount: 0,
  levelLabels: { developing: 'Developing' },
  levelColors: { developing: '#f59e0b' },
  frameworkSemver: '3.0.0',
  frameworkPinnedDate: '2026-08-06',
  frameworkContentHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  frameworkDrifted: false,
  // Task 6: ReportSummaryProps.overallPractices is required (mirrors
  // ReportData.overallPractices, also required). This suite is not about
  // practice coverage, so null keeps every test here on the "absent"
  // branch rather than picking up an incidental non-null value.
  overallPractices: null,
};

// Task 7: `ReportPdf` now also destructures `overallPractices` and
// `stageScores` off `reportData` (previously only `overallScore`,
// `completedStages`, `principleScores`) to render the second, independent
// reading. This fixture is `as unknown as ReportData` -- a full type-erasure
// cast that tsc cannot check -- so a missing field here is a RUNTIME crash,
// not a compile error: `ReportPdf` reads `overallPractices.inPlace`
// unconditionally once `overallPractices !== null`, and `undefined !== null`
// is `true`. Both added as `null`/`{}` (the "nothing to show" shape), since
// this suite is about the provisional-score marker, not practice coverage.
//
// Final whole-branch review, F6: `principleScores` used to be
// `{ 'Transparency & Explainability': 80 }` -- a bare number keyed by
// PRINCIPLE, the shape from before the split. The real shape (types/
// domain.ts) is keyed by STAGE, each value a map of principle -> EvidenceScore.
// `ReportPdf` reads `principleScores[stage]` for each of `completedStages`
// (lib/pdf/ReportPdf.tsx), so the stale key missed every lookup and the PDF's
// "Principle Scores" section rendered with a heading and nothing under it,
// silently, on every test in this file. Corrected to the real shape, keyed
// by the same three stages `completedStages` names.
const REPORT_DATA = {
  overallScore: 72,
  overallPractices: null,
  completedStages: ['pre-processing', 'in-processing', 'post-processing'],
  stageScores: {},
  principleScores: {
    'pre-processing': { 'Transparency & Explainability': { maturity: 80, practices: null } },
    'in-processing': { 'Transparency & Explainability': { maturity: 80, practices: null } },
    'post-processing': { 'Transparency & Explainability': { maturity: 80, practices: null } },
  },
} as unknown as ReportData;

describe('provisionalScoreNote — the copy itself', () => {
  it('says the score is provisional', () => {
    expect(provisionalScoreNote()).toMatch(/provisional/i);
  });

  it('states WHY, rather than only labelling it', () => {
    // A bare "provisional" badge tells a reader nothing actionable. The
    // vision's objection is specific: the weighting collapsing 21 areas into
    // one number has no recorded derivation.
    expect(provisionalScoreNote()).toMatch(/weight|derivation|derived/i);
  });

  it('directs the reader to the per-area detail that is defensible', () => {
    expect(provisionalScoreNote()).toMatch(/area/i);
  });
});

describe('the marker reaches both surfaces, from one source', () => {
  it('renders on the HTML report', () => {
    expect(extractText(ReportSummary(BASE_SUMMARY_PROPS))).toContain(provisionalScoreNote());
  });

  it('renders on the PDF', () => {
    const pdfProps = {
      reportData: REPORT_DATA,
      projectName: 'Probe Project',
      assessorName: 'Alex Assessor',
      assessmentDate: '2026-08-06',
      frameworkSemver: '3.0.0',
      frameworkPinnedDate: '2026-08-06',
      frameworkContentHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      frameworkDrifted: false,
      evidenceManifest: [],
    };
    expect(extractText(ReportPdf(pdfProps as never))).toContain(provisionalScoreNote());
  });

  /**
   * F6 regression pin. `REPORT_DATA.principleScores` used to be keyed by
   * principle name (a bare number), while `ReportPdf` looks it up keyed by
   * STAGE (`principleScores[stage]`) -- every lookup missed and the
   * "Principle Scores" section rendered its heading over nothing. This
   * asserts the section actually carries the principle name and a reading,
   * not just that the PAGE overall renders (the sibling test above, which
   * passed throughout -- the blank section was invisible to it).
   */
  it('renders the Principle Scores section with real content, not silently blank', () => {
    const pdfProps = {
      reportData: REPORT_DATA,
      projectName: 'Probe Project',
      assessorName: 'Alex Assessor',
      assessmentDate: '2026-08-06',
      frameworkSemver: '3.0.0',
      frameworkPinnedDate: '2026-08-06',
      frameworkContentHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      frameworkDrifted: false,
      evidenceManifest: [],
    };
    const text = extractText(ReportPdf(pdfProps as never));
    expect(text).toContain('Principle Scores');
    expect(text).toContain('Transparency & Explainability');
    expect(text).toContain('80');
  });
});

describe('the scoring-methodology line reaches both surfaces', () => {
  it('renders on the HTML report', () => {
    const text = extractText(ReportSummary({ ...BASE_SUMMARY_PROPS, scoringVersion: '4.1.0' } as never));
    expect(text).toContain(formatScoringLine('4.1.0'));
  });

  it('renders the unrecorded variant on a report that predates versioning', () => {
    const text = extractText(ReportSummary(BASE_SUMMARY_PROPS as never));
    expect(text).toContain(formatScoringLine(undefined));
  });

  it('renders on the PDF', () => {
    const pdfProps = {
      reportData: { ...REPORT_DATA, scoringVersion: '4.1.0' },
      projectName: 'Probe Project', assessorName: 'Alex Assessor', assessmentDate: '2026-08-06',
      frameworkSemver: '3.0.0', frameworkPinnedDate: '2026-08-06',
      frameworkContentHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      frameworkDrifted: false, evidenceManifest: [],
    };
    expect(extractText(ReportPdf(pdfProps as never))).toContain(formatScoringLine('4.1.0'));
  });
});

