import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from 'next';
import { clearSession, sessionFor } from '../helpers/authSession';
import { resetDb, testDb } from '../helpers/db';
import { addFinding, addProject, addStageReview, buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { pageTitle } from '../../lib/ui/title';
import { HOME_COPY } from '../../lib/home/copy';
import { ORG_COPY } from '../../lib/org/copy';
import { EXPORT_COPY } from '../../lib/export/copy';
import { PROJECT_COPY } from '../../lib/project/copy';
import { FINDINGS_COPY } from '../../lib/findings/copy';
import { REVIEW_COPY } from '../../lib/review/copy';
import { DOCUMENTS_COPY } from '../../lib/documents/copy';
import { DECISION_COPY } from '../../lib/decision/copy';
import { STAGE_TITLE } from '../../lib/question/stageList';
import { STAGE_END_COPY } from '../../lib/question/end/copy';
import { stageReviewName } from '../../lib/seal/reviewName';
import { runningContent } from '../../lib/content/loader';
import { useFixtureContent } from '../helpers/content';

/**
 * Spec 7.5 with R10-2 (Task 10): each of the 20 signed-in pages whose browser-tab title names an organisation or a project
 * reads that name only after the page's own gates. Called as Next calls `generateMetadata`, with a mocked session: a member
 * of another organisation and an unknown organisation get Next's own 404 (so the not-found page's title shows, never no
 * title), a member with the right gets the full title, and a refusal by the page's own gate gets no name.
 */

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-pathname': '/orgs/x/dashboard' }) }));

const NOT_FOUND = { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' };
const ORG = 'app/(authenticated)/orgs/[slug]';
const PRJ = `${ORG}/projects/[id]`;
type Generate = (props: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<Metadata>;
const generate = async (file: string): Promise<Generate> => ((await import(`../../${file}/page`)) as { generateMetadata: Generate }).generateMetadata;
const titleOf = async (file: string, params: Record<string, string>) =>
  (await (await generate(file))({ params: Promise.resolve(params), searchParams: Promise.resolve({}) })).title;

let fxA: OrgFixture;
let fxB: OrgFixture;
const PROJECT = 'Antenatal risk triage';
let projectId: string;
let reviewId: string;
let otherReviewId: string;   // a review of another project of organisation A
let findingId: string;
let findingTitle: string;
const REVIEW = stageReviewName('pre-processing', 1);

beforeAll(async () => {
  await resetDb();
  // The working report's title reads the draft record, which needs the running content version published (Task 10).
  await useFixtureContent('0.0.1-fixture');
  fxA = await buildOrg({ label: 'ttA' });
  fxB = await buildOrg({ label: 'ttB' });
  projectId = (await addProject(fxA, { name: PROJECT })).id;
  reviewId = (await addStageReview(fxA, projectId, { stage: 'pre-processing' })).id;
  otherReviewId = (await addStageReview(fxA, (await addProject(fxA, { name: 'Other project' })).id, { stage: 'pre-processing' })).id;
  findingId = (await addFinding(fxA, projectId, { stage: 'pre-processing', source: 'team' })).id;
  findingTitle = (await testDb.finding.findUniqueOrThrow({ where: { id: findingId }, select: { title: true } })).title ?? '';
});
beforeEach(() => {
  clearSession();
  sessionFor(fxA.members.owner.userId);
});

const q = 'Q-PP-01';
/** Each page: its file, its params under `slug`, and the owner's full title. */
const PAGES = (): Array<[file: string, params: Record<string, string>, title: string]> => {
  const org = fxA.org.name;
  const p = { id: projectId };
  return [
    [`${ORG}/dashboard`, {}, pageTitle(HOME_COPY.titles.home, org)],
    [`${ORG}/export`, {}, pageTitle(EXPORT_COPY.titles.downloadRecords, org)],
    [`${ORG}/projects`, {}, pageTitle(ORG_COPY.titles.projects, org)],
    [`${ORG}/projects/new`, {}, pageTitle(ORG_COPY.titles.newProject, org)],
    [`${ORG}/settings/members`, {}, pageTitle(ORG_COPY.titles.members, org)],
    [`${ORG}/settings/organisation`, {}, pageTitle(ORG_COPY.titles.organisation, org)],
    [PRJ, p, pageTitle(PROJECT_COPY.titles.project, PROJECT)],
    [`${PRJ}/edit`, p, pageTitle(PROJECT_COPY.titles.editProject, PROJECT)],
    [`${PRJ}/export`, p, pageTitle(EXPORT_COPY.titles.downloadRecords, PROJECT)],
    [`${PRJ}/findings`, p, pageTitle(FINDINGS_COPY.titles.findings, PROJECT)],
    [`${PRJ}/report`, p, pageTitle(PROJECT_COPY.titles.workingReport, PROJECT)],
    [`${PRJ}/findings/[findingId]`, { ...p, findingId }, pageTitle(findingTitle, PROJECT)],
    [`${PRJ}/reviews/new`, p, pageTitle(REVIEW_COPY.titles.openReview, PROJECT)],
    [`${PRJ}/reviews/[reviewId]`, { ...p, reviewId }, pageTitle(REVIEW, PROJECT)],
    [`${PRJ}/reviews/[reviewId]/seal`, { ...p, reviewId }, pageTitle(REVIEW_COPY.titles.seal(REVIEW, 1), PROJECT)],
    [`${PRJ}/reviews/[reviewId]/documents`, { ...p, reviewId }, pageTitle(DOCUMENTS_COPY.titles.documentsOf(REVIEW), PROJECT)],
    [`${PRJ}/stages/[stage]`, { ...p, stage: 'pre-processing' }, pageTitle(STAGE_TITLE['pre-processing'], PROJECT)],
    [`${PRJ}/stages/[stage]/end`, { ...p, stage: 'pre-processing' }, pageTitle(STAGE_END_COPY.title, PROJECT)],
    [`${PRJ}/stages/[stage]/questions/[questionId]`, { ...p, stage: 'pre-processing', questionId: q },
      pageTitle(DECISION_COPY.titles.question(q, runningContent().questions.get(q)?.moduleTitle ?? ''), PROJECT)],
    [`${PRJ}/stages/[stage]/questions/[questionId]/history`, { ...p, stage: 'pre-processing', questionId: q }, pageTitle(DECISION_COPY.titles.history(q), PROJECT)],
  ];
};

describe('page titles and tenancy (spec 7.5, R10-2)', () => {
  it('1A R10-2: the 20 signed-in pages that name an organisation or a project are all covered', () => {
    expect(PAGES()).toHaveLength(20);
  });

  it('1A R10-2: a member with the right gets the full title on each of the 20 pages', async () => {
    for (const [file, params, title] of PAGES()) {
      expect({ file, title: await titleOf(file, { slug: fxA.org.slug, ...params }) }).toEqual({ file, title });
    }
  });

  it('1A R10-2a: a member of another organisation gets Next\'s 404 from each of the 20 titles, never a raw error or a title', async () => {
    sessionFor(fxB.members.owner.userId);
    for (const [file, params] of PAGES()) {
      await expect(titleOf(file, { slug: fxA.org.slug, ...params }), file).rejects.toMatchObject(NOT_FOUND);
    }
  });

  it('1A R10-2a: an unknown organisation gets Next\'s 404 from each of the 20 titles, never a raw error or a title', async () => {
    for (const [file, params] of PAGES()) {
      await expect(titleOf(file, { slug: 'no-such-organisation', ...params }), file).rejects.toMatchObject(NOT_FOUND);
    }
  });

  it('1A R10-2: a review of another project is the 404 on the three review pages', async () => {
    for (const page of ['', '/seal', '/documents']) {
      await expect(titleOf(`${PRJ}/reviews/[reviewId]${page}`, { slug: fxA.org.slug, id: projectId, reviewId: otherReviewId }), page)
        .rejects.toMatchObject(NOT_FOUND);
    }
  });

  it('1A R10-10: a viewer, whom the export gate refuses, gets no name; on Open a stage review and Seal the title keeps the project', async () => {
    sessionFor(fxA.members.viewer.userId);
    expect(await titleOf(`${ORG}/export`, { slug: fxA.org.slug })).toBe(pageTitle(EXPORT_COPY.titles.downloadRecords));
    expect(await titleOf(`${PRJ}/export`, { slug: fxA.org.slug, id: projectId })).toBe(pageTitle(EXPORT_COPY.titles.downloadRecords));
    expect(await titleOf(`${PRJ}/reviews/new`, { slug: fxA.org.slug, id: projectId })).toBe(pageTitle(REVIEW_COPY.titles.openReview, PROJECT));
    expect(await titleOf(`${PRJ}/reviews/[reviewId]/seal`, { slug: fxA.org.slug, id: projectId, reviewId }))
      .toBe(pageTitle(REVIEW_COPY.titles.seal(REVIEW, 1), PROJECT));
  });
});
