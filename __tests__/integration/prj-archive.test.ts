import { randomUUID, createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { PENDING_ROUTES, RETRY_KEYED_WRITES, UNKEYED_WRITES } from '@/lib/authz/routeActions';
import { projectHasRecords } from '@/lib/data/projects';
import { withOrg } from '@/lib/data/tenant';
import { assertProjectWritable } from '@/lib/data/projectGuard';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import {
  addDecision, addEvidence, addFinding, addIssuedDocument, addProject, addSealRow, addStageReview, buildOrg, ctxFor, type OrgFixture,
} from '../helpers/recordFixture';
import { callRoute, sessionAs, type Method } from '../helpers/routeDriver';

/**
 * PRJ Task 2: archive, unarchive and delete a project only when it holds no record (routes 21, 22 and 24 DELETE;
 * FR-PRJ-03, NFR-SEC-02, NFR-SEC-08, NFR-INT-02). The real handlers run behind AUTHZ's route driver; every record
 * is set up with the record fixture builder, never a service.
 */
const ARCHIVE = 'app/api/v1/orgs/[slug]/projects/[id]/archive/route.ts';
const UNARCHIVE = 'app/api/v1/orgs/[slug]/projects/[id]/unarchive/route.ts';
const PROJECT = 'app/api/v1/orgs/[slug]/projects/[id]/route.ts';
const PDF_ROUTE = 'app/api/v1/orgs/[slug]/documents/[documentId]/pdf/route.ts';
const REQ = '3f6b8d0e-2c4a-4b1d-9e7f-5a1c3e5d7b90';
let fx: OrgFixture;
let fxB: OrgFixture;
let p: { id: string };

interface Opts { origin?: string; requestId?: string }
function send(f: OrgFixture, method: Method, file: string, role: OrgRole, id: string, o: Opts = {}) {
  sessionAs(f.members[role].userId);
  return callRoute(file, method, {
    slug: f.org.slug, params: { id }, origin: o.origin === undefined || o.origin === 'own' ? undefined : o.origin,
    body: { requestId: o.requestId ?? randomUUID() },
  });
}
const post = (f: OrgFixture, file: string, role: OrgRole, id: string, o?: Opts) => send(f, 'POST', file, role, id, o);
const del = (f: OrgFixture, role: OrgRole, id: string, o?: Opts) => send(f, 'DELETE', PROJECT, role, id, o);
const receiptsOf = (orgId: string) => testDb.requestReceipt.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
const projectRowCounts = async () => ({
  projects: await testDb.project.count(), metadata: await testDb.projectMetadata.count(), receipts: await testDb.requestReceipt.count(),
});
const codeOf = async (r: Response) => ({ status: r.status, code: (await r.json()).code });
const archivedAtOf = async (id: string) => (await testDb.project.findUniqueOrThrow({ where: { id } })).archivedAt;

beforeEach(async () => {
  await resetDb();
  fx = await buildOrg();
  fxB = await buildOrg({ label: 'b' });
  p = await addProject(fx, { name: 'To archive' });
});

describe('archive and unarchive (routes 21 and 22)', () => {
  it('FR-PRJ-03: owner and admin archive and unarchive; assessor, reviewer and viewer get 403', async () => {
    for (const role of ['assessor', 'reviewer', 'viewer'] as const) expect((await post(fx, ARCHIVE, role, p.id)).status).toBe(403);
    expect((await post(fx, ARCHIVE, 'admin', p.id)).status).toBe(204);
    expect(await codeOf(await post(fx, ARCHIVE, 'owner', p.id))).toEqual({ status: 409, code: 'already_archived' });
    for (const role of ['assessor', 'reviewer', 'viewer'] as const) expect((await post(fx, UNARCHIVE, role, p.id)).status).toBe(403);
    expect((await post(fx, UNARCHIVE, 'owner', p.id)).status).toBe(204);
    expect(await codeOf(await post(fx, UNARCHIVE, 'admin', p.id))).toEqual({ status: 409, code: 'not_archived' });
  });

  it('NFR-SEC-02 NFR-SEC-08: archive and unarchive of another organisation\'s project answer 404; another origin 403', async () => {
    expect((await post(fxB, ARCHIVE, 'owner', p.id)).status).toBe(404);
    expect((await post(fxB, UNARCHIVE, 'owner', p.id)).status).toBe(404);
    expect(await archivedAtOf(p.id)).toBeNull();
    expect(await (await post(fx, ARCHIVE, 'owner', p.id, { origin: 'https://evil.example' })).json()).toMatchObject({ code: 'cross_origin' });
    expect(await archivedAtOf(p.id)).toBeNull();
    expect((await post(fx, ARCHIVE, 'owner', p.id, { origin: 'own' })).status).not.toBe(403);
  });

  it('FR-PRJ-03: a project that does not exist answers 404 on both routes', async () => {
    expect((await post(fx, ARCHIVE, 'owner', randomUUID())).status).toBe(404);
    expect((await post(fx, UNARCHIVE, 'owner', randomUUID())).status).toBe(404);
  });

  it('NFR-INT-02: a replay of archive or unarchive answers 204 again, not 409, and writes nothing; the same id for another project answers 409 request_id_reused', async () => {
    const p2 = await addProject(fx);
    expect((await post(fx, ARCHIVE, 'owner', p.id, { requestId: REQ })).status).toBe(204);
    const archivedAt = await archivedAtOf(p.id);
    const before = await projectRowCounts();
    expect((await post(fx, ARCHIVE, 'owner', p.id, { requestId: REQ })).status).toBe(204);   // without the receipt: 409 already_archived
    expect(await archivedAtOf(p.id)).toEqual(archivedAt);
    expect(await projectRowCounts()).toEqual(before);
    expect(await codeOf(await post(fx, ARCHIVE, 'owner', p2.id, { requestId: REQ }))).toEqual({ status: 409, code: 'request_id_reused' });
    expect(await archivedAtOf(p2.id)).toBeNull();
    const UNREQ = 'b3c1c4a8-6a46-4d6c-9a43-7b8c1e1f2a10';
    expect((await post(fx, UNARCHIVE, 'owner', p.id, { requestId: UNREQ })).status).toBe(204);
    expect((await post(fx, UNARCHIVE, 'owner', p.id, { requestId: UNREQ })).status).toBe(204);   // without the receipt: 409 not_archived
    expect(await receiptsOf(fx.org.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: REQ, route: `${ARCHIVE}::POST`, rowId: null }),
      expect.objectContaining({ requestId: UNREQ, route: `${UNARCHIVE}::POST`, rowId: null })]));
  });

  it('NFR-INT-02: archive with a request id, then unarchive with the same id: 409 request_id_reused, and the project stays archived', async () => {
    expect((await post(fx, ARCHIVE, 'owner', p.id, { requestId: REQ })).status).toBe(204);
    expect(await codeOf(await post(fx, UNARCHIVE, 'owner', p.id, { requestId: REQ }))).toEqual({ status: 409, code: 'request_id_reused' });
    expect(await archivedAtOf(p.id)).not.toBeNull();
    expect(await receiptsOf(fx.org.id)).toEqual([expect.objectContaining({ requestId: REQ, route: `${ARCHIVE}::POST` })]);
  });

  it('NFR-INT-02: a project write without a request id answers 422 on requestId on routes 21 and 22 and changes nothing', async () => {
    for (const file of [ARCHIVE, UNARCHIVE]) {
      sessionAs(fx.members.owner.userId);
      const r = await callRoute(file, 'POST', { slug: fx.org.slug, params: { id: p.id }, body: {} });
      expect(r.status).toBe(422);
      expect((await r.json()).fields).toEqual([expect.objectContaining({ field: 'requestId' })]);
    }
    expect(await archivedAtOf(p.id)).toBeNull();
  });
});

