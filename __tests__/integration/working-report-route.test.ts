import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgRole } from '@prisma/client';
import type { Stage } from '@/types/record';
import { GRANTS } from '@/lib/authz/policy';
import { DOCUMENT_TITLES, WORKING_REPORT_PAGE } from '@/lib/documents/copy';
import { workingReportPages } from '@/lib/documents/workingReport';
import { readWorkingReport } from '@/lib/data/workingReport';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { callRoute, sessionAs } from '../helpers/routeDriver';
import { pdfPageRuns } from '../helpers/pdfText';
import { eatDate } from '@/lib/followup/overdue';

/**
 * Task 9 (path to outputs): the working report PDF route. Design G1, §4 anti-goal 5 (a draft never lands in issued_documents),
 * §5 (read access only; a PDF renders only on its own GET), §7 (one PDF of the whole report, and each draft on its own).
 * Its refusals are compared with the issued-document PDF route's (route 17), the same session and slug, not with copied literals.
 */

vi.setConfig({ testTimeout: 120_000 });

const ROUTE = 'app/api/v1/orgs/[slug]/projects/[id]/working-report/route.ts';
const DOC_PDF = 'app/api/v1/orgs/[slug]/documents/[documentId]/pdf/route.ts';
const PROJECT_NAME = 'Kisumu harvest: Nyanza forecasts';

let fx: OrgFixture;
let contentVersionId: string;
let projectId: string;

const get = (a: { slug?: string; id?: string; part?: string } = {}) =>
  callRoute(ROUTE, 'GET', { slug: a.slug ?? fx.org.slug, params: { id: a.id ?? projectId }, query: a.part === undefined ? {} : { part: a.part } });
const getDocPdf = (slug: string) => callRoute(DOC_PDF, 'GET', { slug, params: { documentId: '00000000-0000-4000-8000-000000000000' } });
const answer = (stage: Stage, questionId: string, pid = projectId) =>
  addDecision(fx, pid, { stage, questionId, contentVersionId, status: 'done', decidedBy: { kind: 'member', userId: fx.members.owner.userId }, declaredDate: '2026-10-30' });
const pdfOf = async (r: Response): Promise<Buffer> => Buffer.from(await r.arrayBuffer());
/** The draft line names the second the answers were read, which differs between two requests; everything else on a page must not. */
const sameDay = (runs: string[]): string[] => runs.map((s) => s.replace(/Draft · from answers as of [^,]+, \S+/g, 'Draft'));
const READERS = (Object.entries(GRANTS) as Array<[OrgRole, readonly string[]]>).filter(([, a]) => a.includes('record:read')).map(([r]) => r);

beforeEach(async () => {
  await resetDb();
  ({ contentVersionId } = await useFixtureContent('0.0.1-fixture'));
  fx = await buildOrg({ label: 'wrr' });
  projectId = (await addProject(fx, { name: PROJECT_NAME })).id;
  await answer('pre-processing', 'Q-PP-12');
  await answer('in-processing', 'Q-IP-01');
  sessionAs(fx.members.viewer.userId);
});

describe('working report route: who may download', () => {
  it('every role with record:read gets 200 application/pdf', async () => {
    expect(READERS.length).toBe(Object.keys(GRANTS).length);   // every role reads today; a role losing it would shrink this loop, not hide it
    for (const role of READERS) {
      sessionAs(fx.members[role].userId);
      const r = await get();
      expect([role, r.status, r.headers.get('content-type')]).toEqual([role, 200, 'application/pdf']);
      const bytes = await pdfOf(r);
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(r.headers.get('content-length')).toBe(String(bytes.length));
    }
  });

  it('Review Focus 3: a Viewer downloads the report of an archived project', async () => {
    const archived = (await addProject(fx, { archived: true })).id;
    await answer('pre-processing', 'Q-PP-12', archived);
    sessionAs(fx.members.viewer.userId);
    const r = await get({ id: archived });
    expect([r.status, r.headers.get('content-type')]).toEqual([200, 'application/pdf']);
  });

  it('another organisation\'s project is 404, same body as a missing one', async () => {
    const b = await buildOrg({ label: 'wrr-b' });
    // A member of B, on B's slug, asking for A's project: row-level security makes it a missing project.
    sessionAs(b.members.admin.userId);
    const foreign = await get({ slug: b.org.slug });
    const missing = await get({ slug: b.org.slug, id: '00000000-0000-4000-8000-000000000000' });
    const routeFor = await getDocPdf(b.org.slug);   // route 17's answer to a document it does not hold
    const body = await routeFor.json();
    expect([foreign.status, await foreign.json()]).toEqual([routeFor.status, body]);
    expect([missing.status, await missing.json()]).toEqual([404, body]);
    // A member of A on B's slug (not a member there): the same answer route 17 gives that request.
    sessionAs(fx.members.admin.userId);
    const nonMember = await get({ slug: b.org.slug });
    const nonMemberDoc = await getDocPdf(b.org.slug);
    expect([nonMember.status, await nonMember.json()]).toEqual([nonMemberDoc.status, await nonMemberDoc.json()]);
    expect(nonMember.status).toBe(404);
  });

  it('a request with no session is refused as route 17 refuses it', async () => {
    sessionAs(null);
    const r = await get();
    const doc = await getDocPdf(fx.org.slug);
    expect(r.status).toBe(401);
    expect([r.status, await r.json()]).toEqual([doc.status, await doc.json()]);
  });

  it('a malformed project id is a 404, not a 500', async () => {
    const r = await get({ id: 'not-a-project' });
    expect(r.status).toBe(404);
  });
});

