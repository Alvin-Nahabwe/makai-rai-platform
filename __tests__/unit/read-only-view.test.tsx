import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { QuestionOpenWork } from '@/lib/question/openWork';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';
import { PROJECT_COPY } from '@/lib/project/copy';
import { AUTHZ_COPY } from '@/lib/authz/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import { runningContent } from '@/lib/content/loader';
import { stageFixture } from '../helpers/stageFixture';

/**
 * The read-only question page (plan 1C Task 7; rulings R1 to R7 of the lane 6 brief of 14 November 2026): a person who
 * may not record (a Reviewer, a Viewer, any role in an archived project) reads "What the team decided", then what is still
 * open on the question, then the one line that says why there is no form. CurrentDecision, OpenWorkList, SealNote and
 * QuestionFindingLink are the REAL ones here; the loaders are mocked (fixture and mocks from s12-shell.test.tsx and
 * question-frame.test.tsx).
 */
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), useRouter: () => ({ refresh() {} }), usePathname: () => '/x' }));
vi.mock('@/components/evidence/EvidenceBlock', () => ({ EvidenceBlock: () => null }));
vi.mock('@/components/suggestions/SuggestedControls', async (original) => ({
  ...(await original<typeof import('@/components/suggestions/SuggestedControls')>()),
  SuggestedControls: () => null,
}));
const requireIdentity = vi.fn();
const requireOrgContextFor = vi.fn();
const loadQuestionPanel = vi.fn();
const loadQuestionOpenWork = vi.fn();
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: (...a: unknown[]) => requireIdentity(...a) }));
vi.mock('@/lib/auth/context', () => ({ requireOrgContextFor: (...a: unknown[]) => requireOrgContextFor(...a) }));
vi.mock('@/lib/question/panel', () => ({ loadQuestionPanel: (...a: unknown[]) => loadQuestionPanel(...a) }));
vi.mock('@/lib/question/openWork', () => ({ loadQuestionOpenWork: (...a: unknown[]) => loadQuestionOpenWork(...a) }));
// The route column's stage list (lane 7) is not this file's subject: its load answers the fixture stage with nothing
// recorded (the page refuses a null one, lane 1 Task 1).
vi.mock('@/lib/question/stagePage', async () => {
  const { stageFixture } = await import('../helpers/stageFixture');
  return { loadStagePage: async () => stageFixture() };
});

const { default: QuestionPage, QuestionPanelRegions } = await import(
  '@/app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]/page'
);

const QUESTION = {
  id: 'Q-PP-01', type: 'likert-5', text: 'Have you evaluated whether AI is the right approach?', principle: 'Proportionality',
  gaps: [], expectedPractice: 'Compare simpler options first.', whyAsked: 'A simpler tool may be safer.', reasonPrompt: 'z', evidenceExamples: [],
  stage: 'pre-processing', moduleId: 'M1', moduleTitle: 'Problem Formulation', order: 0,
} as LoadedQuestion;
const CURRENT = {
  id: 'dv2', projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01', versionNumber: 2, baseVersionNumber: 1,
  content: { semver: '0.0.1-fixture' }, optionsInPlace: [], status: 'done', scopeAnswer: null, reasonCode: null,
  reason: 'We compared a rules engine first.', reasonErased: null, decidedBy: null, declaredDate: null, declaredPrecision: null,
  withdrawalCode: null, enteredBy: { userId: 'u2', name: 'Joseph K.', formerMember: false }, enteredByRole: 'assessor',
  receivedAt: '2026-11-10T08:30:00.000Z',
  evidence: [{ id: 'e1', kind: 'link', url: 'https://example.org/a', label: 'Audit report', fileName: null, mimeType: null, byteSize: null, sha256: null, uploadedBy: null, uploadedAt: '2026-11-10T08:00:00.000Z', erased: null }],
} as unknown as DecisionVersionView;
const SEAL = { sealId: 's1', sealNumber: 1, reviewId: 'r1', reviewName: 'Pre-processing review 1' };
const PANEL: QuestionPanelData = {
  orgSlug: 'acme-health', projectId: 'p1', projectArchived: false, stage: 'pre-processing',
  question: QUESTION, runningQuestion: QUESTION, position: { index: 0, total: 24, previousId: null, nextId: 'Q-PP-02' },
  current: CURRENT, historyCount: 2, seals: [SEAL],
  reasonCodes: [], members: [{ userId: 'u1', name: 'Amina N.' }], viewer: { userId: 'u1', name: 'Amina N.', role: 'viewer' },
  canWrite: false, canRaiseFinding: false, lastOwnSaveDate: null, openFinding: { findingId: 'f1' }, gateAnswer: null,
  contentSemver: '0.0.1-fixture', orgId: 'o1',
};
const VIEWER = PANEL;
const REVIEWER: QuestionPanelData = { ...PANEL, viewer: { ...PANEL.viewer, role: 'reviewer' }, canRaiseFinding: true };
const WORK: QuestionOpenWork = {
  findings: [
    { findingId: 'f1', title: 'Have you evaluated whether AI is the right approach?', mitigations: [
      { what: 'Run the rules-engine baseline', assignedTo: 'Grace W.', dueDate: '2026-11-01', overdue: true, status: 'in_progress' },
      { what: null, assignedTo: 'Peter O.', dueDate: '2026-12-01', overdue: false, status: 'planned' },
    ] },
    { findingId: 'f2', title: 'No baseline was kept', mitigations: [] },
  ],
};

