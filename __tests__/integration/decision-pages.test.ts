import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrgRole } from '@prisma/client';
import type { Identity } from '@/lib/auth/identity';
import type { ContentRef } from '@/types/api';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addProject, addSealRow, addStageReview, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { FIXTURE_QUESTION_IDS } from '../helpers/content';
import type { StageFilter } from '@/lib/question/stageList';
import { HOSTILE_STRINGS } from '../helpers/hostile';
import { SUGGESTIONS_COPY } from '@/lib/suggestions/copy';
import { QUESTION_COPY } from '@/lib/question/copy';

/**
 * S-11, S-12 and S-13 rendered from real panel data on the fixture bundle (contract "Content bundle"). The router is the
 * only part of next/navigation a static render cannot provide.
 */
vi.mock('@/lib/data/reviews', () => ({ listStageReviews: vi.fn(async () => []), changedSinceSeal: vi.fn(async () => null) }));
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), useRouter: () => ({ refresh() {} }), usePathname: () => '/x' }));

const { loadQuestionPanel } = await import('@/lib/question/panel');
const { listStageReviews, changedSinceSeal } = await import('@/lib/data/reviews');
const { loadStagePage, StageWorkspace } = await import('@/app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/page');
const { loadHistoryPage, HistoryView, wordingIn } = await import('@/app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]/history/page');
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

