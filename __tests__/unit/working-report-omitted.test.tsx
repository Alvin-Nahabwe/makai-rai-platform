import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadContent } from '@/lib/content/loader';
import { WORKING_REPORT_PAGE as W } from '@/lib/documents/copy';
import { composeWorkingReport } from '@/lib/documents/render/workingReport';
import type { WorkingReportSummary } from '@/lib/documents/workingReport';
import { stagesThatApply } from '@/lib/project/applicability';
import type { SealStepState } from '@/lib/review/sealStep';
import { fullRecord } from '../helpers/draftRecord';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
const { StageEnd } = await import('@/components/question/StageEnd');

/**
 * Fix wave item 10 (silent-failure audit I3): the line that says how many recorded answers a draft leaves out (their question is no
 * longer in the framework) was printed on page 1 only. A part downloaded alone, and the stage end screen, now say it too: a mitigation
 * plan and the end screen count their own stage's, a card the project's. Nothing is printed when nothing is left out.
 */
const running = loadContent('0.0.1-fixture');
const omitted = { 'pre-processing': 2, 'in-processing': 0, 'post-processing': 1 } as const;
const record = (on: boolean) => ({ ...fullRecord(running), omittedAnswers: on ? 3 : 0, omittedByStage: on ? omitted : { 'pre-processing': 0, 'in-processing': 0, 'post-processing': 0 } });
const textOf = (on: boolean, part: Parameters<typeof composeWorkingReport>[2]) => composeWorkingReport(record(on), running, part).pages.map((p) => p.plainText).join('\n');

describe('a draft document downloaded alone says what it leaves out', () => {
  it('a card counts the project\'s left-out answers; a plan counts its own stage\'s', () => {
    expect(textOf(true, 'data_card')).toContain(W.omitted(3));
    expect(textOf(true, 'model_card')).toContain(W.omitted(3));
    expect(textOf(true, 'mitigation_plan:pre-processing')).toContain(W.omitted(2));
    expect(textOf(true, 'mitigation_plan:post-processing')).toContain(W.omitted(1));
    expect(textOf(true, 'mitigation_plan:in-processing')).not.toMatch(/not shown here/);
  });
  it('nothing left out: no line', () => {
    for (const part of ['data_card', 'model_card', 'mitigation_plan:pre-processing'] as const) expect(textOf(false, part)).not.toMatch(/not shown here/);
  });
});

describe('the stage end screen says what its stage leaves out', () => {
  const summary = (byStage: WorkingReportSummary['omittedByStage']): WorkingReportSummary => ({
    takenAt: '2026-11-19T14:05:09.000Z', controlsShown: false, omittedAnswers: 3, omittedByStage: byStage, nextSteps: [], riskAccepted: [], inPlace: [], doesNotApply: [],
  });
  const render = (stage: 'pre-processing' | 'in-processing', byStage: WorkingReportSummary['omittedByStage']) => renderToStaticMarkup(
    <StageEnd orgSlug="acme" projectId="p1" projectName="Project A" stage={stage} takenAt="2026-11-19T14:05:09.000Z" rows={[]} marks={{}}
      summary={summary(byStage)} applies={stagesThatApply({ stageApplicability: null }, null)} canWrite hasQuestion={() => true}
      sealStep={{ kind: 'hidden' } satisfies SealStepState} />,
  );
  it('its own stage\'s count, and nothing for a stage that leaves none out', () => {
    expect(render('pre-processing', omitted)).toContain(W.omitted(2));
    expect(render('in-processing', omitted)).not.toMatch(/not shown here/);
  });
});