describe('delete only when empty (route 24 DELETE)', () => {
  it('NFR-INT-02: a replay of delete answers 200 again with { success: true }, not 404; the same id for another project answers 409 request_id_reused and deletes nothing', async () => {
    const gone = await addProject(fx); const kept = await addProject(fx);
    const first = await del(fx, 'owner', gone.id, { requestId: REQ });
    expect([first.status, await first.json()]).toEqual([200, { success: true }]);
    const before = await projectRowCounts();
    const again = await del(fx, 'owner', gone.id, { requestId: REQ });   // the project is gone: without the receipt this is the coded 404
    expect([again.status, await again.json()]).toEqual([200, { success: true }]);
    expect(await projectRowCounts()).toEqual(before);
    expect(await codeOf(await del(fx, 'owner', kept.id, { requestId: REQ }))).toEqual({ status: 409, code: 'request_id_reused' });
    expect(await testDb.project.count({ where: { id: kept.id } })).toBe(1);
  });

  it('NFR-INT-02: a delete refused for records leaves no receipt (the refusal rolls the transaction back)', async () => {
    const sealed = await addProject(fx);
    await addStageReview(fx, sealed.id, { stage: 'pre-processing' });
    expect(await codeOf(await del(fx, 'owner', sealed.id, { requestId: REQ }))).toEqual({ status: 409, code: 'project_has_records' });
    expect(await receiptsOf(fx.org.id)).toEqual([]);
  });

  it('FR-PRJ-03: a project with one sealed review cannot be deleted: 409 and the project remains', async () => {
    const sealed = await addProject(fx);
    const r = await addStageReview(fx, sealed.id, { stage: 'pre-processing' });
    await addSealRow(fx, r.id);
    const res = await del(fx, 'owner', sealed.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'project_has_records' });
    expect(await testDb.project.count({ where: { id: sealed.id } })).toBe(1);
  });

  it('FR-PRJ-03: only owner and admin may delete; an empty project is removed', async () => {
    for (const role of ['assessor', 'reviewer', 'viewer'] as const) expect((await del(fx, role, p.id)).status).toBe(403);
    expect((await del(fx, 'admin', p.id)).status).toBe(200);
    expect(await testDb.project.count({ where: { id: p.id } })).toBe(0);
  });

  it('FR-PRJ-03 RF-4: a delete racing a record write that passed the archived gate answers 409 project_has_records and the record survives', async () => {
    const racing = await addProject(fx);
    let passedGate!: () => void;
    const gated = new Promise<void>((res) => { passedGate = res; });
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    // A record write in flight: it has read the project FOR SHARE (the archived gate) and inserted its row, and has not committed.
    const write = withOrg(ctxFor(fx, 'assessor'), async (tx) => {
      await assertProjectWritable(tx, racing.id);
      await tx.evidence.create({ data: {
        orgId: fx.org.id, projectId: racing.id, kind: 'link', url: 'https://example.org/racing', label: null,
        uploadedById: fx.members.assessor.userId, requestId: randomUUID(), requestDigest: createHash('sha256').update('racing').digest('hex'),
      } });
      passedGate();
      await held;
    });
    await gated;
    let deleted = false;
    const deletion = del(fx, 'owner', racing.id).then((r) => { deleted = true; return r; });
    await new Promise((res) => setTimeout(res, 400));
    expect(deleted).toBe(false);   // the delete waits for the write's lock on the project row
    release();
    await write;
    const res = await deletion;
    expect(await codeOf(res)).toEqual({ status: 409, code: 'project_has_records' });
    expect(await testDb.project.count({ where: { id: racing.id } })).toBe(1);
    expect(await testDb.evidence.count({ where: { projectId: racing.id } })).toBe(1);
  });

  it('FR-PRJ-03: projectHasRecords covers every table that references projects', async () => {
    const { contentVersionId } = await useFixtureContent('0.0.1-fixture');
    const tables = (await testDb.$queryRawUnsafe<{ t: string }[]>(
      `SELECT conrelid::regclass::text AS t FROM pg_constraint WHERE contype = 'f' AND confrelid = 'projects'::regclass ORDER BY 1`)).map((x) => x.t);
    const ROW: Record<string, (projectId: string) => Promise<unknown>> = {
      decision_versions: (id) => addDecision(fx, id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'done' }),
      evidence: (id) => addEvidence(fx, id, { kind: 'link', url: 'https://example.org/a' }),
      findings: (id) => addFinding(fx, id, { stage: 'pre-processing', source: 'team' }),
      stage_reviews: (id) => addStageReview(fx, id, { stage: 'pre-processing' }),
      issued_documents: async (id) => {
        const review = await addStageReview(fx, id, { stage: 'pre-processing' });
        const seal = await addSealRow(fx, review.id, { contentVersionId });
        return addIssuedDocument(fx, review.id, { documentType: 'data_card', sealIds: [seal.id] });
      },
      document_draft_fields: (id) => testDb.documentDraftFields.create({ data: { orgId: fx.org.id, projectId: id, documentType: 'data_card', updatedById: fx.members.owner.userId } }),
      assessments: async (id) => {
        const fv = await testDb.frameworkVersion.findFirstOrThrow();
        return testDb.assessment.create({ data: { orgId: fx.org.id, projectId: id, userId: fx.members.owner.userId, frameworkVersionId: fv.id, engineState: {} } });
      },
    };
    expect(tables.filter((t) => t !== 'project_metadata' && !(t in ROW))).toEqual([]);
    for (const t of Object.keys(ROW)) {
      const q = await addProject(fx);
      await ROW[t](q.id);
      expect({ t, has: await withOrg(ctxFor(fx, 'owner'), (tx) => projectHasRecords(tx, q.id)) }).toEqual({ t, has: true });
    }
    const empty = await addProject(fx);
    expect(await withOrg(ctxFor(fx, 'owner'), (tx) => projectHasRecords(tx, empty.id))).toBe(false);
    expect((await del(fx, 'owner', empty.id)).status).toBe(200);
  });
});

