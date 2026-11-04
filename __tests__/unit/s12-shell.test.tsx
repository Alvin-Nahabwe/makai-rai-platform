import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';

/**
 * The S-12 shell (contract "The S-12 shell"): the page resolves the identity and the organisation, loads the
 * panel and renders seven regions in a fixed DOM order. The identity, the context and the loader are
 * mocked; every slot component records the props it is given, so the wiring is checked and not only the
 * markup (the slots themselves render nothing until their contributors fill them).
 */
const propsSeen: Record<string, unknown> = {};
const slot = (name: string) => (props: unknown) => { propsSeen[name] = props; return null; };
vi.mock('@/components/question/QuestionContent', () => ({ QuestionContent: slot('QuestionContent') }));
vi.mock('@/components/decision/CurrentDecision', () => ({ CurrentDecision: slot('CurrentDecision') }));
vi.mock('@/components/review/SealNote', () => ({ SealNote: slot('SealNote') }));
// DEC-b's answer form is real here: it renders the evidence block inside its own client tree (EVD RE-1), so the wiring
// of the block is checked through it. Its router is the only part of next/navigation a static render cannot provide.
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), useRouter: () => ({ refresh() {} }), usePathname: () => '/x' }));
vi.mock('@/components/evidence/EvidenceBlock', () => ({ EvidenceBlock: slot('EvidenceBlock') }));
vi.mock('@/components/findings/QuestionFindingLink', () => ({ QuestionFindingLink: slot('QuestionFindingLink') }));
vi.mock('@/components/suggestions/SuggestedControls', () => ({ SuggestedControls: slot('SuggestedControls') }));

const requireIdentity = vi.fn();
const requireOrgContextFor = vi.fn();
const loadQuestionPanel = vi.fn();
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: (...a: unknown[]) => requireIdentity(...a) }));
vi.mock('@/lib/auth/context', () => ({ requireOrgContextFor: (...a: unknown[]) => requireOrgContextFor(...a) }));
vi.mock('@/lib/question/panel', () => ({ loadQuestionPanel: (...a: unknown[]) => loadQuestionPanel(...a) }));

const { default: QuestionPage, QuestionPanelRegions } = await import(
  '@/app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]/page'
);
const { NotFoundError } = await import('@/lib/data/tenant');
const { NotImplementedError } = await import('@/lib/http/errors');

const QUESTION = {
  id: 'Q-PP-01', type: 'likert-5', text: 'Have you evaluated whether AI is the right approach?', principle: 'Proportionality',
  gaps: [], expectedPractice: 'x', whyAsked: 'y', reasonPrompt: 'z', evidenceExamples: [],
  stage: 'pre-processing', moduleId: 'M1', moduleTitle: 'Problem Formulation', order: 0,
} as LoadedQuestion;
const CURRENT = {
  id: 'dv2', projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01', versionNumber: 2,
  optionsInPlace: ['Alternatives analysis'], evidence: [{ id: 'e1' }],
  status: 'done', scopeAnswer: null, reasonCode: null, reason: 'r', decidedBy: null, declaredDate: null,
} as unknown as DecisionVersionView;
const PANEL: QuestionPanelData = {
  orgSlug: 'acme-health', projectId: 'p1', projectArchived: false, stage: 'pre-processing',
  question: QUESTION, runningQuestion: QUESTION, position: { index: 0, total: 24, previousId: null, nextId: 'Q-PP-02' },
  current: CURRENT, historyCount: 2, seals: [{ sealId: 's1', sealNumber: 1, reviewId: 'r1', reviewName: 'Pre-processing review 1' }],
  reasonCodes: [], members: [{ userId: 'u1', name: 'Amina N.' }], viewer: { userId: 'u1', name: 'Amina N.', role: 'assessor' },
  canWrite: true, canRaiseFinding: true, lastOwnSaveDate: null, openFinding: { findingId: 'f1' }, gateAnswer: null,
  contentSemver: '0.0.1-fixture', orgId: 'o1',
};

beforeEach(() => {
  for (const k of Object.keys(propsSeen)) delete propsSeen[k];
  requireIdentity.mockReset().mockResolvedValue({ userId: 'u1', email: 'a@x.test' });
  requireOrgContextFor.mockReset().mockResolvedValue({ orgId: 'o1', role: 'assessor' });
  loadQuestionPanel.mockReset().mockResolvedValue(PANEL);
});

