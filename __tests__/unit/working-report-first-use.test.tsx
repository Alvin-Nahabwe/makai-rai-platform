import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AreaGroup, OpenItem, WorkingReportSummary } from '@/lib/documents/workingReport';
import { CONTROLS_AFTER_APPROVAL, NO_RISK_AREA_GROUP, WORKING_REPORT_PAGE as W } from '@/lib/documents/copy';
import type { Stage } from '@/types/record';
import { Summary } from '@/components/report/WorkingReportView';

/**
 * The working report page's page 1 on screen: the vocabulary's first-use rule for "risk area" and "control" (the controller's
 * ruling on Task 14's review). "working report" itself is defined in the page's own heading (WorkingReportView).
 */
const TAKEN = '2026-11-19T14:05:09.000Z';
const item = (n: number, controls: OpenItem['controls'] = []): OpenItem => ({
  findingId: `f${n}`, stage: 'pre-processing' as Stage, questionId: `Q-${n}`, questionText: `Question ${n}?`, answer: null, title: `Open item ${n}`, alsoAreas: [], controls,
});
const group = (areaId: string | null, areaName: string, items: OpenItem[]): AreaGroup => ({ areaId, areaName, items });
const summary = (nextSteps: AreaGroup[], controlsShown: boolean): WorkingReportSummary => ({
  takenAt: TAKEN, controlsShown, omittedAnswers: 0, nextSteps, riskAccepted: [], inPlace: [], doesNotApply: [],
});
const render = (s: WorkingReportSummary): string => renderToStaticMarkup(<Summary summary={s} headingId="h" />);
const tips = (h: string, id: string): number => (h.match(new RegExp(`data-definition="${id}"`, 'g')) ?? []).length;
const controls = [{ id: 'C-1', name: 'Check the sampling', notebookHref: null }];

describe('the working report page 1: first use of a defined term is defined beside it', () => {
  it('"risk area": the heading of the items raised with no risk area is the term, with its tip; a named area is not', () => {
    const h = render(summary([group(null, NO_RISK_AREA_GROUP, [item(1)])], false));
    expect(tips(h, 'risk-area')).toBe(1);
    expect(h).toMatch(new RegExp(`<h4><span data-term="risk-area">${NO_RISK_AREA_GROUP}</span><span class="ui-term-tip">`));
    expect(tips(render(summary([group('PP-01', 'Bias (PP-01)', [item(1)])], false)), 'risk-area')).toBe(0);
  });

  it('"control" while page 1 hides controls: the line that says they appear later is the first use', () => {
    const h = render(summary([group('PP-01', 'Bias (PP-01)', [item(1)])], false));
    expect(tips(h, 'control')).toBe(1);
    expect(h).toMatch(new RegExp(`<p class="report-muted"><span data-term="control">${CONTROLS_AFTER_APPROVAL.replace(/[()]/g, '\\$&')}</span><span class="ui-term-tip">`));
  });

  it('"control" when page 1 shows them: the first "Suggested controls" is marked once, later ones are not', () => {
    const h = render(summary([group('PP-01', 'Bias (PP-01)', [item(1, controls), item(2, controls)])], true));
    expect(tips(h, 'control')).toBe(1);
    expect(h.match(new RegExp(W.controls, 'g'))).toHaveLength(2);
    expect(h).toMatch(new RegExp(`<span data-term="control">${W.controls}</span><span class="ui-term-tip">`));
  });
});
