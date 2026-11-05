import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { clearSession, sessionFor } from '../helpers/authSession';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addProject, addStageReview, buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { sealFixture } from '../helpers/sealFixture';
import * as documents from '../../lib/data/documents';
import { NO_DOCUMENTS_LINE } from '../../components/documents/GenerateDocumentForm';
import { TYPED_MARK } from '../../lib/documents/copy';

vi.setConfig({ testTimeout: 60_000 });
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-pathname': '/orgs/x/documents' }) }));
const pageModule = await import('../../app/(authenticated)/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents/page');
const DocumentsPage = pageModule.default;
const reviewModule = await import('../../app/(authenticated)/orgs/[slug]/projects/[id]/reviews/[reviewId]/page');
const StageReviewPage = reviewModule.default;

let fxA: OrgFixture;
let fxB: OrgFixture;
let projectOfA: string;
let otherProjectOfA: string;
let projectOfB: string;
let reviewOfA: string;
let unsealedReviewOfA: string;
let reviewOfB: string;

beforeAll(async () => {
  await resetDb();
  const { contentVersionId } = await useFixtureContent('0.0.1-fixture');
  fxA = await buildOrg({ label: 'pgdA' });
  fxB = await buildOrg({ label: 'pgdB' });
  projectOfA = (await addProject(fxA)).id;
  otherProjectOfA = (await addProject(fxA)).id;
  projectOfB = (await addProject(fxB)).id;
  const d = await addDecision(fxA, projectOfA, { stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'done', decidedBy: { kind: 'member', userId: fxA.members.owner.userId }, declaredDate: '2026-10-30' });
  reviewOfA = (await addStageReview(fxA, projectOfA, { stage: 'pre-processing' })).id;
  unsealedReviewOfA = (await addStageReview(fxA, projectOfA, { stage: 'in-processing' })).id;
  reviewOfB = (await addStageReview(fxB, projectOfB, { stage: 'pre-processing' })).id;
  await sealFixture(fxA, reviewOfA, { projectId: projectOfA, stage: 'pre-processing', contentVersionId, decisionVersionIds: [d.id] });
  await testDb.documentDraftFields.create({ data: { orgId: fxA.org.id, projectId: projectOfA, documentType: 'data_card', fieldValues: { 'DC-25': 'Draft licence text' }, updatedById: fxA.members.owner.userId } });
});
beforeEach(() => { clearSession(); sessionFor(fxA.members.admin.userId); vi.restoreAllMocks(); });

const render = async (reviewId: string, id = projectOfA) => renderToStaticMarkup(await DocumentsPage({ params: Promise.resolve({ slug: fxA.org.slug, id, reviewId }) }));

describe('S-18', () => {
  it('NFR-SEC-02: S-18 for a stage review of organisation B is not found', async () => {
    const spy = vi.spyOn(documents, 'listDocuments');
    for (const params of [
      { slug: fxA.org.slug, id: projectOfA, reviewId: reviewOfB }, { slug: fxA.org.slug, id: projectOfB, reviewId: reviewOfB }, { slug: fxA.org.slug, id: otherProjectOfA, reviewId: reviewOfA },
    ]) await expect(DocumentsPage({ params: Promise.resolve(params) })).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('FR-DOC-01 FR-DOC-03 UX-20: a sealed review shows the form with the three documents, the draft and the summary, and the empty issued list', async () => {
    const html = await render(reviewOfA);
    expect(html).toMatch(/<h1[^>]*>Generate a document<\/h1>/);
    expect(['>Data card<', '>Model card<', '>Mitigation plan<'].map((t) => html.indexOf(t)).every((x) => x > 0)).toBe(true);
    expect(html).toContain('value="Draft licence text"');
    expect(html).toContain(TYPED_MARK);
    expect(html).toMatch(/\d+ fields from \d+ questions/);
    expect(html).toContain(NO_DOCUMENTS_LINE);
    expect(html).toContain('Seal 1,');
  });

  it('FR-DOC-05 UX-20 (7.4.2 S-18): a review never sealed shows the line and the link to seal it, and no form', async () => {
    const html = await render(unsealedReviewOfA);
    expect(html).toContain('This review has not been sealed yet. Documents come from a seal.');
    expect(html).toContain('Seal this review');
    expect(html).not.toContain('type="radio"');
  });

  it('UX-20: no generate form for an assessor; FR-DOC-03 D12: a viewer\'s S-18 holds no draft value', async () => {
    for (const role of ['assessor', 'viewer'] as const) {
      sessionFor(fxA.members[role].userId);
      const html = await render(reviewOfA);
      expect([role, html.includes('type="radio"')]).toEqual([role, false]);
      expect([role, html.includes('Draft licence text')]).toEqual([role, false]);
      expect(html).toContain(NO_DOCUMENTS_LINE);
    }
  });

  it('UX-31: an archived project shows the archived banner on S-18 and no form', async () => {
    const archived = (await addProject(fxA, { archived: true })).id;
    const review = (await addStageReview(fxA, archived, { stage: 'pre-processing' })).id;
    const html = await render(review, archived);
    expect(html).toContain('This project is archived.');
    expect(html).not.toContain('type="radio"');
  });

  it('FR-DOC-01 UX-20 (S-16): a role that may generate sees exactly one "Generate a document" link on S-16, issued documents included, and a viewer sees none', async () => {
    const stageReview = async () => renderToStaticMarkup(await StageReviewPage({ params: Promise.resolve({ slug: fxA.org.slug, id: projectOfA, reviewId: reviewOfA }) }));
    for (const role of ['owner', 'admin', 'reviewer'] as const) {
      sessionFor(fxA.members[role].userId);
      expect([role, (await stageReview()).split('Generate a document').length - 1]).toEqual([role, 1]);
    }
    for (const role of ['assessor', 'viewer'] as const) {
      sessionFor(fxA.members[role].userId);
      expect([role, (await stageReview()).split('Generate a document').length - 1]).toEqual([role, 0]);
    }
  });
});
