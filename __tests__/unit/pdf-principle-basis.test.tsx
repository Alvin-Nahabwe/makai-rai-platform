import { describe, it, expect } from 'vitest';
import { ReportPdf } from '@/lib/pdf/ReportPdf';
import { extractText } from '../helpers/extractText';
import type { ReportData } from '@/types/domain';

/**
 * Content-audit item 17, PDF half.
 *
 * The web scorecard now prints "from N maturity questions" beside each
 * principle percentage, because the eight principles are not equally
 * resourced (measured: 18 questions behind Fairness & Non-discrimination,
 * 2 behind Sustainability). The PDF is the artifact organisations actually
 * circulate to funders, ethics committees and boards -- if it keeps showing
 * bare side-by-side percentages, the misreading item 17 exists to prevent
 * survives in the copy that travels furthest.
 *
 * ReportPdf.tsx's own comment says its principle block mirrors
 * `PrincipleScorecard.tsx`. These tests hold it to that.
 */

const PDF_PROPS = (principleScores: unknown) => ({
  reportData: {
    overallScore: 72,
    overallPractices: null,
    completedStages: ['pre-processing'],
    stageScores: {},
    principleScores,
  } as unknown as ReportData,
  projectName: 'Probe Project',
  assessorName: 'Alex Assessor',
  assessmentDate: '2026-08-06',
  frameworkSemver: '3.0.0',
  frameworkPinnedDate: '2026-08-06',
  frameworkContentHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  frameworkDrifted: false,
  evidenceManifest: [],
});

describe('the PDF discloses the principle basis, like the web scorecard', () => {
  it('prints the question count beside a principle percentage', () => {
    const text = extractText(
      ReportPdf(PDF_PROPS({
        'pre-processing': {
          'Sustainability': { maturity: 50, practices: null, basisCount: 2 },
        },
      }) as never),
    );
    expect(text).toContain('50%');
    expect(text).toMatch(/from 2 maturity questions/i);
  });

  it('says "question" singular when the percentage rests on exactly one', () => {
    const text = extractText(
      ReportPdf(PDF_PROPS({
        'pre-processing': {
          'Sustainability': { maturity: 25, practices: null, basisCount: 1 },
        },
      }) as never),
    );
    expect(text).toMatch(/from 1 maturity question(?!s)/i);
  });

  it('says nothing when maturity is absent -- the row already reads "No maturity questions"', () => {
    const text = extractText(
      ReportPdf(PDF_PROPS({
        'pre-processing': {
          'Sustainability': { maturity: null, practices: null, basisCount: 0 },
        },
      }) as never),
    );
    expect(text).toContain('No maturity questions');
    expect(text).not.toMatch(/from 0 maturity/i);
  });

  it('says nothing for an assessment stored before basisCount existed', () => {
    // Persisted reportData from before this field shipped has no basisCount.
    // Rendering "from 0 maturity questions" over a real percentage would be a
    // confident false statement about the reader's own completed assessment.
    const text = extractText(
      ReportPdf(PDF_PROPS({
        'pre-processing': {
          'Sustainability': { maturity: 50, practices: null },
        },
      }) as never),
    );
    expect(text).toContain('50%');
    expect(text).not.toMatch(/maturity question/i);
  });
});
