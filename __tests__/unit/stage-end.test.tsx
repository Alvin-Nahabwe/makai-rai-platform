import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StatusMarkKind } from '@/components/ui/types';
import type { StageRow } from '@/lib/question/stageList';
import type { AreaGroup, OpenItem, WorkingReportSummary } from '@/lib/documents/workingReport';
import { STAGE_END_COPY } from '@/lib/question/end/copy';
import { REVIEW_COPY } from '@/lib/review/copy';
import { draftLine, NO_RISK_AREA_GROUP, REMOVED_QUESTION_GROUP, WORKING_REPORT_PAGE } from '@/lib/documents/copy';
import { stagesThatApply } from '@/lib/project/applicability';
import type { SealStepState } from '@/lib/review/sealStep';
import type { Stage } from '@/types/record';
import { contentWith, OWNER_TABLE } from '../helpers/contentWith';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
const { StageEnd } = await import('@/components/question/StageEnd');

/**
 * The end-of-stage screen (design G3): where the project stands, then the report first, the next stage second and the seal step
 * for the viewer's role. Rendered from data without a database; the save that lands on it is driven by e2e/stage-end.spec.ts.
 */
const E = STAGE_END_COPY;
const TAKEN = '2026-11-19T14:05:09.000Z';
const ALL = stagesThatApply({ stageApplicability: null }, null);

const row = (questionId: string, kind: StageRow['kind']): StageRow => ({
  questionId, questionType: 'likert-5', text: `Question ${questionId}?`, moduleId: 'M1', moduleTitle: 'Problem Formulation', statusText: 'x',
  versionNumber: null, declaredDate: null, openFindings: 0, changedSinceSeal: false, reworded: false, inPlace: null, kind, evidenceCount: 0,
});
const ROWS = [row('Q-PP-01', 'done'), row('Q-PP-02', 'done'), row('Q-PP-03', 'none')];
const MARKS: Record<string, StatusMarkKind> = { 'Q-PP-01': 'done', 'Q-PP-02': 'done', 'Q-PP-03': 'no_decision' };

const item = (n: number, stage: Stage, controls: OpenItem['controls'] = []): OpenItem => ({
  findingId: `f${n}`, stage, questionId: `Q-${n}`, questionText: `Question ${n}?`, answer: null, title: `Open item ${n}`, alsoAreas: [], controls,
});
const group = (areaName: string, items: OpenItem[]): AreaGroup => ({ areaId: areaName, areaName, items });
const summary = (nextSteps: AreaGroup[], controlsShown = false): WorkingReportSummary => ({
  takenAt: TAKEN, controlsShown, omittedAnswers: 0, omittedByStage: { 'pre-processing': 0, 'in-processing': 0, 'post-processing': 0 }, nextSteps, riskAccepted: [], inPlace: [], doesNotApply: [],
});

type Over = Partial<Parameters<typeof StageEnd>[0]>;
const render = (over: Over = {}): string => renderToStaticMarkup(
  <StageEnd
    orgSlug="acme" projectId="p1" projectName="Project A" stage="pre-processing" takenAt={TAKEN} rows={ROWS} marks={MARKS} summary={summary([])} applies={ALL}
    canWrite hasQuestion={() => true} sealStep={{ kind: 'hidden' } satisfies SealStepState} {...over}
  />,
);

