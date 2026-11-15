import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionPanelData } from '@/lib/question/panel';
import { runningContent } from '@/lib/content/loader';
import { QUESTION_COPY } from '@/lib/question/copy';

/**
 * The decision slot (components/question/DecisionSlot.tsx), now lane 2's DecisionCard: for a person who may record, the
 * one answer-form card with the way on inside it; for a reader, nothing.
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

describe('DecisionSlot (lane 2\'s card)', () => {
  it('renders nothing for a reader, archived or not', () => {
    for (const data of [{ ...DATA, canWrite: false }, { ...DATA, canWrite: false, projectArchived: true }]) {
      expect(renderToStaticMarkup(<DecisionSlot data={data} next={NEXT} stageHref={STAGE_HREF} openFindingsOnQuestion={0} />)).toBe('');
    }
  });

  it('review M-A4: a writer who may not raise a finding and has no open finding gets no Findings section, so no empty heading', () => {
    const html = renderToStaticMarkup(<DecisionSlot data={{ ...DATA, canRaiseFinding: false, openFinding: null }} next={NEXT} stageHref={STAGE_HREF} openFindingsOnQuestion={0} />);
    expect(html).not.toContain('data-region="finding-link"');
    expect(html).not.toContain(`>${QUESTION_COPY.headings.findings}</h2>`);
  });

  it('for a writer: one answer-form card (no current-decision region), the form, then the way on to the next question in words and All questions inside it', () => {
    const html = renderToStaticMarkup(<DecisionSlot data={DATA} next={NEXT} stageHref={STAGE_HREF} openFindingsOnQuestion={0} />);
    const at = (s: string) => html.indexOf(s);
    expect([at('data-region="answer-form"'), at('<form'), at('Save decision'), at(`href="${NEXT.href}"`)].every((n, i, a) => n >= 0 && (i === 0 || n > a[i - 1])), html).toBe(true);
    expect(html).not.toContain('data-region="current-decision"');
    expect(html).not.toContain('data-region="way-on"');
    expect(html).toContain('Next: Next words?');
    expect(html).toContain('Question 5 of 24');
    const last = renderToStaticMarkup(<DecisionSlot data={DATA} next={null} stageHref={STAGE_HREF} openFindingsOnQuestion={0} />);
    expect(last).toContain(QUESTION_COPY.foot.last);
    expect(last).toContain(`href="${STAGE_HREF}"`);
    expect(last).not.toContain('Question 5 of 24');
  });
});
