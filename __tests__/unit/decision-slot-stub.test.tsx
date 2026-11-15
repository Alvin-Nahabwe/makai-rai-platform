import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionPanelData } from '@/lib/question/panel';
import { runningContent } from '@/lib/content/loader';
import { QUESTION_COPY } from '@/lib/question/copy';

/**
 * The decision slot's STUB (components/question/DecisionSlot.tsx), until lane 2's DecisionCard merges: for a person who
 * may record, what the page rendered for them before (the current decision, the answer form with WithdrawDecision, the
 * way on); for a reader, nothing, as the card will.
 */
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), useRouter: () => ({ refresh() {} }), usePathname: () => '/x' }));
vi.mock('@/components/evidence/EvidenceBlock', () => ({ EvidenceBlock: () => null }));
const { DecisionSlot } = await import('@/components/question/DecisionSlot');

const q = runningContent().questions.get('Q-PP-04')!;
const DATA: QuestionPanelData = {
  orgSlug: 'acme-health', projectId: 'p1', projectArchived: false, stage: 'pre-processing',
  question: q, runningQuestion: q, position: { index: 3, total: 24, previousId: 'Q-PP-03', nextId: 'Q-PP-05' },
  current: null, historyCount: 0, seals: [], reasonCodes: [], members: [], viewer: { userId: 'u1', name: 'Amina N.', role: 'assessor' },
  canWrite: true, canRaiseFinding: true, lastOwnSaveDate: null, openFinding: null, gateAnswer: null, contentSemver: '0.0.1-fixture', orgId: 'o1',
};
const STAGE_HREF = '/orgs/acme-health/projects/p1/stages/pre-processing';
const NEXT = { questionId: 'Q-PP-05', text: 'Next words?', href: `${STAGE_HREF}/questions/Q-PP-05`, number: 5, total: 24 };

describe('DecisionSlot (stub)', () => {
  it('returns null for a reader, archived or not', () => {
    for (const data of [{ ...DATA, canWrite: false }, { ...DATA, canWrite: false, projectArchived: true }]) {
      expect(DecisionSlot({ data, next: NEXT, stageHref: STAGE_HREF, openFindingsOnQuestion: 0 })).toBeNull();
    }
  });

  it('review M-A4: a writer who may not raise a finding and has no open finding gets no Findings section, so no empty heading', () => {
    const html = renderToStaticMarkup(<DecisionSlot data={{ ...DATA, canRaiseFinding: false, openFinding: null }} next={NEXT} stageHref={STAGE_HREF} openFindingsOnQuestion={0} />);
    expect(html).not.toContain('data-region="finding-link"');
    expect(html).not.toContain(`>${QUESTION_COPY.headings.findings}</h2>`);
  });

  it('for a writer: the current decision, the answer form, then the way on to the next question in words and All questions', () => {
    const html = renderToStaticMarkup(<DecisionSlot data={DATA} next={NEXT} stageHref={STAGE_HREF} openFindingsOnQuestion={0} />);
    const at = (s: string) => html.indexOf(s);
    expect([at('data-region="current-decision"'), at('data-region="answer-form"'), at('<form'), at('data-region="way-on"')].every((n, i, a) => n >= 0 && (i === 0 || n > a[i - 1])), html).toBe(true);
    expect(html).toContain(`<a href="${NEXT.href}">${QUESTION_COPY.foot.next('Next words?')}</a><a href="${STAGE_HREF}">All questions</a>`);
    const last = renderToStaticMarkup(<DecisionSlot data={DATA} next={null} stageHref={STAGE_HREF} openFindingsOnQuestion={0} />);
    expect(last).toContain(`<span>${QUESTION_COPY.foot.last}</span><a href="${STAGE_HREF}">All questions</a>`);
  });
});
