import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrgRole } from '@prisma/client';
import type { Identity } from '@/lib/auth/identity';
import type { ControlGroup } from '@/lib/content/suggestions';
import type { ContentRef } from '@/types/api';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addProject, addSealRow, addStageReview, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { FIXTURE_QUESTION_IDS } from '../helpers/content';
import type { StageFilter } from '@/lib/question/stageList';

/**
 * S-11, S-12 and S-13 rendered from real panel data on the fixture bundle (contract "Content bundle"). SUG's
 * `controlsForQuestion` is mocked in this file only, until SUG merges (contract rule 5); the router is the only part
 * of next/navigation a static render cannot provide.
 */
vi.mock('@/lib/content/suggestions', () => ({ controlsForQuestion: vi.fn(() => ({ first: [], rest: [] })), controlsForArea: vi.fn(() => []) }));
vi.mock('@/lib/data/reviews', () => ({ listStageReviews: vi.fn(async () => []), changedSinceSeal: vi.fn(async () => null) }));
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), useRouter: () => ({ refresh() {} }), usePathname: () => '/x' }));

const { controlsForQuestion } = await import('@/lib/content/suggestions');
const { loadQuestionPanel } = await import('@/lib/question/panel');
const { listStageReviews, changedSinceSeal } = await import('@/lib/data/reviews');
const { loadStagePage, StageWorkspace } = await import('@/app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/page');
const { QuestionPanelRegions } = await import('@/app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]/page');

let c1: ContentRef;
let fx: OrgFixture;
let project: { id: string };

beforeEach(async () => {
  await resetDb();
  c1 = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg();
  project = await addProject(fx);
});

const identity = (role: OrgRole): Identity => ({
  userId: fx.members[role].userId, email: fx.members[role].email, name: fx.members[role].name, platformRole: 'assessor', mustChangePassword: false,
});
const panelData = (role: OrgRole, questionId: string) =>
  loadQuestionPanel(ctxFor(fx, role), identity(role), { projectId: project.id, stage: 'pre-processing', questionId });
const group = (id: string): ControlGroup => ({ area: { id } as ControlGroup['area'], controls: [] });

