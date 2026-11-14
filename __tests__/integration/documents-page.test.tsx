import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { clearSession, sessionFor } from '../helpers/authSession';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addEvidence, addProject, addStageReview, buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { randomUUID } from 'node:crypto';
import { sealFixture } from '../helpers/sealFixture';
import { withTriggersDisabled } from '../helpers/triggers';
import { AppError } from '../../lib/http/errors';
import { addIssuedDocument } from '../helpers/recordFixture';
import * as documents from '../../lib/data/documents';
import { NO_DOCUMENTS_LINE } from '../../components/documents/GenerateDocumentForm';
import { captureLogs } from '../helpers/logCapture';
import { can } from '../../lib/authz/policy';
import { DOCUMENTS_COPY, MSG_SEAL_CHECK_FAILED } from '../../lib/documents/copy';
import { REVIEW_COPY } from '../../lib/review/copy';

vi.setConfig({ testTimeout: 60_000 });
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useRouter: () => ({ refresh() {} }) }));
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
let sealOfA: string;
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
  await addDecision(fxA, projectOfA, { stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'done', decidedBy: { kind: 'member', userId: fxA.members.owner.userId }, declaredDate: '2026-10-30' });
  reviewOfA = (await addStageReview(fxA, projectOfA, { stage: 'pre-processing' })).id;
  unsealedReviewOfA = (await addStageReview(fxA, projectOfA, { stage: 'in-processing' })).id;
  reviewOfB = (await addStageReview(fxB, projectOfB, { stage: 'pre-processing' })).id;
  sealOfA = (await sealFixture(fxA, reviewOfA, { projectId: projectOfA })).id;
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

  it('FR-DOC-01 FR-DOC-03 UX-20: a sealed review shows the form with the documents that have a generator, the draft and the summary, and the empty issued list', async () => {
    const html = await render(reviewOfA);
    expect(html).toMatch(/<h1[^>]*>Create a document<\/h1>/);
    expect(['>Data card<', '>Model card<'].map((t) => html.indexOf(t)).every((x) => x > 0)).toBe(true);
    expect(html).toContain('value="Draft licence text"');
    expect(html).toContain('They are not part of the sealed record.');
    expect(html).toMatch(/\d+ fields from \d+ questions/);
    expect(html).toContain(NO_DOCUMENTS_LINE);
    expect(html).toContain('Seal 1,');
  });

  it('FR-DOC-05 UX-20 (7.4.2 S-18): a review never sealed shows the line and the link to seal it, and no form', async () => {
    const html = await render(unsealedReviewOfA);
    expect(html).toContain(DOCUMENTS_COPY.form.neverSealed);
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
      expect([role, (await stageReview()).split(REVIEW_COPY.review.createDocument).length - 1]).toEqual([role, 1]);
    }
    for (const role of ['assessor', 'viewer'] as const) {
      sessionFor(fxA.members[role].userId);
      expect([role, (await stageReview()).split(REVIEW_COPY.review.createDocument).length - 1]).toEqual([role, 0]);
    }
  });

  it('FR-DOC-01 UX-20 (S-18): the mitigation plan is offered, after the data card and the model card, to every role that may generate', async () => {
    for (const role of ['owner', 'admin', 'reviewer'] as const) {
      sessionFor(fxA.members[role].userId);
      const html = await render(reviewOfA);
      expect([role, html.includes('value="mitigation_plan"')]).toEqual([role, true]);
      const at = ['>Data card<', '>Model card<', '>Mitigation plan<'].map((t) => html.indexOf(t));
      expect([role, at.every((x) => x > 0), [...at].sort((a, b) => a - b)]).toEqual([role, true, at]);
    }
    for (const role of ['assessor', 'viewer'] as const) {
      sessionFor(fxA.members[role].userId);
      expect([role, (await render(reviewOfA)).includes('value="mitigation_plan"')]).toEqual([role, false]);
    }
  });

  it('NFR-INT-05 (C4 CR-6): a seal failure while the summaries are read does not take S-18 down: the failed-check line stands where the form was, and the issued list and its download stay', async () => {
    const issued = await addIssuedDocument(fxA, reviewOfA, { documentType: 'data_card', sealIds: [sealOfA] });
    vi.spyOn(documents, 'documentSummaries').mockRejectedValue(new AppError(500, 'integrity_failure', 'Document integrity check failed'));
    const { result: html, lines } = await captureLogs(() => render(reviewOfA));
    expect(lines.filter((l) => l.includes('SEAL_CHECK_FAILED')).map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ level: 'error', details: expect.objectContaining({ sealId: sealOfA }) })]);
    expect(html).toContain(MSG_SEAL_CHECK_FAILED);
    expect(html).not.toContain('type="radio"');
    expect(html).toContain(`/documents/${issued.id}/pdf`);
    vi.restoreAllMocks();
  });

  it('NFR-INT-05 (C4 F11): when every seal of the review fails its check the page says so in place of the form, and keeps the issued list', async () => {
    const review = (await addStageReview(fxA, otherProjectOfA, { stage: 'pre-processing' })).id;
    const seal = await sealFixture(fxA, review, { projectId: otherProjectOfA });
    const issued = await addIssuedDocument(fxA, review, { documentType: 'model_card', sealIds: [seal.id] });
    await withTriggersDisabled('seals', () => testDb.$executeRaw`UPDATE seals SET manifest = manifest || '\x20'::bytea WHERE id = ${seal.id}`);
    const { result: html, lines } = await captureLogs(() => render(review, otherProjectOfA));
    expect(lines.filter((l) => l.includes('SEAL_CHECK_FAILED')).map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ level: 'error', details: expect.objectContaining({ sealId: seal.id }) })]);
    expect(html).toContain(MSG_SEAL_CHECK_FAILED);
    expect(html).not.toContain('type="radio"');
    expect(html).toContain(`/documents/${issued.id}/pdf`);
  });

  it('FR-REV-08 (C4 RE-1): after erase_text_field on the file name a document printed, S-16 and S-18 still render for every role and list the document as erased', async () => {
    const { contentVersionId } = await useFixtureContent('0.0.1-fixture');
    const project = (await addProject(fxA)).id;
    const ev = await addEvidence(fxA, project, { kind: 'file', fileName: 'protocol.pdf' });
    await withTriggersDisabled('evidence', () => testDb.$executeRawUnsafe(`UPDATE evidence SET "filenameSalt" = decode(md5(random()::text), 'hex') WHERE id = '${ev.id}'`));
    await addDecision(fxA, project, { stage: 'pre-processing', questionId: 'Q-PP-13', contentVersionId, status: 'done', decidedBy: { kind: 'member', userId: fxA.members.owner.userId }, declaredDate: '2026-10-30', evidenceIds: [ev.id] });
    const review = (await addStageReview(fxA, project, { stage: 'pre-processing' })).id;
    const seal = await sealFixture(fxA, review, { projectId: project });
    await documents.issueDocument({ orgId: fxA.org.id, role: 'admin' } as never, { userId: fxA.members.admin.userId, role: 'admin' },
      { projectId: project, reviewId: review, sealId: seal.id, documentType: 'data_card', typedFields: {}, requestId: randomUUID() }, randomUUID().replace(/-/g, '').padEnd(64, '0'));
    await testDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE makrai_operator_fn');
      await tx.$executeRawUnsafe(`SELECT erase_text_field('${fxA.org.id}','evidence','${ev.id}','fileName','ER','I')`);
    });
    for (const role of ['owner', 'admin', 'reviewer', 'assessor', 'viewer'] as const) {
      sessionFor(fxA.members[role].userId);
      const s18 = await render(review, project);
      expect([role, s18.includes('File erased on ')]).toEqual([role, true]);
      expect([role, s18.includes('/pdf')]).toEqual([role, false]);
      const s16 = renderToStaticMarkup(await StageReviewPage({ params: Promise.resolve({ slug: fxA.org.slug, id: project, reviewId: review }) }));
      expect([role, s16.includes('Data card . from seal 1')]).toEqual([role, true]);
    }
  });

  it('S-16: the seal explanation link sits in the Status section after the state line, and the time-stamp sentence is not on screen', async () => {
    const { SEAL_PROOF_HREF } = await import('../../components/review/reviewText');
    for (const review of [reviewOfA, unsealedReviewOfA]) {
      const html = renderToStaticMarkup(await StageReviewPage({ params: Promise.resolve({ slug: fxA.org.slug, id: projectOfA, reviewId: review }) }));
      expect(html).not.toContain('independently time-stamped');
      const status = html.slice(html.indexOf('<h2 id="review-state">'), html.indexOf('</section>', html.indexOf('<h2 id="review-state">')));
      expect(status).toMatch(new RegExp(`^<h2 id="review-state">Status</h2><p>(?:[^<]|<!-- -->)*</p><p><a href="${SEAL_PROOF_HREF}">What sealing means</a></p>`));
      expect(html.match(/What sealing means/g)).toHaveLength(1);
    }
  });

  it('FR-DOC-01: S-18 shows no UNCST or Uganda-only table, for a sealed or never-sealed review and every role', async () => {
    // CONSOLIDATED section 4 (owner ruling, country content): the UNCST table and its heading left S-18.
    for (const role of ['owner', 'admin', 'reviewer', 'assessor', 'viewer'] as const) {
      sessionFor(fxA.members[role].userId);
      for (const review of [reviewOfA, unsealedReviewOfA]) {
        const html = await render(review);
        expect(html, role).toMatch(/<h1[^>]*>Create a document<\/h1>/);   // not vacuous: the page rendered
        expect(html, role).not.toMatch(/UNCST|AI protocol|<table[\s>]/i);
      }
      const sealed = await render(reviewOfA);
      expect(sealed.indexOf('id="documents-issued"'), role).toBeGreaterThan(-1);   // the issued list stays on the page
      if (can(role, 'document:generate')) expect(sealed, role).toContain('>Data card<');   // and the form, for the roles that generate
    }
  });
});
