import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { DecisionSlotProps } from '@/components/question/DecisionSlot';
import { questionsInStage, runningContent } from '@/lib/content/loader';
import { QUESTION_COPY } from '@/lib/question/copy';
import { stageFixture } from '../helpers/stageFixture';

/**
 * The decision seam (coordinator's ruling of 15 November 2026, lane 2 accepted): the page renders the decision through
 * components/question/DecisionSlot.tsx with EXACTLY the props of lane 2's DecisionCard, and renders none of the decision's
 * own parts itself. Here the slot is mocked to record its props, so what the page renders around it is the page's alone.
 */
const slotProps: DecisionSlotProps[] = [];
vi.mock('@/components/question/DecisionSlot', () => ({
  DecisionSlot: (p: DecisionSlotProps) => { slotProps.push(p); return <div data-slot-mock />; },
}));
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), useRouter: () => ({ refresh() {} }), usePathname: () => '/x' }));
vi.mock('@/components/suggestions/SuggestedControls', async (original) => ({
  ...(await original<typeof import('@/components/suggestions/SuggestedControls')>()),
  SuggestedControls: () => null,
}));
vi.mock('@/components/findings/QuestionFindingLink', () => ({ QuestionFindingLink: () => null }));
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: vi.fn() }));
vi.mock('@/lib/auth/context', () => ({ requireOrgContextFor: vi.fn() }));
vi.mock('@/lib/question/panel', () => ({ loadQuestionPanel: vi.fn() }));

const { QuestionPanelRegions } = await import(
  '@/app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]/page'
);

const running = runningContent();
const inStage = questionsInStage(running, 'pre-processing');
const q = (id: string) => running.questions.get(id)!;
const STAGE_HREF = '/orgs/acme-health/projects/p1/stages/pre-processing';
const PANEL: QuestionPanelData = {
  orgSlug: 'acme-health', projectId: 'p1', projectArchived: false, stage: 'pre-processing',
  question: q('Q-PP-04'), runningQuestion: q('Q-PP-04'), position: { index: 3, total: inStage.length, previousId: 'Q-PP-03', nextId: 'Q-PP-05' },
  current: null, historyCount: 0, seals: [],
  reasonCodes: [], members: [], viewer: { userId: 'u1', name: 'Amina N.', role: 'assessor' },
  canWrite: true, canRaiseFinding: true, lastOwnSaveDate: null, openFinding: null, gateAnswer: null,
  contentSemver: '0.0.1-fixture', orgId: 'o1',
};
const render = async (data: QuestionPanelData, stage = stageFixture({ openFindings: { 'Q-PP-04': 2 } })) =>
  renderToStaticMarkup(await QuestionPanelRegions({ data, stage }));

beforeEach(() => { slotProps.length = 0; });

describe('the page around the decision slot', () => {
  it('for a person who may record, the page renders no "Current decision", no answer form, no withdraw and no way on of its own: the slot holds them', async () => {
    const html = await render(PANEL);
    expect(html).toContain('<div data-slot-mock="true">');
    for (const s of ['data-region="current-decision"', 'data-region="answer-form"', 'data-region="way-on"', QUESTION_COPY.headings.current, QUESTION_COPY.headings.record, '<form'])
      expect(html, s).not.toContain(s);
    expect(readFileSync('app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]/page.tsx', 'utf8'))
      .not.toMatch(/import \{[^}]*\b(DecisionForm|WithdrawDecision)\b/);
  });

  it('the slot gets the panel, the stage page, this question\'s open findings and the next question with its place counted as position.index counts', async () => {
    await render(PANEL);
    expect(slotProps).toHaveLength(1);
    const [p] = slotProps;
    expect(Object.keys(p).sort()).toEqual(['data', 'next', 'openFindingsOnQuestion', 'stageHref']);
    expect(p.data).toBe(PANEL);
    expect(p.stageHref).toBe(STAGE_HREF);
    expect(p.openFindingsOnQuestion).toBe(2);
    expect(p.next).toEqual({ questionId: 'Q-PP-05', text: q('Q-PP-05').text, href: `${STAGE_HREF}/questions/Q-PP-05`, number: 5, total: inStage.length });
  });

  it('next.number is the next question\'s place among ALL the stage\'s questions, switched off or not: after the personal data question at No it is Q-PP-15, number 16', async () => {
    const gate = q('Q-PP-GATE-SENSITIVE');
    const at = inStage.findIndex((x) => x.id === gate.id);
    await render({ ...PANEL, question: gate, runningQuestion: gate, gateAnswer: 'no', position: { index: at, total: inStage.length, previousId: 'Q-PP-12', nextId: 'Q-PP-15' } });
    expect(slotProps[0].next).toMatchObject({ questionId: 'Q-PP-15', number: inStage.findIndex((x) => x.id === 'Q-PP-15') + 1 });
    expect(slotProps[0].next!.number).toBe(16);
    // The number matches what that question's own page shows: the panel's index + 1 for it.
    expect(inStage[slotProps[0].next!.number - 1].id).toBe('Q-PP-15');
  });

  it('on the stage\'s last question next is null; rendered without the stage (unit tests only: the page refuses that) the open findings are 0; a next id the content lacks throws naming it', async () => {
    await render({ ...PANEL, position: { index: inStage.length - 1, total: inStage.length, previousId: 'Q-PP-22', nextId: null } });
    expect(slotProps[0].next).toBeNull();
    slotProps.length = 0;
    renderToStaticMarkup(await QuestionPanelRegions({ data: PANEL }));
    expect(slotProps[0].openFindingsOnQuestion).toBe(0);
    await expect(render({ ...PANEL, position: { ...PANEL.position, nextId: 'Q-NOPE-99' } })).rejects.toThrow(/Q-NOPE-99/);
  });
});
