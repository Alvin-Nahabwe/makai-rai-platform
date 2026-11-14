import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { randomUUID } from 'node:crypto';
import { clearSession, sessionFor } from '../helpers/authSession';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addIssuedDocument, addProject, addStageReview, buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { sealFixture } from '../helpers/sealFixture';
import * as documents from '../../lib/data/documents';
import { can } from '../../lib/authz/policy';
import { REVIEW_COPY } from '../../lib/review/copy';

/**
 * S-16 (the stage review), S-17 (the seal page) and the open form, rendered as each role against a real database: the way
 * back to the project, no heading with nothing under it, the sentence saying who seals, and each issued document as a
 * link to its PDF (workshop walk finding S5).
 */
vi.setConfig({ testTimeout: 60_000 });
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useRouter: () => ({ refresh() {} }) }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-pathname': '/orgs/x/reviews' }) }));
const StageReviewPage = (await import('../../app/(authenticated)/orgs/[slug]/projects/[id]/reviews/[reviewId]/page')).default;

let fxA: OrgFixture;
beforeAll(async () => {
  await resetDb();
  await useFixtureContent('0.0.1-fixture');
  fxA = await buildOrg({ label: 'srpA' });
});
beforeEach(() => { clearSession(); sessionFor(fxA.members.admin.userId); vi.restoreAllMocks(); });