describe('the write lists', () => {
  it('NFR-INT-02: routes 21 and 22 POST and route 24 DELETE are listed in RETRY_KEYED_WRITES, and no entry of rows 21 to 24 is left in UNKEYED_WRITES', () => {
    const base = 'app/api/v1/orgs/[slug]/projects';
    expect(RETRY_KEYED_WRITES[`${base}/[id]/archive/route.ts`]).toContain('POST');
    expect(RETRY_KEYED_WRITES[`${base}/[id]/unarchive/route.ts`]).toContain('POST');
    expect(RETRY_KEYED_WRITES[`${base}/[id]/route.ts`]).toEqual(expect.arrayContaining(['PATCH', 'DELETE']));
    for (const f of [`${base}/route.ts`, `${base}/[id]/route.ts`, `${base}/[id]/archive/route.ts`, `${base}/[id]/unarchive/route.ts`]) {
      expect({ f, left: UNKEYED_WRITES[f] }).toEqual({ f, left: undefined });
    }
    expect(PENDING_ROUTES).not.toContain(ARCHIVE);
    expect(PENDING_ROUTES).not.toContain(UNARCHIVE);
  });

  it.skipIf(PENDING_ROUTES.includes(PDF_ROUTE))('FR-PRJ-03: an archived project\'s issued documents re-download with their stored SHA-256', async () => {
    const { contentVersionId } = await useFixtureContent('0.0.1-fixture');
    const review = await addStageReview(fx, p.id, { stage: 'pre-processing' });
    const seal = await addSealRow(fx, review.id, { contentVersionId });
    const doc = await addIssuedDocument(fx, review.id, { documentType: 'data_card', sealIds: [seal.id], pdf: Buffer.from('%PDF-1.7 fixture') });
    expect((await post(fx, ARCHIVE, 'owner', p.id)).status).toBe(204);
    sessionAs(fx.members.viewer.userId);
    const res = await callRoute(PDF_ROUTE, 'GET', { slug: fx.org.slug, params: { documentId: doc.id } });
    expect(res.status).toBe(200);
    expect(createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex')).toBe(doc.sha256);
  });
});