const render = async (data: QuestionPanelData, openWork: QuestionOpenWork | null = WORK): Promise<string> =>
  renderToStaticMarkup(await QuestionPanelRegions({ data, openWork, stage: stageFixture() }));
const regions = (html: string): string[] => [...html.matchAll(/data-region="([a-z-]+)"/g)].map((m) => m[1]);
const main = (html: string): string => html.match(/<div class="question-workspace__main">([\s\S]*?)<div class="question-workspace__guide">/)![1];
const textOf = (html: string): string => html.replace(/<[^>]+>/g, '');

beforeEach(() => {
  requireIdentity.mockReset().mockResolvedValue({ userId: 'u1', email: 'a@x.test' });
  requireOrgContextFor.mockReset().mockResolvedValue({ orgId: 'o1', role: 'viewer' });
  loadQuestionPanel.mockReset().mockResolvedValue({ ...PANEL, projectName: 'P' });
  loadQuestionOpenWork.mockReset().mockResolvedValue(WORK);
});

describe('the read-only question page (plan 1C Task 7)', () => {
  it('U12 d: a Viewer and a Reviewer see the reason text and the evidence names', async () => {
    for (const data of [VIEWER, REVIEWER]) {
      const html = await render(data);
      expect(html).toContain('<blockquote class="current-decision__reason">We compared a rules engine first.</blockquote>');
      expect(html).toContain('Audit report');
      expect(html).toMatch(/<dt>Evidence<\/dt><dd>/);
      expect(html).toContain('Entered by: Joseph K.');
    }
  });

  it('UX-14: neither has a form, a textarea, the save bar, the answer-form region or "Record a decision"', async () => {
    for (const data of [VIEWER, REVIEWER]) {
      const html = await render(data);
      expect(html).not.toMatch(/<form\b/);
      expect(html).not.toMatch(/<textarea\b/);
      expect(html).not.toContain('decision-save-bar');
      expect(html).not.toContain('data-region="answer-form"');
      expect(html).not.toContain(QUESTION_COPY.headings.record);
      expect(html).not.toContain(QUESTION_COPY.headings.current);
    }
  });

  it('C12: the heading is "What the team decided"; question, current decision, open work, the permission line, the seal note and the way on come in that order, the way on last', async () => {
    const html = await render(REVIEWER);
    expect(html).toContain('<section data-region="current-decision" aria-labelledby="s12-current-decision"><h2 id="s12-current-decision">What the team decided</h2>');
    expect(html).toContain('<section data-region="open-work" aria-labelledby="s12-open-work"><h2 id="s12-open-work">Still open on this question: 2 findings</h2>');
    expect(regions(main(html))).toEqual(['question', 'current-decision', 'open-work', 'seal-note', 'way-on']);
    const m = main(html);
    const at = (s: string) => m.indexOf(s);
    const order = [at('data-region="question"'), at('data-region="current-decision"'), at('data-region="open-work"'), at('data-permission-note'), at('data-region="seal-note"'), at('data-region="way-on"')];
    expect(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), order.join(',')).toBe(true);
    // The way on is the main column's last child: its paragraph closes, then the column does.
    expect(m).toMatch(/<p class="question-foot" data-region="way-on">(?:(?!<\/p>)[\s\S])*<\/p><\/div>$/);
    // The open findings come directly under the decision: no other section between them.
    expect(m).toMatch(/<\/section><section data-region="open-work"/);
    expect(m).toContain(`<p data-permission-note="true">${AUTHZ_COPY.decisionFormNote.reviewer}</p>`);
    expect(await render(VIEWER)).toContain(`<p data-permission-note="true">${AUTHZ_COPY.decisionFormNote.viewer}</p>`);
    // One finding is counted in the singular.
    expect(await render(VIEWER, { findings: [WORK.findings[1]] })).toContain('<h2 id="s12-open-work">Still open on this question: 1 finding</h2>');
  });

  it('the history link reads "History: n versions" in the reading view', async () => {
    const html = await render(VIEWER);
    expect(html).toContain('>History: 2 versions</a>');
    expect(html).not.toContain('See all versions');
    expect(await render({ ...VIEWER, historyCount: 1 })).toContain('>History: 1 version</a>');
  });

  it('each finding links to its page; a finding with two open mitigations shows both; one with none says "No mitigation yet"', async () => {
    const work = main(await render(VIEWER)).match(/<section data-region="open-work"[\s\S]*?<\/section>/)![0];
    expect(work).toMatch(/<a [^>]*href="\/orgs\/acme-health\/projects\/p1\/findings\/f1"[^>]*><bdi>Have you evaluated whether AI is the right approach\?<\/bdi><\/a>/);
    expect(work).toMatch(/<a [^>]*href="\/orgs\/acme-health\/projects\/p1\/findings\/f2"[^>]*><bdi>No baseline was kept<\/bdi><\/a>/);
    const [f1, f2] = work.split('href="/orgs/acme-health/projects/p1/findings/').slice(1);
    expect(f1).toContain('Mitigation: Run the rules-engine baseline');
    const erased = PROJECT_COPY.followUp.erased.replace("'", '&#x27;');
    expect(f1).toContain(`<span>${erased}</span>`);
    expect(f1).not.toContain(`Mitigation: ${erased}`);
    expect(f1).toContain('Assigned to: Grace W.');
    expect(f1).toContain('Assigned to: Peter O.');
    expect(f1).toContain('<span class="status-label">In progress</span>');
    expect(f1).toContain('<span class="status-label">Planned</span>');
    expect(f1).toContain('Due 1 Dec 2026');
    expect(f1).not.toContain('No mitigation yet');
    expect(f2).toContain('No mitigation yet');
    expect(f2).not.toContain('Mitigation:');
  });

  it('with no open finding there is no open-work section and no heading', async () => {
    for (const html of [await render(VIEWER, { findings: [] }), await render(VIEWER, null)]) {
      expect(html).not.toContain('open-work');
      expect(html).not.toContain('Still open on this question');
    }
  });

  it('spec 7.1: data-overdue is on the due phrase only, and the red class holds the word Overdue and nothing else', async () => {
    const html = await render(VIEWER);
    const overdue = [...html.matchAll(/<span data-overdue="true">([\s\S]*?)<\/span><\/li>/g)].map((m) => m[1]);
    expect(overdue).toEqual(['<span class="open-work__overdue">Overdue</span>: was due 1 Nov 2026']);
    expect(html.match(/data-overdue/g)).toHaveLength(1);
    const red = [...html.matchAll(/<[^>]+class="[^"]*open-work__overdue[^"]*"[^>]*>([\s\S]*?)<\//g)].map((m) => m[1]);
    expect(red).toEqual(['Overdue']);
    for (const s of ['Grace W.', 'Run the rules-engine baseline', 'Have you evaluated']) expect(overdue.join('')).not.toContain(s);
  });

  it('7.2: the Done mark draws no tick', async () => {
    const html = await render(VIEWER);
    const decision = html.match(/<section data-region="current-decision"[\s\S]*?<\/section>/)![0];
    expect(decision).toContain('data-mark-kind="done"');
    const svg = /<svg[^>]*>([\s\S]*?)<\/svg>/.exec(decision)![1];
    // The kit's shape for done (status-mark.test.tsx's EXPECTED_SHAPES): one filled circle, no other primitive, so no tick.
    const shapes = [...svg.matchAll(/<(\w+)\b/g)].map((m) => m[1]);
    expect(shapes).toEqual(['circle']);
    expect(svg).toMatch(/r="8"/);
    expect(svg).toMatch(/fill="currentColor"/);
    expect(textOf(decision)).toContain('Done');
  });

  it('UX-14: a Reviewer sees "Raise a finding about this question"; a Viewer does not and has no finding-link section', async () => {
    const reviewer = await render(REVIEWER);
    expect(reviewer).toContain('data-region="finding-link"');
    expect(reviewer).toContain(QUESTION_COPY.findingLink.raise);
    const viewer = await render(VIEWER);
    expect(viewer).not.toContain('data-region="finding-link"');
    expect(viewer).not.toContain(QUESTION_COPY.findingLink.raise);
    expect(viewer).not.toContain('s12-finding-link');
    // The guidance aside is as for everyone.
    expect(viewer).toContain('data-region="guidance"');
  });

  it('review M2: a Reviewer with an open platform-raised finding sees it once, in the open-work list, and the raise link stays in the aside', async () => {
    const html = await render(REVIEWER);
    expect(html.split('href="/orgs/acme-health/projects/p1/findings/f1"')).toHaveLength(2);
    expect(main(html)).toContain('href="/orgs/acme-health/projects/p1/findings/f1"');
    expect(html).not.toContain(QUESTION_COPY.findingLink.view);
    const guide = html.slice(html.indexOf('<div class="question-workspace__guide">'));
    expect(guide).toContain('data-region="finding-link"');
    expect(guide).toContain(QUESTION_COPY.findingLink.raise);
  });

  it('workshop walk S3: a reader on a question the personal data answer switched off reads the sentence under the code line', async () => {
    const off = runningContent().questions.get('Q-PP-13')!;
    for (const data of [VIEWER, REVIEWER]) {
      const html = await render({ ...data, question: off, runningQuestion: off, gateAnswer: 'no' });
      const question = html.match(/<section data-region="question"[\s\S]*?<\/section>/)![0];
      expect(question).toMatch(/<p class="question-frame__code">[^<]*<\/p><p data-does-not-apply="true">/);
      expect(question).toContain(QUESTION_COPY.doesNotApply);
    }
    expect(await render(VIEWER)).not.toContain('data-does-not-apply');
  });

  it('UX-31 C12: in an archived project an Owner gets the reading view, no permission line, and the archived banner', async () => {
    const html = await render({ ...PANEL, viewer: { ...PANEL.viewer, role: 'owner' }, projectArchived: true, canWrite: false, canRaiseFinding: false });
    expect(html).toContain(PROJECT_COPY.archivedBanner);
    expect(html).toContain('What the team decided');
    expect(html).not.toContain('data-permission-note');
    expect(html).not.toContain('data-region="answer-form"');
    expect(html).not.toContain(QUESTION_COPY.headings.record);
  });

  it('NFR-SEC-11: a hostile reason, finding title and mitigation text come out as text', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = await render({ ...VIEWER, current: { ...CURRENT, reason: evil } },
      { findings: [{ findingId: 'f9', title: evil, mitigations: [{ what: evil, assignedTo: evil, dueDate: '2026-11-01', overdue: true, status: 'planned' }] }] });
    expect(html).not.toContain('<img');
    expect(html.split('&lt;img src=x onerror=alert(1)&gt;')).toHaveLength(5);
  });

  it('a person who may record keeps the form: answer-form and "Current decision", no open-work region and no "What the team decided", even with openWork', async () => {
    const writer: QuestionPanelData = { ...PANEL, viewer: { ...PANEL.viewer, role: 'assessor' }, canWrite: true, canRaiseFinding: true };
    const withWork = await render(writer, WORK);
    expect(withWork).toContain('data-region="answer-form"');
    expect(withWork).toContain(`<h2 id="s12-current-decision">${QUESTION_COPY.headings.current}</h2>`);
    expect(withWork).not.toContain('data-region="open-work"');
    expect(withWork).not.toContain('What the team decided');
    expect(withWork).toContain('See all versions (2)');
    expect(withWork).toBe(await render(writer, null));
  });
});

