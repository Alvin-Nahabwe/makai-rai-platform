import { describe, it, expect } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { provisionalScoreNote } from '@/lib/report/provenance';
import { ReportSummary } from '@/components/report/ReportSummary';
import { ReportPdf } from '@/lib/pdf/ReportPdf';
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
function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && node !== null && 'props' in node) {
    return extractText((node as ReactElement<{ children?: ReactNode }>).props?.children ?? null);
  }
  return '';
}

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
};

const REPORT_DATA = {
  overallScore: 72,
  completedStages: ['pre-processing', 'in-processing', 'post-processing'],
  principleScores: { 'Transparency & Explainability': 80 },
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
});
