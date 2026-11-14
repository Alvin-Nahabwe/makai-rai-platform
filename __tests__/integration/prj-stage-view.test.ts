import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { questionsInStage, runningContent } from '@/lib/content/loader';
import { listProjectRows, loadDashboard, loadProjectOverview, stageView } from '@/lib/data/projects';
import { NotFoundError } from '@/lib/data/tenant';
import { myMitigations, openMitigationsByStage, stageFollowUpCounts } from '@/lib/data/followup';
import { DashboardView } from '@/components/project/DashboardView';
import { AllProjectsView } from '@/components/project/AllProjectsView';
import { HOME_COPY } from '@/lib/home/copy';
import { resetDb, testDb } from '../helpers/db';
import { sessionFor } from '../helpers/authSession';
import { useFixtureContent } from '../helpers/content';
import {
  addAcceptedRisk, addMitigationVersion, addDecision, addEvidence, addFinding, addIssuedDocument, addProject, addSealRow, addStageReview, buildOrg, ctxFor,
  type OrgFixture,
} from '../helpers/recordFixture';

/**
 * PRJ Task 4: stageView, the per-stage counts of S-10 (FR-PRJ-02). Records are set up with the record fixture builder,
 * never a service. Content is the H0 fixture bundle 0.0.1-fixture (G-17).
 */
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useParams: () => ({ slug: 'x' }),
}));

let fx: OrgFixture;
let p: { id: string };
let cv: string;

beforeAll(async () => {
  cv = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
});