describe('S-12 page', () => {
  it('UX-08 FR-CNT-02 (screen): QuestionContent gets the suggestion count and the suggestions section carries id="suggestions"', async () => {
    const h = renderToStaticMarkup(createElement(QuestionPanelRegions, { data: await panelData('assessor', 'Q-PP-01') }));
    expect(h).toContain('href="#suggestions">Ways teams address this (3)</a>');
    expect(h).toContain('<h2 id="s12-suggestions">Ways teams address this</h2>');
    expect(h).toContain(SUGGESTIONS_COPY.intro);
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

let lastReviewId = '';
async function renderS11(query: string, opts: { withReview?: boolean; role?: OrgRole } = {}): Promise<string> {
  if (opts.withReview) {
    const review = await addStageReview(fx, project.id, { stage: 'pre-processing' });
    await addSealRow(fx, review.id, {});
    vi.mocked(listStageReviews).mockResolvedValueOnce([{ id: review.id, numberInStage: review.numberInStage, name: `Pre-processing review ${review.numberInStage}` } as Awaited<ReturnType<typeof listStageReviews>>[number]]);
    lastReviewId = review.id;
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
    expect(h).toContain(QUESTION_COPY.stage.nothingRecorded);
    expect([...h.matchAll(/>No decision</g)].length).toBe(STAGE_QUESTION_COUNT);
    expect(h).toContain(`${STAGE_QUESTION_COUNT} questions`);
    // SPEC-4 W-2: module headings with their own counts, under a stage subtitle
    expect(h).toMatch(/<h2[^>]*>Problem Formulation<\/h2>\s*<p[^>]*>7 questions · 7 with no decision<\/p>/);
    expect(h).toContain('Problem Formulation · Data Collection &amp; Preparation');
  });

  it('FR-DEC-06 (screen): with a decision recorded the empty line goes and the row shows its status and version', async () => {
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: c1.contentVersionId, status: 'partly', declaredDate: '2026-10' });
    const h = await renderS11('?show=all');
    expect(h).not.toContain('Nothing is recorded for this stage yet.');
    expect(h).toMatch(/data-question-id="Q-PP-01"[\s\S]*?>Partly<\/span> · Oct 2026/);
  });

  it('FR-DEC-06 (screen): a filter with no results says so and links to all', async () => {
    const h = await renderS11('?show=done_without_evidence');
    expect(h).toContain('No questions match &#x27;Done, no evidence attached&#x27;.');
    expect(h).toMatch(new RegExp(`<a[^>]*href="[^"]*\\?show=all"[^>]*>Show all ${STAGE_QUESTION_COUNT}</a>`));
  });

  it('FR-REV-05 (screen) UX-31: a question changed since seal 1 carries the marker "changed since seal 1"', async () => {
    vi.mocked(changedSinceSeal).mockResolvedValueOnce({ sealNumber: 1, changedQuestions: ['Q-PP-01'], changedFindings: [] });
    const h = await renderS11('?show=all', { withReview: true });
    expect(h).toMatch(/data-question-id="Q-PP-01"[\s\S]*?changed since seal 1/);
    expect(h).toContain('Changed since seal 1');
  });

  it('SPEC-4 RE-4 FR-REV-05: the newest review is named before the banner and linked to S-16, and the filter counts every changed question', async () => {
    // REV-b's changedSinceSeal can list a question the running content no longer holds (REV-b RE-1): it counts too.
    vi.mocked(changedSinceSeal).mockResolvedValueOnce({ sealNumber: 1, changedQuestions: ['Q-PP-01', 'Q-PP-99'], changedFindings: [] });
    const h = await renderS11('?show=all', { withReview: true });
    expect(h).toMatch(/Pre-processing review 1:[\s\S]*changed since seal 1 in 2 questions\./);
    expect(h).toContain(`href="/orgs/${fx.org.slug}/projects/${project.id}/reviews/${lastReviewId}"`);
    expect(h).toMatch(/value="changed_since_seal"[^>]*\/?>\s*Changed since seal 1 2</);
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

describe('S-13 page', () => {
  const history = async (role: OrgRole, shown: string | null = null) => {
    const data = await loadHistoryPage(ctxFor(fx, role), fx.members[role].userId, { projectId: project.id, stage: 'pre-processing', questionId: 'Q-PP-01' });
    return renderToStaticMarkup(createElement(HistoryView, { data: data!, shown }));
  };

  it("FR-DEC-04 (screen) FR-CNT-07: versions newest first, each with that version's wording, and no content version or UTC toggle", async () => {
    // Version 1 answers content 0.0.1-fixture and version 2 answers 0.0.2-fixture, whose wording of Q-PP-01 differs, so
    // each block must show its own version's wording. The content version itself and a "Show UTC" disclosure are not shown.
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: c1.contentVersionId, status: 'done', declaredDate: '2026-10' });
    const c2 = await useFixtureContent('0.0.2-fixture');
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: c2.contentVersionId, status: 'partly', declaredDate: '2026' });
    const h = await history('viewer');
    expect([...h.matchAll(/data-version-number="(\d+)"/g)].map((m) => m[1])).toEqual(['2', '1']);
    const asMarkup = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
    const [v2, v1] = h.split('data-version-number=').slice(1);
    const w1 = wordingIn(c1.semver, 'Q-PP-01')!;
    const w2 = wordingIn(c2.semver, 'Q-PP-01')!;
    expect(w2.text).not.toBe(w1.text);   // not vacuous: the two versions word the question differently
    expect(v1).toContain(`<dd>${asMarkup(w1.text)}</dd>`);
    expect(v1).not.toContain(`<dd>${asMarkup(w2.text)}</dd>`);
    expect(v2).toContain(`<dd>${asMarkup(w2.text)}</dd>`);
    expect(v2).not.toContain(`<dd>${asMarkup(w1.text)}</dd>`);
    expect(v1).toContain(`<dd>${asMarkup(w1.expectedPractice)}</dd>`);
    expect(v2).toContain(`<dd>${asMarkup(w2.expectedPractice)}</dd>`);
    for (const gone of ['Show UTC', 'Content version', `<dd>${c1.semver}</dd>`, `<dd>${c2.semver}</dd>`]) expect(h, gone).not.toContain(gone);
    expect(h).not.toContain('Withdraw this decision');   // a viewer has no withdraw control (FR-DEC-08)
  });

  it('FR-DEC-08 (screen): Withdraw is offered to the entrant assessor, an owner and an admin, and not to another assessor\'s entry', async () => {
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: c1.contentVersionId, status: 'done', by: 'owner' });
    expect(await history('owner')).toContain('Withdraw this decision');
    expect(await history('admin')).toContain('Withdraw this decision');
    expect(await history('assessor')).not.toContain('Withdraw this decision');
    expect(await history('reviewer')).not.toContain('Withdraw this decision');
  });

  it('UX-40: a history of 21 versions shows the latest 20 and Show older', async () => {
    for (let i = 0; i < 21; i++) await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: c1.contentVersionId, status: 'done' });
    const h = await history('viewer');
    expect([...h.matchAll(/data-version-number="/g)]).toHaveLength(20);
    expect(h).toMatch(/<a[^>]*href="\?shown=40"[^>]*>Show older<\/a>/);
    expect([...(await history('viewer', '40')).matchAll(/data-version-number="/g)]).toHaveLength(21);
  });

  it('NFR-SEC-11: hostile reason text renders as text on S-13', async () => {
    for (let i = 0; i < HOSTILE_STRINGS.length; i++) {
      await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: c1.contentVersionId, status: 'done' });
    }
    const data = await loadHistoryPage(ctxFor(fx, 'viewer'), fx.members.viewer.userId, { projectId: project.id, stage: 'pre-processing', questionId: 'Q-PP-01' });
    const hostile = { ...data!, entries: data!.entries.map((e, i) => ({ ...e, version: { ...e.version, reason: HOSTILE_STRINGS[i % HOSTILE_STRINGS.length] } })) };
    const h = renderToStaticMarkup(createElement(HistoryView, { data: hostile, shown: null }));
    expect(h).not.toContain('<script>alert(1)</script>');
    expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('NFR-SEC-02 B1: S-13 of organisation B\'s project, or a question of another stage, is not found', async () => {
    const pB = await addProject(await buildOrg({ label: 'b' }));
    expect(await loadHistoryPage(ctxFor(fx, 'owner'), fx.members.owner.userId, { projectId: pB.id, stage: 'pre-processing', questionId: 'Q-PP-01' })).toBeNull();
    expect(await loadHistoryPage(ctxFor(fx, 'owner'), fx.members.owner.userId, { projectId: project.id, stage: 'in-processing', questionId: 'Q-PP-01' })).toBeNull();
  });
});

describe('S-13 wording', () => {
  it('CR-5 F8 FR-CNT-07: only a version the index no longer lists loses its wording; any other content error is thrown', async () => {
    const { AppError } = await import('@/lib/http/errors');
    expect(wordingIn('9.9.9', 'Q-PP-01', () => { throw new AppError(500, 'unknown_content_version'); })).toBeNull();
    expect(() => wordingIn('0.0.1-fixture', 'Q-PP-01', () => { throw new Error('questionBank.json: bad JSON'); })).toThrow('bad JSON');
  });
});