describe('S-12 shell', () => {
  it('FR-DEC-01 UX-08: S-12 shell regions in order, each labelled, evidence block inside the answer form', async () => {
    const html = renderToStaticMarkup(await QuestionPanelRegions({ data: PANEL }));
    expect([...html.matchAll(/data-region="([a-z-]+)"/g)].map((m) => m[1]))
      .toEqual(['question', 'current-decision', 'seal-note', 'answer-form', 'evidence-block', 'finding-link', 'suggestions']);
    expect(html.match(/<section[^>]*aria-labelledby=/g)).toHaveLength(7);
    expect(html).toMatch(/data-region="answer-form"[\s\S]*data-region="evidence-block"[\s\S]*<\/section>[\s\S]*<\/section>[\s\S]*data-region="finding-link"/);
  });

  it('UX-08: every region is named by a heading of the page that it points to, and the suggestions section is the in-page target', async () => {
    const html = renderToStaticMarkup(await QuestionPanelRegions({ data: PANEL }));
    const labelled = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(labelled).size).toBe(7);
    for (const id of labelled) expect(html, id).toMatch(new RegExp(`<h[23] id="${id}">[^<]+</h[23]>`));
    expect(html).toMatch(/<section[^>]*data-region="suggestions"[^>]*id="suggestions"|<section[^>]*id="suggestions"[^>]*data-region="suggestions"/);
    expect(html.match(/id="suggestions"/g)).toHaveLength(1);
  });

  it('UX-31 FR-PRJ-03: an archived project shows the archived banner on S-12', async () => {
    const html = renderToStaticMarkup(await QuestionPanelRegions({ data: { ...PANEL, projectArchived: true } }));
    expect(html).toContain('This project is archived. Nothing in it can be changed. Owners and admins can unarchive it from All projects.');
    // the banner is above the regions
    expect(html.indexOf('This project is archived')).toBeLessThan(html.indexOf('data-region="question"'));
    expect(renderToStaticMarkup(await QuestionPanelRegions({ data: PANEL }))).not.toContain('This project is archived');
  });

  it('FR-DEC-01 (helper): each region\'s component gets the props its contract row names, from the panel data', async () => {
    renderToStaticMarkup(await QuestionPanelRegions({ data: PANEL }));
    expect(propsSeen.QuestionContent).toEqual({ question: QUESTION, suggestionCount: 0 });
    expect(propsSeen.CurrentDecision).toEqual({
      current: CURRENT, historyCount: 2, seals: PANEL.seals,
      historyHref: '/orgs/acme-health/projects/p1/stages/pre-processing/questions/Q-PP-01/history',
    });
    expect(propsSeen.SealNote).toEqual({ seals: PANEL.seals, nextVersionNumber: 3 });
    expect(propsSeen.EvidenceBlock).toMatchObject({ orgSlug: 'acme-health', projectId: 'p1', initial: [{ id: 'e1' }], disabled: false });
    expect(propsSeen.QuestionFindingLink).toEqual({
      orgSlug: 'acme-health', projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01',
      currentVersionId: 'dv2', openFinding: { findingId: 'f1' }, canRaise: true,
    });
    expect(propsSeen.SuggestedControls).toEqual({ contentSemver: '0.0.1-fixture', questionId: 'Q-PP-01', tickedOptions: ['Alternatives analysis'] });
  });

  it('FR-DEC-01 FR-DEC-06 UX-14 (helper): with no decision yet the next version is 1, and a read-only or archived panel has no evidence block to change', async () => {
    renderToStaticMarkup(await QuestionPanelRegions({ data: { ...PANEL, current: null } }));
    expect(propsSeen.SealNote).toMatchObject({ nextVersionNumber: 1 });
    expect(propsSeen.EvidenceBlock).toMatchObject({ initial: [], disabled: false });
    expect(propsSeen.SuggestedControls).toMatchObject({ tickedOptions: [] });
    expect(propsSeen.QuestionFindingLink).toMatchObject({ currentVersionId: null });
    for (const data of [{ ...PANEL, canWrite: false }, { ...PANEL, canWrite: false, projectArchived: true }]) {
      delete propsSeen.EvidenceBlock;
      const html = renderToStaticMarkup(await QuestionPanelRegions({ data }));
      expect(propsSeen.EvidenceBlock).toBeUndefined();
      expect(html).not.toContain('data-region="evidence-block"');
    }
  });
});

describe('S-12 page', () => {
  const params = (o: Partial<Record<'slug' | 'id' | 'stage' | 'questionId', string>> = {}) =>
    Promise.resolve({ slug: 'acme-health', id: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01', ...o });

  it('NFR-SEC-02 FR-DEC-01: the page asks for record:read in this organisation, then loads the panel for this question', async () => {
    const html = renderToStaticMarkup(await QuestionPage({ params: params() }));
    expect(requireOrgContextFor).toHaveBeenCalledWith('u1', 'acme-health', 'record:read');
    expect(loadQuestionPanel).toHaveBeenCalledWith({ orgId: 'o1', role: 'assessor' }, { userId: 'u1', email: 'a@x.test' },
      { projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01' });
    expect(html).toContain('data-region="answer-form"');
  });

  it('NFR-SEC-02: nothing is loaded when the identity or the membership is refused', async () => {
    requireOrgContextFor.mockRejectedValueOnce(new NotFoundError());
    await expect(QuestionPage({ params: params() })).rejects.toBeInstanceOf(NotFoundError);
    expect(loadQuestionPanel).not.toHaveBeenCalled();
  });

  it('NFR-SEC-02: a stage that is not one of the three, and a question the loader does not find, are a 404 page', async () => {
    await expect(QuestionPage({ params: params({ stage: 'pre-processing/../x' }) })).rejects.toMatchObject({ digest: expect.stringContaining('404') });
    expect(loadQuestionPanel).not.toHaveBeenCalled();
    loadQuestionPanel.mockRejectedValueOnce(new NotFoundError());
    await expect(QuestionPage({ params: params() })).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });

  it('NFR-MNT-01: until DEC-b fills the loader the page fails loudly with the unit named, not with an empty panel', async () => {
    loadQuestionPanel.mockRejectedValueOnce(new NotImplementedError('DEC-b'));
    await expect(QuestionPage({ params: params() })).rejects.toMatchObject({ status: 501, extra: { unit: 'DEC-b' } });
  });
});