describe('the page loads the open work only for a reader (R3)', () => {
  const params = Promise.resolve({ slug: 'acme-health', id: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01' });
  const searchParams = Promise.resolve({});

  it('canWrite false: openWork is loaded with the context, the route ids and today, after the panel', async () => {
    const html = renderToStaticMarkup(await QuestionPage({ params, searchParams }));
    expect(loadQuestionOpenWork).toHaveBeenCalledTimes(1);
    expect(loadQuestionOpenWork).toHaveBeenCalledWith({ orgId: 'o1', role: 'viewer' },
      { projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01', today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(loadQuestionPanel.mock.invocationCallOrder[0]).toBeLessThan(loadQuestionOpenWork.mock.invocationCallOrder[0]);
    expect(html).toContain('Still open on this question: 2 findings');
  });

  it('canWrite true: openWork is not loaded', async () => {
    loadQuestionPanel.mockResolvedValueOnce({ ...PANEL, canWrite: true, projectName: 'P' });
    const html = renderToStaticMarkup(await QuestionPage({ params: Promise.resolve({ slug: 'acme-health', id: 'p1', stage: 'pre-processing', questionId: 'Q-PP-02' }), searchParams }));
    expect(loadQuestionOpenWork).not.toHaveBeenCalled();
    expect(html).toContain('data-region="answer-form"');
  });

  it('a failed open-work read fails the page, not "nothing open"', async () => {
    loadQuestionOpenWork.mockRejectedValueOnce(new Error('db down'));
    await expect(QuestionPage({ params: Promise.resolve({ slug: 'acme-health', id: 'p1', stage: 'pre-processing', questionId: 'Q-PP-03' }), searchParams })).rejects.toThrow('db down');
  });
});