describe('StageEnd (design G3)', () => {
  it('leads with where the project stands and the draft line, then the stage\'s tally in words', () => {
    const h = render();
    expect(h).toMatch(/<h1[^>]*>Here is where your project stands<\/h1>/);
    expect(h).toContain(draftLine(TAKEN));
    expect(h.indexOf(draftLine(TAKEN))).toBeGreaterThan(h.indexOf('Here is where your project stands'));
    expect(h).toContain('3 questions');
    expect(h).toContain('2\u00A0done');
    expect(h).toContain('1\u00A0no');
  });

  it('the primary action is Open the working report; it is the only primary button', () => {
    const h = render();
    // With nothing more to list, the action holds the page's first "working report", marked (its tip follows the button).
    expect(h).toMatch(/<a class="ui-button ui-button--primary" href="\/orgs\/acme\/projects\/p1\/report">Open the <span data-term="working-report">working report<\/span><\/a>/);
    expect(h.match(/ui-button--primary/g)).toHaveLength(1);
  });

  it('a person who may record is offered Start <next stage>, the next stage in order', () => {
    const h = render();
    expect(h).toMatch(/<a class="ui-button ui-button--secondary" href="\/orgs\/acme\/projects\/p1\/stages\/in-processing">Start <span data-term="stage-2">In-processing<\/span><\/a>/);
    // The vocabulary defines the stage's name at first use, in the same line as the link.
    expect(h).toMatch(/<\/a> <span class="ui-definition" data-definition="stage-2">Training and testing the model/);
    expect(render({ stage: 'in-processing' })).toContain('href="/orgs/acme/projects/p1/stages/post-processing"');
  });

  it('ruling O1: a role that cannot record is offered View <next stage> at the same address, never Start', () => {
    const h = render({ canWrite: false });
    expect(h).toContain('href="/orgs/acme/projects/p1/stages/in-processing"');
    expect(h).toMatch(/>View <span data-term="stage-2">In-processing<\/span><\/a>/);
    expect(h).not.toMatch(/>Start /);
  });

  it('after the last stage there is no next-stage link', () => {
    const h = render({ stage: 'post-processing' });
    expect(h).not.toMatch(/>(Start|View) /);
  });

  it('G7 active: for a concept project nothing follows Pre-processing, and Post-processing is never offered after In-processing for a development project', () => {
    const active = contentWith({ stageApplicability: OWNER_TABLE });
    const concept = stagesThatApply(active, 'concept');
    expect(render({ applies: concept })).not.toMatch(/>(Start|View) /);
    expect(render({ applies: concept, stage: 'in-processing' })).not.toMatch(/>(Start|View) /);
    const development = stagesThatApply(active, 'development');
    expect(render({ applies: development })).toContain('Start <span data-term="stage-2">In-processing</span>');
    expect(render({ applies: development, stage: 'in-processing' })).not.toContain('Post-processing');
  });

  it('StageEnd offers no Start Post-processing for a concept project when G7 is active', () => {
    const concept = stagesThatApply(contentWith({ stageApplicability: OWNER_TABLE }), 'concept');
    for (const stage of ['pre-processing', 'in-processing'] as const) expect(render({ applies: concept, stage })).not.toContain('Post-processing');
  });

  it('lists the first three of this stage\'s open items under page 1\'s groups, and says how many more the report holds', () => {
    const s = summary([
      group('Bias (PP-01)', [item(1, 'pre-processing'), item(2, 'in-processing'), item(3, 'pre-processing')]),
      group('Consent (PP-02)', [item(4, 'pre-processing'), item(5, 'pre-processing'), item(6, 'pre-processing')]),
    ]);
    const h = render({ summary: s });
    for (const n of [1, 3, 4]) expect(h).toContain(`Open item ${n}`);
    for (const n of [2, 5, 6]) expect(h).not.toContain(`Open item ${n}<`);
    expect(h.indexOf('Bias (PP-01)')).toBeLessThan(h.indexOf('Open item 1'));
    expect(h.indexOf('Open item 3')).toBeLessThan(h.indexOf('Consent (PP-02)'));
    expect(h).toContain(E.more(2));
  });

  it('with nothing open in the stage it says so, and with no more items it adds no "more" line', () => {
    expect(render()).toContain(E.nothingOpen);
    const h = render({ summary: summary([group('Bias (PP-01)', [item(1, 'pre-processing')])]) });
    expect(h).not.toContain(E.nothingOpen);
    expect(h).not.toContain('more.');
  });

  it('controls show only when page 1 shows them (controlsShown), each item with its own', () => {
    const controls = [{ id: 'C-1', name: 'Check the sampling', notebookHref: null }];
    const s = (shown: boolean) => summary([group('Bias (PP-01)', [item(1, 'pre-processing', shown ? controls : [])])], shown);
    expect(render({ summary: s(true) })).toContain('Check the sampling (C-1)');
    const hidden = render({ summary: s(false) });
    expect(hidden).not.toContain('data-control');
    expect(hidden).not.toContain('Check the sampling');
    // Even if controls were present on an item, controlsShown false hides them.
    const forced = render({ summary: { ...s(true), controlsShown: false } });
    expect(forced).not.toContain('Check the sampling');
  });

  it('shows the seal step for the role: ask for an Assessor, nothing for hidden, a status line for a Viewer', () => {
    expect(render({ sealStep: { kind: 'ask' } })).toContain(REVIEW_COPY.sealStep.ask);
    expect(render()).not.toContain('seal-step');
    expect(render({ sealStep: { kind: 'waiting', reviewId: 'r1' }, canWrite: false })).toContain(REVIEW_COPY.sealStep.waiting);
  });

  it('a Viewer\'s screen has no button of its own: the report and the stage are links', () => {
    const h = render({ canWrite: false });
    expect(h).not.toMatch(/<button(?![^>]*ui-term-tip__button)/);
    expect(h).toContain('Open the <span data-term="working-report">working report</span>');
  });

  it('anti-goal 4: an open item whose question is no longer in the framework is text, not a link (it would open the not-found page)', () => {
    const gone = (n: number, areaId: string | null): AreaGroup => ({ areaId, areaName: areaId ?? REMOVED_QUESTION_GROUP, items: [item(n, 'pre-processing')] });
    const known = (stage: Stage, questionId: string): boolean => stage === 'pre-processing' && questionId === 'Q-1';
    const h = render({
      summary: summary([gone(2, null), gone(3, 'Bias (PP-01)'), group('Consent (PP-02)', [item(1, 'pre-processing')])]),
      hasQuestion: known,
    });
    // The item on a known question links to it; the two on questions the running content lacks (one grouped under a risk area) do not.
    expect(h).toMatch(/<a [^>]*href="\/orgs\/acme\/projects\/p1\/stages\/pre-processing\/questions\/Q-1"[^>]*>Open item 1<\/a>/);
    expect(h).toContain('Open item 2');
    expect(h).toContain('Open item 3');
    expect(h).not.toContain('questions/Q-2');
    expect(h).not.toContain('questions/Q-3');
    expect(h).toContain(REMOVED_QUESTION_GROUP);
  });

  it('a question that exists only in another stage is not linked either (the question page answers not-found for a stage that is not its own)', () => {
    const h = render({ summary: summary([group('Bias (PP-01)', [item(1, 'pre-processing')])]), hasQuestion: () => false });
    expect(h).toContain('Open item 1');
    expect(h).not.toContain('questions/Q-1');
  });

  describe('first use of a defined term (the vocabulary rule), defined with a TermTip beside the first use', () => {
    const tips = (h: string, id: string): number => (h.match(new RegExp(`data-definition="${id}"`, 'g')) ?? []).length;
    const termAt = (h: string, id: string): string => h.slice(h.indexOf(`data-term="${id}"`));

    it('"working report": the first use is the "more are listed" line when there is one, and the action when there is not', () => {
      const many = summary([group('Bias (PP-01)', [1, 2, 3, 4].map((n) => item(n, 'pre-processing')))]);
      const h = render({ summary: many });
      expect(tips(h, 'working-report')).toBe(1);
      expect(termAt(h, 'working-report').startsWith(`data-term="working-report">${E.more(1)}</span><span class="ui-term-tip">`)).toBe(true);
      // The action's label, after it, is not marked again.
      expect(h.match(/data-term="working-report"/g)).toHaveLength(1);
      const none = render();
      expect(tips(none, 'working-report')).toBe(1);
      expect(none).toMatch(/<a class="ui-button ui-button--primary"[^>]*>Open the <span data-term="working-report">working report<\/span><\/a>\s*<span class="ui-term-tip">/);
      expect(none.indexOf('data-definition="working-report"')).toBeGreaterThan(none.indexOf('Open the'));
    });

    it('"risk area": the heading of the items the team raised with no risk area is marked, and its tip is in that heading', () => {
      const h = render({ summary: summary([{ areaId: null, areaName: NO_RISK_AREA_GROUP, items: [item(1, 'pre-processing')] }]) });
      expect(tips(h, 'risk-area')).toBe(1);
      expect(h).toMatch(new RegExp(`<h3><span data-term="risk-area">${NO_RISK_AREA_GROUP}</span><span class="ui-term-tip">.*?</span></h3>`));
      // A named area is the framework's own name, not the term.
      expect(tips(render({ summary: summary([group('Bias (PP-01)', [item(1, 'pre-processing')])]) }), 'risk-area')).toBe(0);
    });

    it('"control": the first "Suggested controls" is marked once and later ones are not; none when page 1 hides them', () => {
      const controls = [{ id: 'C-1', name: 'Check the sampling', notebookHref: null }];
      const shown = render({ summary: summary([group('Bias (PP-01)', [item(1, 'pre-processing', controls), item(2, 'pre-processing', controls)])], true) });
      expect(tips(shown, 'control')).toBe(1);
      expect(shown.match(new RegExp(WORKING_REPORT_PAGE.controls, 'g'))).toHaveLength(2);
      expect(shown).toMatch(new RegExp(`<span data-term="control">${WORKING_REPORT_PAGE.controls}</span><span class="ui-term-tip">`));
      expect(tips(render({ summary: summary([group('Bias (PP-01)', [item(1, 'pre-processing')])]) }), 'control')).toBe(0);
    });
  });
});