describe('S-12 page', () => {
  it('UX-08 FR-CNT-02 (screen): QuestionContent gets the suggestion count and the suggestions section carries id="suggestions"', async () => {
    vi.mocked(controlsForQuestion).mockReturnValueOnce({ first: [group('G1')], rest: [group('G2'), group('G3')] });
    const h = renderToStaticMarkup(createElement(QuestionPanelRegions, { data: await panelData('assessor', 'Q-PP-01') }));
    expect(h).toContain('Ways teams address this (3)');
    expect(h).toMatch(/<section[^>]*id="suggestions"/);
  });

  it('FR-DEC-06 FR-DEC-10 (screen): a new project\'s S-12 shows No decision yet, an empty form with empty date fields and Save decision', async () => {
    const h = renderToStaticMarkup(createElement(QuestionPanelRegions, { data: await panelData('assessor', 'Q-PP-01') }));
    expect(h).toContain('No decision yet.');
    expect(h).toMatch(/<button[^>]*type="submit"[^>]*>Save decision<\/button>/);
    expect([...h.matchAll(/<input[^>]*inputmode="numeric"[^>]*>/gi)].every((m) => !/value="[^"]+"/.test(m[0]))).toBe(true);
  });
});

/** The pre-processing questions of 0.0.1-fixture (24). */
const STAGE_QUESTION_COUNT = FIXTURE_QUESTION_IDS.filter((id) => id.startsWith('Q-PP-')).length;

async function renderS11(query: string, opts: { withReview?: boolean; role?: OrgRole } = {}): Promise<string> {
  if (opts.withReview) {
    const review = await addStageReview(fx, project.id, { stage: 'pre-processing' });
    await addSealRow(fx, review.id, {});
    vi.mocked(listStageReviews).mockResolvedValueOnce([{ id: review.id, numberInStage: review.numberInStage } as Awaited<ReturnType<typeof listStageReviews>>[number]]);
  }
  const role = opts.role ?? 'assessor';
  const data = await loadStagePage(ctxFor(fx, role), fx.members[role].userId, project.id, 'pre-processing');
  const show = (new URLSearchParams(query).get('show') ?? 'all') as StageFilter;
  return renderToStaticMarkup(createElement(StageWorkspace, { data: data!, show, shown: null }));
}

describe('S-11 page', () => {
  it('NFR-PRIV-04: S-11 filter addresses hold only the filter key', async () => {
    const hrefs = [...(await renderS11('?show=done_without_evidence')).matchAll(/href="([^"]*show=[^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.every((h) => /\?show=[a-z_]+$/.test(h))).toBe(true);
  });

  it('FR-DEC-06 (screen): a new project\'s stage shows every question as No decision and the W-2 empty line', async () => {
    const h = await renderS11('?show=all');
    expect(h).toContain('Nothing is recorded for this stage yet. Open any question to start. Stages can be recorded in any order.');
    expect([...h.matchAll(/>No decision</g)].length).toBe(STAGE_QUESTION_COUNT);
    expect(h).toContain(`${STAGE_QUESTION_COUNT} questions`);
  });

  it('FR-DEC-06 (screen): with a decision recorded the empty line goes and the row shows its status and version', async () => {
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: c1.contentVersionId, status: 'partly', declaredDate: '2026-10' });
    const h = await renderS11('?show=all');
    expect(h).not.toContain('Nothing is recorded for this stage yet.');
    expect(h).toMatch(/data-question-id="Q-PP-01"[\s\S]*?>Partly<\/span> · v1 · Oct 2026/);
  });

  it('FR-DEC-06 (screen): a filter with no results says so and links to all', async () => {
    const h = await renderS11('?show=done_without_evidence');
    expect(h).toContain('No questions match &#x27;Done without evidence&#x27;.');
    expect(h).toMatch(new RegExp(`<a[^>]*href="[^"]*\\?show=all"[^>]*>Show all ${STAGE_QUESTION_COUNT}</a>`));
  });

  it('FR-REV-05 (screen) UX-31: a question changed since seal 1 carries the marker "changed since seal 1"', async () => {
    vi.mocked(changedSinceSeal).mockResolvedValueOnce({ sealNumber: 1, changedQuestions: ['Q-PP-01'], changedFindings: [] });
    const h = await renderS11('?show=all', { withReview: true });
    expect(h).toMatch(/data-question-id="Q-PP-01"[\s\S]*?changed since seal 1/);
    expect(h).toContain('Changed since seal 1');
  });

  it('UX-06 (screen, R12-16): every S-11 row\'s status words sit in a status-label element, and none carries the warning class', async () => {
    const h = await renderS11('?show=all');
    expect([...h.matchAll(/class="[^"]*\bstatus-label\b[^"]*"/g)].length).toBe(STAGE_QUESTION_COUNT);
    expect(h).not.toContain('status-label--warning');
  });

  it('UX-26 W-2: ?show=drafts renders every row on the server with the Drafts on this device filter chosen', async () => {
    const h = await renderS11('?show=drafts');
    expect([...h.matchAll(/data-question-id="/g)].length).toBe(STAGE_QUESTION_COUNT);
    expect(h).toMatch(/<input(?=[^>]*value="drafts")(?=[^>]*\bchecked\b)[^>]*>/);   // React writes `checked` before `value`
    expect([...h.matchAll(/<input[^>]*\bchecked\b[^>]*>/g)]).toHaveLength(1);
  });

  it('NFR-SEC-02 B1: S-11 of organisation B\'s project is not found for organisation A', async () => {
    const pB = await addProject(await buildOrg({ label: 'b' }));
    expect(await loadStagePage(ctxFor(fx, 'owner'), fx.members.owner.userId, pB.id, 'pre-processing')).toBeNull();
  });

  it('UX-14 owner question B21: a viewer reads S-11 with the same rows', async () => {
    const h = await renderS11('?show=all', { role: 'viewer' });
    expect([...h.matchAll(/data-question-id="/g)].length).toBe(STAGE_QUESTION_COUNT);
  });
});