describe('working report route: what it writes and sends', () => {
  it('anti-goal 5: a download writes no row to issued_documents', async () => {
    const before = [await testDb.issuedDocument.count(), await testDb.seal.count(), await testDb.issuedDocumentSource.count()];
    for (const part of [undefined, 'summary', 'data_card', 'model_card', 'mitigation_plan:pre-processing']) {
      expect((await get({ part })).status).toBe(200);
    }
    expect([await testDb.issuedDocument.count(), await testDb.seal.count(), await testDb.issuedDocumentSource.count()]).toEqual(before);
  });

  it('Content-Disposition holds no project name and no colon', async () => {
    const day = eatDate(new Date());   // the day the answers were read, in the platform's zone
    const cases: Array<[string | undefined, string]> = [
      [undefined, 'all'], ['all', 'all'], ['summary', 'summary'], ['data_card', 'data-card'], ['model_card', 'model-card'],
      ['mitigation_plan:in-processing', 'mitigation-plan-in-processing'],
    ];
    for (const [part, name] of cases) {
      const r = await get({ part });
      const cd = r.headers.get('content-disposition') ?? '';
      expect(cd).toBe(`attachment; filename="working-report-draft-${day}-${name}.pdf"`);
      expect(cd.split('filename=')[1]).not.toContain(':');
      for (const w of PROJECT_NAME.split(/\W+/).filter((x) => x.length > 3)) expect(cd).not.toContain(w);
    }
  });

  it('a draft is never stored by a cache: Cache-Control is no-store', async () => {
    const r = await get();
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('part=all is summary, data card, model card, then one plan per stage with answers, in STAGES order', async () => {
    const { record } = await readWorkingReport(ctxFor(fx, 'viewer'), { userId: fx.members.viewer.userId, role: 'viewer' }, projectId);
    expect(record.stagesWithAnswers).toEqual(['pre-processing', 'in-processing']);
    const titleOf = (p: ReturnType<typeof workingReportPages>[number]) => (p.kind === 'summary' ? WORKING_REPORT_PAGE.title : `${DOCUMENT_TITLES[p.documentType]}:${p.reviewStage}`);
    expect(workingReportPages(record, 'all').map(titleOf)).toEqual([
      WORKING_REPORT_PAGE.title, 'Data card:pre-processing', 'Model card:in-processing', 'Mitigation plan:pre-processing', 'Mitigation plan:in-processing',
    ]);

    // m1: the whole report is each part's own PDF, page for page, in that order.
    const all = pdfPageRuns(await pdfOf(await get()));
    let at = 0;
    for (const part of ['summary', 'data_card', 'model_card', 'mitigation_plan:pre-processing', 'mitigation_plan:in-processing']) {
      const own = pdfPageRuns(await pdfOf(await get({ part })));
      expect(own.length, part).toBeGreaterThan(0);
      expect(sameDay(all[at]), `${part}: its first page sits at page ${at + 1} of the whole report`).toEqual(sameDay(own[0]));
      at += own.length;
    }
    expect(at).toBe(all.length);
  });

  it('part=mitigation_plan:post-processing is 404 when that stage has no answers', async () => {
    const r = await get({ part: 'mitigation_plan:post-processing' });
    const doc = await getDocPdf(fx.org.slug);
    expect([r.status, await r.json()]).toEqual([404, await doc.json()]);
    await answer('post-processing', 'Q-PO-01');
    expect((await get({ part: 'mitigation_plan:post-processing' })).status).toBe(200);
  });

  it('a part that is not one of the report\'s parts is a 422 on field part, never a 500', async () => {
    for (const part of ['', 'everything', 'mitigation_plan', 'mitigation_plan:', 'mitigation_plan:deployment', 'DATA_CARD', 'summary ', 'data-card']) {
      const r = await get({ part });
      const json = await r.json();
      expect([JSON.stringify(part), r.status, json.code]).toEqual([JSON.stringify(part), 422, 'validation']);
      expect(JSON.stringify(json)).toContain('part');
    }
  });

  it('a malformed part from a non-member is refused for membership, not for the part', async () => {
    const b = await buildOrg({ label: 'wrr-c' });
    sessionAs(b.members.admin.userId);
    const r = await get({ part: 'everything' });
    expect(r.status).toBe(404);
  });
});
