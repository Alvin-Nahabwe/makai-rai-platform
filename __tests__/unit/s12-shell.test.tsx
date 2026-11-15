import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';
import { PROJECT_COPY } from '@/lib/project/copy';
import { stageFixture } from '../helpers/stageFixture';

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
// The reader's decision card (lane 1 Task 3) is a slot too: a reader's panel renders it in place of CurrentDecision.
vi.mock('@/components/question/ReadingDecision', () => ({ ReadingDecision: slot('ReadingDecision') }));
vi.mock('@/components/review/SealNote', () => ({ SealNote: slot('SealNote') }));
// DEC-b's answer form is real here: it renders the evidence block inside its own client tree (EVD RE-1), so the wiring
// of the block is checked through it. Its router is the only part of next/navigation a static render cannot provide.
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), useRouter: () => ({ refresh() {} }), usePathname: () => '/x' }));
vi.mock('@/components/evidence/EvidenceBlock', () => ({ EvidenceBlock: slot('EvidenceBlock') }));
vi.mock('@/components/findings/QuestionFindingLink', () => ({ QuestionFindingLink: slot('QuestionFindingLink') }));
vi.mock('@/components/suggestions/SuggestedControls', async (original) => ({
  ...(await original<typeof import('@/components/suggestions/SuggestedControls')>()),   // suggestionCount is the real one: the page and the slot share it
  SuggestedControls: slot('SuggestedControls'),
}));

const requireIdentity = vi.fn();
const requireOrgContextFor = vi.fn();
const loadQuestionPanel = vi.fn();
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: (...a: unknown[]) => requireIdentity(...a) }));
vi.mock('@/lib/auth/context', () => ({ requireOrgContextFor: (...a: unknown[]) => requireOrgContextFor(...a) }));
vi.mock('@/lib/question/panel', () => ({ loadQuestionPanel: (...a: unknown[]) => loadQuestionPanel(...a) }));
// The column's read (the stage page's loader): the fixture stage with nothing recorded (the page refuses a null one).
const loadStagePage = vi.fn();
vi.mock('@/lib/question/stagePage', () => ({ loadStagePage: (...a: unknown[]) => loadStagePage(...a) }));

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
  content: { contentVersionId: 'cv1', semver: '0.0.1-fixture', contentHash: 'h1' },
  status: 'done', scopeAnswer: null, reasonCode: null, reason: 'r', decidedBy: null, declaredDate: null,
  enteredBy: { userId: 'u2', name: 'Joseph K.', formerMember: false }, receivedAt: '2026-11-10T08:30:00.000Z',
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
  loadStagePage.mockReset().mockResolvedValue(stageFixture({ projectName: 'P' }));
});