describe('S-16, S-17 and the open form (workshop walk S5): a way back, no empty heading, who seals, and the documents as links', () => {
  const R = REVIEW_COPY.review;
  let project: string;
  let unsealed: string;
  let sealedEmpty: string;
  let sealedWithDocs: string;
  let issued: string;
  let withdrawnDoc: string;
  beforeAll(async () => {
    project = (await addProject(fxA, { name: 'Walk S5 project' })).id;
    unsealed = (await addStageReview(fxA, project, { stage: 'pre-processing' })).id;
    sealedEmpty = (await addStageReview(fxA, project, { stage: 'in-processing' })).id;
    await sealFixture(fxA, sealedEmpty, { projectId: project });
    sealedWithDocs = (await addStageReview(fxA, project, { stage: 'post-processing' })).id;
    const seal = await sealFixture(fxA, sealedWithDocs, { projectId: project });
    issued = (await addIssuedDocument(fxA, sealedWithDocs, { documentType: 'data_card', sealIds: [seal.id] })).id;
    withdrawnDoc = (await addIssuedDocument(fxA, sealedWithDocs, { documentType: 'model_card', sealIds: [seal.id] })).id;
    await documents.withdrawDocument({ orgId: fxA.org.id, role: 'admin' } as never, { userId: fxA.members.admin.userId, role: 'admin' },
      { documentId: withdrawnDoc, requestId: randomUUID(), reason: 'Sent to the wrong committee.' }, randomUUID().replace(/-/g, '').padEnd(64, '0'));
  });
  const s16 = async (reviewId: string) => renderToStaticMarkup(await StageReviewPage({ params: Promise.resolve({ slug: fxA.org.slug, id: project, reviewId }) }));
  const projectHref = () => `/orgs/${fxA.org.slug}/projects/${project}`;
  /** The breadcrumb's items as [label, href or null], in order. */
  const crumbs = (html: string): Array<[string, string | null]> => {
    const nav = html.match(/<nav class="ui-breadcrumb"[^>]*>(.*?)<\/nav>/)?.[1] ?? '';
    return [...nav.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map(([, li]) => [li.replace(/<[^>]*>/g, ''), li.match(/href="([^"]*)"/)?.[1] ?? null]);
  };
  const h1 = (html: string) => html.match(/<h1[^>]*>(.*?)<\/h1>/)?.[1] ?? '';

  it('S5-1: the review page, the open form and the seal page lead back to the project, refusal views included', async () => {
    const openModule = await import('../../app/(authenticated)/orgs/[slug]/projects/[id]/reviews/new/page');
    const sealModule = await import('../../app/(authenticated)/orgs/[slug]/projects/[id]/reviews/[reviewId]/seal/page');
    for (const role of ['owner', 'viewer'] as const) {   // the owner gets each form; the viewer each refusal
      sessionFor(fxA.members[role].userId);
      const review = await s16(unsealed);
      expect([role, crumbs(review)]).toEqual([role, [['Walk S5 project', projectHref()], [h1(review), null]]]);
      const open = renderToStaticMarkup(await openModule.default({ params: Promise.resolve({ slug: fxA.org.slug, id: project }), searchParams: Promise.resolve({}) }));
      expect([role, crumbs(open)]).toEqual([role, [['Walk S5 project', projectHref()], [REVIEW_COPY.titles.openReview, null]]]);
      const seal = renderToStaticMarkup(await sealModule.default({ params: Promise.resolve({ slug: fxA.org.slug, id: project, reviewId: unsealed }) }));
      expect([role, crumbs(seal)]).toEqual([role, [['Walk S5 project', projectHref()], [h1(review), `${projectHref()}/reviews/${unsealed}`], [h1(seal), null]]]);
      if (role === 'viewer') {
        expect(open).toContain(REVIEW_COPY.open.refusal);
        expect(seal).toContain(REVIEW_COPY.sealPage.refusal);
      }
    }
  });

  it('S5-2 S5-3: a review with no seal says who seals it after "Not sealed yet.", and draws no Seals and no Documents heading, for every role', async () => {
    for (const role of ['owner', 'admin', 'reviewer', 'assessor', 'viewer'] as const) {
      sessionFor(fxA.members[role].userId);
      const html = await s16(unsealed);
      expect([role, html.replace(/<!-- -->/g, '')]).toEqual([role, expect.stringContaining('<p>Not sealed yet. An Owner, an Admin or a Reviewer seals this review.</p>')]);
      expect([role, html.includes('id="review-seals"'), html.includes('id="review-documents"')]).toEqual([role, false, false]);
    }
  });

  it('S5-2: a sealed review with no document shows its seals; the Documents heading only for a role that gets the Create a document link', async () => {
    for (const role of ['owner', 'admin', 'reviewer', 'assessor', 'viewer'] as const) {
      sessionFor(fxA.members[role].userId);
      const html = await s16(sealedEmpty);
      expect([role, html.includes('id="review-seals"'), html.includes(R.whoSeals)]).toEqual([role, true, false]);
      expect([role, html.includes('id="review-documents"')]).toEqual([role, can(role, 'document:generate')]);
    }
  });

  it('S5-4: every role sees each issued document of the review, a withdrawn one included, as a link to its PDF with the documents screen\'s words', async () => {
    for (const role of ['owner', 'admin', 'reviewer', 'assessor', 'viewer'] as const) {
      sessionFor(fxA.members[role].userId);
      const html = await s16(sealedWithDocs);
      const section = html.slice(html.indexOf('id="review-documents"'));
      for (const id of [issued, withdrawnDoc]) {
        expect([role, section]).toEqual([role, expect.stringMatching(new RegExp(`<a href="/api/v1/orgs/${fxA.org.slug}/documents/${id}/pdf">Download PDF \\([^)]+\\)</a>`))]);
      }
      expect([role, section.includes('Withdrawn')]).toEqual([role, true]);
    }
  });
});

describe('S-16 separators (workshop walk S12-a)', () => {
  it('the opened-by line and each seal line join their parts with a no-break space, a middle dot and a space, so no wrapped line starts with the dot', async () => {
    const project = (await addProject(fxA, { name: 'Walk S12 project' })).id;
    const review = (await addStageReview(fxA, project, { stage: 'pre-processing' })).id;
    await sealFixture(fxA, review, { projectId: project });
    sessionFor(fxA.members.viewer.userId);
    const html = renderToStaticMarkup(await StageReviewPage({ params: Promise.resolve({ slug: fxA.org.slug, id: project, reviewId: review }) })).replace(/<!-- -->/g, '');
    expect(html).toMatch(/Stage: Pre-processing\u00a0· (Prepared for: [^<]*\u00a0· )?Opened by /);
    expect(html).toMatch(/Seal 1\u00a0· <time[^>]*>[^<]*<\/time>\u00a0· sealed by /);
    expect(html).not.toMatch(/ \. /);
  });
});