beforeEach(async () => {
  await resetDb();
  cv = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg();
  p = await addProject(fx, { name: 'Counted project' });
  const stage = 'pre-processing' as const;
  // pre-processing: Q-PP-01 done with evidence; Q-PP-02, Q-PP-03 done without; Q-PP-04 partly; Q-PP-05 not_yet;
  // Q-PP-06 not_applicable; Q-PP-07 done then withdrawn; the gate Q-PP-GATE-SENSITIVE answered 'no' (Q-PP-13, Q-PP-14 are gated).
  const ev = await addEvidence(fx, p.id, { kind: 'link', url: 'https://example.org/e' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-01', contentVersionId: cv, status: 'done', evidenceIds: [ev.id] });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-02', contentVersionId: cv, status: 'done' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-03', contentVersionId: cv, status: 'done' });
  const partly = await addDecision(fx, p.id, { stage, questionId: 'Q-PP-04', contentVersionId: cv, status: 'partly' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-05', contentVersionId: cv, status: 'not_yet' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-06', contentVersionId: cv, status: 'not_applicable' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-07', contentVersionId: cv, status: 'done' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-07', contentVersionId: cv, status: 'withdrawn', withdrawalCode: 'entered_in_error' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-GATE-SENSITIVE', contentVersionId: cv, status: null, scopeAnswer: 'no' });
  // F1: a shortfall on Q-PP-04, open, no mitigation. F2: a team finding whose risk is accepted.
  await addFinding(fx, p.id, { stage, source: 'shortfall', questionId: 'Q-PP-04', decisionVersionId: partly.id });
  const f2 = await addFinding(fx, p.id, { stage, source: 'team' });
  await addAcceptedRisk(fx, f2.id, {});
  // one sealed review with one issued data card
  const review = await addStageReview(fx, p.id, { stage });
  const seal = await addSealRow(fx, review.id, { contentVersionId: cv });
  await addIssuedDocument(fx, review.id, { documentType: 'data_card', sealIds: [seal.id] });
  await addDecision(fx, p.id, { stage: 'post-processing', questionId: 'Q-PO-01', contentVersionId: cv, status: 'done' });
});

describe('stageView counts (FR-PRJ-02)', () => {
  it('FR-PRJ-02: each stage count equals the fixture\'s (the fields PRJ computes)', async () => {
    const v = await stageView(ctxFor(fx, 'viewer'), p.id, '2026-11-02');
    const nPre = questionsInStage(runningContent(), 'pre-processing').length;
    expect(v['pre-processing']).toMatchObject({
      questions: nPre, noDecision: nPre - 9, notApplicableByGate: 2,
      byStatus: { done: 3, partly: 1, not_yet: 1, not_applicable: 1 }, doneWithoutEvidence: 2,
      openFindingsWithoutMitigation: 1, acceptedRisks: 1, documentsIssued: 1,
    });
    expect(v['in-processing']).toMatchObject({
      noDecision: questionsInStage(runningContent(), 'in-processing').length,
      byStatus: { done: 0, partly: 0, not_yet: 0, not_applicable: 0 }, acceptedRisks: 0, documentsIssued: 0,
    });
    expect(v['post-processing'].byStatus.done).toBe(1);
  });

  it('FR-PRJ-02: a decision recorded in post-processing first counts there, and only there', async () => {
    const q = await addProject(fx);
    await addDecision(fx, q.id, { stage: 'post-processing', questionId: 'Q-PO-02', contentVersionId: cv, status: 'done' });
    const v = await stageView(ctxFor(fx, 'assessor'), q.id, '2026-11-02');
    expect([v['pre-processing'].byStatus.done, v['in-processing'].byStatus.done, v['post-processing'].byStatus.done]).toEqual([0, 0, 1]);
  });

  it('FR-PRJ-02: a gate answered yes keeps its gated questions in the count of questions with no decision', async () => {
    const q = await addProject(fx);
    await addDecision(fx, q.id, { stage: 'pre-processing', questionId: 'Q-PP-GATE-SENSITIVE', contentVersionId: cv, status: null, scopeAnswer: 'yes' });
    const v = await stageView(ctxFor(fx, 'viewer'), q.id, '2026-11-02');
    const n = questionsInStage(runningContent(), 'pre-processing').length;
    expect(v['pre-processing']).toMatchObject({ notApplicableByGate: 0, noDecision: n - 1 });
  });
});


describe('stageView counts, C4 round 1', () => {
  it('FR-CNT-04 FR-PRJ-02: a question done while its gate was yes and then gated to no counts only in notApplicableByGate', async () => {
    const q = await addProject(fx);
    const stage = 'pre-processing' as const;
    await addDecision(fx, q.id, { stage, questionId: 'Q-PP-GATE-SENSITIVE', contentVersionId: cv, status: null, scopeAnswer: 'yes' });
    await addDecision(fx, q.id, { stage, questionId: 'Q-PP-13', contentVersionId: cv, status: 'done' });
    const before = (await stageView(ctxFor(fx, 'viewer'), q.id, '2026-11-02'))[stage];
    expect(before).toMatchObject({ byStatus: { done: 1 }, doneWithoutEvidence: 1, notApplicableByGate: 0 });
    await addDecision(fx, q.id, { stage, questionId: 'Q-PP-GATE-SENSITIVE', contentVersionId: cv, status: null, scopeAnswer: 'no' });
    const after = (await stageView(ctxFor(fx, 'viewer'), q.id, '2026-11-02'))[stage];
    expect(after).toMatchObject({ byStatus: { done: 0 }, doneWithoutEvidence: 0, notApplicableByGate: 2 });
  });

  it('FR-PRJ-02: a decision on a question that is not in the running content counts nowhere', async () => {
    const q = await addProject(fx);
    await addDecision(fx, q.id, { stage: 'pre-processing', questionId: 'Q-GONE-01', contentVersionId: cv, status: 'done' });
    const v = (await stageView(ctxFor(fx, 'viewer'), q.id, '2026-11-02'))['pre-processing'];
    expect(v).toMatchObject({ byStatus: { done: 0 }, doneWithoutEvidence: 0 });
  });

  it('NFR-SEC-02: stageView of a project of another organisation, or of none, is not found', async () => {
    const fxB = await buildOrg({ label: 'sv' });
    const pB = await addProject(fxB);
    await expect(stageView(ctxFor(fx, 'owner'), pB.id, '2026-11-02')).rejects.toBeInstanceOf(NotFoundError);
    await expect(stageView(ctxFor(fx, 'owner'), randomUUID(), '2026-11-02')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('FR-PRJ-02 FR-PRJ-03: S-10 counts the open and overdue mitigations of an archived project; the reminder and S-08 filter still leaves them out', async () => {
    const q = await addProject(fx, { archived: true });
    const f = await addFinding(fx, q.id, { stage: 'pre-processing', source: 'team' });
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-01' });
    const v = (await stageView(ctxFor(fx, 'viewer'), q.id, '2026-11-02'))['pre-processing'];
    expect(v).toMatchObject({ openFindings: 1, openMitigations: 1, overdueMitigations: 1 });
    expect(await stageFollowUpCounts(ctxFor(fx, 'viewer'), q.id, 'pre-processing', '2026-11-02')).toEqual({ openFindings: 1, overdueMitigations: 0 });
    expect((await openMitigationsByStage(ctxFor(fx, 'viewer'), q.id, '2026-11-02'))['pre-processing']).toHaveLength(0);
    const overview = await loadProjectOverview(ctxFor(fx, 'viewer'), { orgSlug: fx.org.slug, projectId: q.id, today: '2026-11-02' });
    expect(overview!.followUp['pre-processing'].items).toHaveLength(1);
  });
});

const renderDashboard = async (f: OrgFixture, role: 'owner' | 'assessor' | 'viewer', today: string) =>
  renderToStaticMarkup(createElement(DashboardView, { data: await loadDashboard(ctxFor(f, role), { userId: f.members[role].userId }, { orgSlug: f.org.slug, welcome: false, today }) }));

describe('S-10 and S-32 pages (Task 5, Task 7)', () => {
  it('NFR-SEC-02: S-10 for a project of organisation B is not found', async () => {
    const fxB = await buildOrg({ label: 'b' });
    const pB = await addProject(fxB);
    sessionFor(fx.members.owner.userId);
    const { default: ProjectPage } = await import('@/app/(authenticated)/orgs/[slug]/projects/[id]/page');
    await expect(ProjectPage({ params: Promise.resolve({ slug: fx.org.slug, id: pB.id }) }))
      .rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  });

  it('FR-PRJ-02: S-10 of a project of this organisation loads its overview with counts, follow-up and reviews', async () => {
    sessionFor(fx.members.owner.userId);
    const { default: ProjectPage } = await import('@/app/(authenticated)/orgs/[slug]/projects/[id]/page');
    const element = await ProjectPage({ params: Promise.resolve({ slug: fx.org.slug, id: p.id }) });
    expect(element.props.data).toMatchObject({ project: { id: p.id, name: 'Counted project', archived: false } });
    expect(element.props.data.counts['pre-processing'].byStatus.done).toBe(3);
  });

  it('UX-40 UX-37 FR-PRJ-03: S-32 shows 50 projects and a "Show more" link to ?shown=100, and all of them once asked', async () => {
    const many = await buildOrg({ label: 'many' });
    for (let i = 0; i < 51; i++) await addProject(many, { name: `Project ${String(i).padStart(3, '0')}` });
    sessionFor(many.members.owner.userId);
    const { default: AllProjectsPage } = await import('@/app/(authenticated)/orgs/[slug]/projects/page');
    const at = async (searchParams: { shown?: string }) =>
      renderToStaticMarkup(await AllProjectsPage({ params: Promise.resolve({ slug: many.org.slug }), searchParams: Promise.resolve(searchParams) }));
    const first = await at({});
    expect(new Set(first.match(/Project \d{3}/g)).size).toBe(50);
    expect(first).toMatch(/<a [^>]*href="\?shown=100"[^>]*>Show more<\/a>/);
    const all = await at({ shown: '100' });
    expect(new Set(all.match(/Project \d{3}/g)).size).toBe(51);
    expect(all).not.toContain('Show more');
  });

  it('FR-PRJ-03: S-32 lists the archived project under Archived with Unarchive for an owner, and the dashboard leaves it out', async () => {
    await addProject(fx, { name: 'Shelved project', archived: true });
    const { active, archived } = await listProjectRows(ctxFor(fx, 'owner'));
    expect(archived.map((r) => r.name)).toEqual(['Shelved project']);
    expect(active.map((r) => r.name)).toContain('Counted project');
    expect(renderToStaticMarkup(createElement(AllProjectsView, { data: { orgSlug: fx.org.slug, canUnarchive: true, active, archived } }))).toContain('Unarchive');
    const dash = await renderDashboard(fx, 'viewer', '2026-11-02');
    expect(dash).toContain('Counted project'); expect(dash).not.toContain('Shelved project');
    expect(dash).toMatch(/Pre-processing: \d+ open findings?, \d+ overdue mitigations?/);
    expect(dash).not.toMatch(/score|%|maturity/i);
  });

  it('UX-31 FR-PRJ-01: the edit page of an archived project shows the banner and no form', async () => {
    const shelved = await addProject(fx, { name: 'Shelved', archived: true });
    sessionFor(fx.members.owner.userId);
    const { default: EditPage } = await import('@/app/(authenticated)/orgs/[slug]/projects/[id]/edit/page');
    const html = renderToStaticMarkup(await EditPage({ params: Promise.resolve({ slug: fx.org.slug, id: shelved.id }) }));
    expect(html).toContain('This project is archived.'); expect(html).not.toContain('<form');
  });

  it('FR-PRJ-01 FR-AUTHZ-01: the edit page answers 404 for a role without project:update and for another organisation\'s project', async () => {
    const { default: EditPage } = await import('@/app/(authenticated)/orgs/[slug]/projects/[id]/edit/page');
    const notFound = { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' };
    sessionFor(fx.members.viewer.userId);
    await expect(EditPage({ params: Promise.resolve({ slug: fx.org.slug, id: p.id }) })).rejects.toMatchObject(notFound);
    const fxB = await buildOrg({ label: 'b2' });
    const pB = await addProject(fxB);
    sessionFor(fx.members.owner.userId);
    await expect(EditPage({ params: Promise.resolve({ slug: fx.org.slug, id: pB.id }) })).rejects.toMatchObject(notFound);
  });
});

describe('follow-up reads on S-08 and S-10 (Task 9: FUP\'s real bodies)', () => {
  it('FR-PRJ-04: a person owning one overdue mitigation sees it in "my mitigations" with its due date', async () => {
    const q = await addProject(fx);
    const f = await addFinding(fx, q.id, { stage: 'pre-processing', source: 'team' });
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-10-28' });
    const html = await renderDashboard(fx, 'assessor', '2026-11-02');
    expect(html).toContain(HOME_COPY.myMitigations);
    expect(html).toMatch(/>Overdue<\/span>: was due 28 Oct 2026/);
    expect(html).not.toContain(HOME_COPY.noMitigations);
  });

  it('FR-PRJ-04 NFR-SEC-02: my mitigations lists only the signed-in person\'s, and is not empty', async () => {
    const q = await addProject(fx);
    const f = await addFinding(fx, q.id, { stage: 'pre-processing', source: 'team' });
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-10-28' });
    await addMitigationVersion(fx, f.id, { status: 'in_progress', owner: 'viewer', dueDate: '2026-11-20' });
    const items = await myMitigations(ctxFor(fx, 'viewer'), fx.members.viewer.userId, '2026-11-02');
    expect(items).toHaveLength(1);
    expect(items[0].owner.userId).toBe(fx.members.viewer.userId);
    const html = await renderDashboard(fx, 'viewer', '2026-11-02');
    expect(html).toContain('Due 20 Nov 2026');
    expect(html).not.toMatch(/was due 28 Oct 2026/);
  });

  it('FR-PRJ-02 FR-FUP-01: open findings, open and overdue mitigations come from the follow-up service', async () => {
    const f3 = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
    await addMitigationVersion(fx, f3.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-01' });
    const v = await stageView(ctxFor(fx, 'viewer'), p.id, '2026-11-02');
    expect(v['pre-processing']).toMatchObject({ openFindings: 2, openMitigations: 1, overdueMitigations: 1 });
    expect(v['pre-processing'].openFindings).toBe((await stageFollowUpCounts(ctxFor(fx, 'viewer'), p.id, 'pre-processing', '2026-11-02')).openFindings);
    expect((await openMitigationsByStage(ctxFor(fx, 'viewer'), p.id, '2026-11-02'))['pre-processing']).toHaveLength(1);
  });

  it('SRS 11.2: the dashboard of an organisation with a frozen assessment answers and shows no assessment', async () => {
    const fv = await testDb.frameworkVersion.findFirstOrThrow();
    await testDb.assessment.create({ data: { orgId: fx.org.id, projectId: p.id, userId: fx.members.owner.userId, frameworkVersionId: fv.id, engineState: {} } });
    expect(await renderDashboard(fx, 'owner', '2026-11-02')).not.toMatch(/\bAssessments?\b|\bcompleted\b/i);
  });
});

describe('page wiring (C4 round 1)', () => {
  it('FR-PRJ-04 NFR-SEC-02 (P7): the dashboard page lists the signed-in person\'s mitigations whatever the query says', async () => {
    const q = await addProject(fx);
    const f = await addFinding(fx, q.id, { stage: 'pre-processing', source: 'team' });
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2099-01-01' });
    sessionFor(fx.members.viewer.userId);
    const { default: DashboardPage } = await import('@/app/(authenticated)/orgs/[slug]/dashboard/page');
    const element = await DashboardPage({
      params: Promise.resolve({ slug: fx.org.slug }),
      searchParams: Promise.resolve({ userId: fx.members.assessor.userId, welcome: '1' } as never),
    });
    const html = renderToStaticMarkup(element);
    expect(html).not.toContain('Due 1 Jan 2099');   // the assessor's mitigation
    expect(html).toContain(HOME_COPY.noMitigations);
  });

  it('FR-PRJ-03 (P1): S-32 gives Unarchive to owner and admin and to no other role', async () => {
    await addProject(fx, { name: 'Shelved for roles', archived: true });
    const { default: AllProjectsPage } = await import('@/app/(authenticated)/orgs/[slug]/projects/page');
    for (const role of ['owner', 'admin', 'assessor', 'reviewer', 'viewer'] as const) {
      sessionFor(fx.members[role].userId);
      const html = renderToStaticMarkup(await AllProjectsPage({ params: Promise.resolve({ slug: fx.org.slug }), searchParams: Promise.resolve({}) }));
      expect({ role, unarchive: html.includes('Unarchive') }).toEqual({ role, unarchive: role === 'owner' || role === 'admin' });
    }
  });

  it('FR-PRJ-04: S-08 counts the archived projects, so an organisation with only archived ones is not told it has none', async () => {
    const only = await buildOrg({ label: 'onlyarch' });
    await addProject(only, { name: 'Only shelved', archived: true });
    const data = await loadDashboard(ctxFor(only, 'owner'), { userId: only.members.owner.userId }, { orgSlug: only.org.slug, welcome: false, today: '2026-11-02' });
    expect(data.projects).toHaveLength(0);
    expect(data.archivedCount).toBe(1);
    const html = renderToStaticMarkup(createElement(DashboardView, { data }));
    expect(html).toContain(`<p>${HOME_COPY.noActiveProjects}</p>`);   // plain text: the page's All projects link follows it
    expect(html).not.toContain(HOME_COPY.noProjects);
    expect(html.match(new RegExp(`<a[^>]*href="/orgs/${only.org.slug}/projects/new"[^>]*>${HOME_COPY.newProject}</a>`, 'g'))).toHaveLength(1);   // the header's New project, for a creator
    expect(html.indexOf(HOME_COPY.newProject)).toBeLessThan(html.indexOf(HOME_COPY.noActiveProjects));
  });
});