describe('S-12 shell', () => {
  it('FR-DEC-01 UX-08: S-12 shell regions in order, each but the evidence block labelled by a heading, evidence block inside the answer form', async () => {
    const html = renderToStaticMarkup(await QuestionPanelRegions({ stage: stageFixture(), data: PANEL }));
    // The seal note sits above the decision card (lane 2's, through the slot), which is the one answer-form section holding
    // everything of the decision, the evidence block and the finding links among it: no current-decision region, no region
    // of its own for the finding link or the way on for a writer. The list of ways teams address this is inside the guidance
    // aside (mocked here), not a section of its own.
    expect([...html.matchAll(/data-region="([a-z-]+)"/g)].map((m) => m[1]))
      .toEqual(['question', 'seal-note', 'answer-form', 'evidence-block']);
    // The evidence block is named once, by its fieldset legend (evidence-components.test.tsx), not by a heading of its own.
    expect(html.match(/<section[^>]*aria-labelledby=/g)).toHaveLength(3);
    expect(html).toMatch(/<section data-region="evidence-block">/);
    expect(html).toMatch(/<h2 id="s12-answer-form">Your decision<\/h2>/);
    expect(html).toMatch(/data-region="answer-form"[\s\S]*data-region="evidence-block"[\s\S]*<\/section>[\s\S]*class="decision-card__raise"/);
  });

  it('UX-08: every labelled region is named by a heading of the page that it points to, and the evidence block has no heading of its own', async () => {
    const html = renderToStaticMarkup(await QuestionPanelRegions({ stage: stageFixture(), data: PANEL }));
    const labelled = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(labelled).size).toBe(3);
    expect(html).not.toContain('s12-evidence');
    for (const id of labelled) expect(html, id).toMatch(new RegExp(`<h([1-3]) id="${id}"[^>]*>[^<]+</h\\1>`));
    // The list of ways teams address this opens in place inside the aside (question-frame.test.tsx): no section of its own.
    expect(html).not.toContain('data-region="suggestions"');
    expect(html).not.toContain('s12-suggestions');
  });

  it('FR-SUG-02 UX-08: for the gate question (nothing to suggest) the page renders no Ways teams address this section and no link to it', async () => {
    const gate = { ...QUESTION, id: 'Q-PP-GATE-SENSITIVE', type: 'gate' } as LoadedQuestion;
    const html = renderToStaticMarkup(await QuestionPanelRegions({ stage: stageFixture(), data: { ...PANEL, question: gate, runningQuestion: gate } }));
    expect(html).not.toContain('Ways teams address this');
    expect(html).not.toContain('s12-suggestions');
    expect(html).not.toContain('data-region="suggestions"');
    // The aside gets no count, no risk areas (the personal data question has none of its own) and no list.
    expect(propsSeen.QuestionContent).toEqual({ question: gate, suggestionCount: 0, riskAreas: [], children: null });
    expect(html.match(/<section[^>]*aria-labelledby=/g)).toHaveLength(3);
  });

  it('UX-31 FR-PRJ-03: an archived project shows the archived banner on S-12', async () => {
    const html = renderToStaticMarkup(await QuestionPanelRegions({ stage: stageFixture(), data: { ...PANEL, projectArchived: true } }));
    expect(html).toContain(PROJECT_COPY.archivedBanner);
    // the banner is above the regions
    expect(html.indexOf('This project is archived')).toBeLessThan(html.indexOf('data-region="question"'));
    expect(renderToStaticMarkup(await QuestionPanelRegions({ stage: stageFixture(), data: PANEL }))).not.toContain('This project is archived');
  });

  it('FR-DEC-01 (helper): each region\'s component gets the props its contract row names, from the panel data', async () => {
    renderToStaticMarkup(await QuestionPanelRegions({ stage: stageFixture(), data: PANEL }));
    // The aside gets the count, the question's risk areas, and the list as its children, which it shows folded.
    const content = propsSeen.QuestionContent as { question: unknown; suggestionCount: number; riskAreas: unknown[]; children: { props: unknown } };
    expect(content).toMatchObject({ question: QUESTION, suggestionCount: 3, riskAreas: [] });
    expect(content.children.props).toEqual({ contentSemver: '0.0.1-fixture', questionId: 'Q-PP-01', tickedOptions: ['Alternatives analysis'] });
    // The current decision is the card's own, from the panel data: the saved version, the count of versions and the history
    // address (the CurrentDecision slot is no longer rendered for a writer).
    expect(propsSeen.CurrentDecision).toBeUndefined();
    const html = renderToStaticMarkup(await QuestionPanelRegions({ stage: stageFixture(), data: PANEL }));
    expect(html).toContain('Saved as version 2');
    expect(html).toContain('href="/orgs/acme-health/projects/p1/stages/pre-processing/questions/Q-PP-01/history"');
    expect(html).toContain('History: 2 versions');
    expect(propsSeen.SealNote).toEqual({ seals: PANEL.seals, nextVersionNumber: 3 });
    expect(propsSeen.EvidenceBlock).toMatchObject({ orgSlug: 'acme-health', projectId: 'p1', initial: [{ id: 'e1' }], disabled: false });
    expect(propsSeen.QuestionFindingLink).toEqual({
      orgSlug: 'acme-health', projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01',
      currentVersionId: 'dv2', openFinding: { findingId: 'f1' }, canRaise: true,
    });
  });

  it('FR-DEC-01 FR-DEC-06 UX-14 (helper): with no decision yet the next version is 1, and a read-only or archived panel has no evidence block to change', async () => {
    renderToStaticMarkup(await QuestionPanelRegions({ stage: stageFixture(), data: { ...PANEL, current: null } }));
    expect(propsSeen.SealNote).toMatchObject({ nextVersionNumber: 1 });
    expect(propsSeen.EvidenceBlock).toMatchObject({ initial: [], disabled: false });
    expect((propsSeen.QuestionContent as { children: { props: unknown } }).children.props).toMatchObject({ tickedOptions: [] });
    // The card's foot (saved lines, history, finding links) shows only after a save: with no decision there is no finding link.
    expect(propsSeen.QuestionFindingLink).toBeUndefined();
    for (const data of [{ ...PANEL, canWrite: false }, { ...PANEL, canWrite: false, projectArchived: true }]) {
      delete propsSeen.EvidenceBlock;
      const html = renderToStaticMarkup(await QuestionPanelRegions({ data, stage: stageFixture() }));
      expect(propsSeen.EvidenceBlock).toBeUndefined();
      expect(html).not.toContain('data-region="evidence-block"');
    }
  });
});

describe('S-12 page', () => {
  const params = (o: Partial<Record<'slug' | 'id' | 'stage' | 'questionId', string>> = {}) =>
    Promise.resolve({ slug: 'acme-health', id: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01', ...o });

  it('NFR-SEC-02 FR-DEC-01: the page asks for record:read in this organisation, then loads the panel for this question', async () => {
    const html = renderToStaticMarkup(await QuestionPage({ params: params(), searchParams: Promise.resolve({}) }));
    expect(requireOrgContextFor).toHaveBeenCalledWith('u1', 'acme-health', 'record:read');
    expect(loadQuestionPanel).toHaveBeenCalledWith({ orgId: 'o1', role: 'assessor' }, { userId: 'u1', email: 'a@x.test' },
      { projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01' });
    // The column reads the stage with the same context and identity, nothing wider.
    expect(loadStagePage).toHaveBeenCalledWith({ orgId: 'o1', role: 'assessor' }, 'u1', 'p1', 'pre-processing');
    expect(html).toContain('data-region="answer-form"');
  });

  it('lane 1 Task 1: a stage list of null for a project the panel found fails the page loudly, never a page without its strips', async () => {
    loadStagePage.mockResolvedValueOnce(null);
    await expect(QuestionPage({ params: params(), searchParams: Promise.resolve({}) })).rejects.toThrow(/stage list of pre-processing was not found/);
  });

  it('NFR-SEC-02: nothing is loaded when the identity or the membership is refused', async () => {
    requireOrgContextFor.mockRejectedValueOnce(new NotFoundError());
    await expect(QuestionPage({ params: params(), searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(NotFoundError);
    expect(loadQuestionPanel).not.toHaveBeenCalled();
    expect(loadStagePage).not.toHaveBeenCalled();
  });

  it('NFR-SEC-02: a stage that is not one of the three, and a question the loader does not find, are a 404 page', async () => {
    await expect(QuestionPage({ params: params({ stage: 'pre-processing/../x' }), searchParams: Promise.resolve({}) })).rejects.toMatchObject({ digest: expect.stringContaining('404') });
    expect(loadQuestionPanel).not.toHaveBeenCalled();
    loadQuestionPanel.mockRejectedValueOnce(new NotFoundError());
    await expect(QuestionPage({ params: params(), searchParams: Promise.resolve({}) })).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });

  it('NFR-MNT-01: until DEC-b fills the loader the page fails loudly with the unit named, not with an empty panel', async () => {
    loadQuestionPanel.mockRejectedValueOnce(new NotImplementedError('DEC-b'));
    await expect(QuestionPage({ params: params(), searchParams: Promise.resolve({}) })).rejects.toMatchObject({ status: 501, extra: { unit: 'DEC-b' } });
  });
});
