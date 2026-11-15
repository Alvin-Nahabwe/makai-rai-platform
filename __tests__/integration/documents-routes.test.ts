import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssuedDocumentView } from '@/types/api';
import { PENDING_ROUTES } from '@/lib/authz/routeActions';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addEvidence, addProject, addStageReview, buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { withTriggersDisabled } from '../helpers/triggers';
import { sealFixture } from '../helpers/sealFixture';
import { callRoute, sessionAs } from '../helpers/routeDriver';
import { captureLogs } from '../helpers/logCapture';
import { API_COPY } from '@/lib/http/api/copy';
import { HTTP_COPY } from '@/lib/http/copy';
import { MSG_DOCUMENT_CHECK_FAILED } from '@/lib/documents/copy';

vi.setConfig({ testTimeout: 60_000 });

const PREVIEW = 'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents/preview/route.ts';
const ISSUE = 'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents/route.ts';
const PDF = 'app/api/v1/orgs/[slug]/documents/[documentId]/pdf/route.ts';

let fx: OrgFixture;
let projectId: string;
let reviewId: string;
let review2: string;
let sealId: string;
let seal2: string;

const params = (over: Record<string, string> = {}) => ({ id: projectId, reviewId, ...over });
const bodyFor = (over: Record<string, unknown> = {}) => ({ requestId: randomUUID(), documentType: 'data_card', sealId, typedFields: {}, ...over });
const post = (file: string, body: unknown, over: Record<string, string> = {}) => callRoute(file, 'POST', { slug: fx.org.slug, params: params(over), body });
const previewBody = () => { const { requestId: _r, ...rest } = bodyFor(); return rest; };
const get = (id: string, slug = fx.org.slug) => callRoute(PDF, 'GET', { slug, params: { documentId: id } });
const count = () => testDb.issuedDocument.count();
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeEach(async () => {
  await resetDb();
  const { contentVersionId } = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg({ label: 'drt' });
  projectId = (await addProject(fx)).id;
  await addDecision(fx, projectId, { stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'done', decidedBy: { kind: 'member', userId: fx.members.owner.userId }, declaredDate: '2026-10-30' });
  reviewId = (await addStageReview(fx, projectId, { stage: 'pre-processing' })).id;
  review2 = (await addStageReview(fx, projectId, { stage: 'pre-processing' })).id;
  sealId = (await sealFixture(fx, reviewId, { projectId })).id;
  seal2 = (await sealFixture(fx, review2, { projectId })).id;
  sessionAs(fx.members.admin.userId);
});

describe('preview, issue and download routes', () => {
  it('FR-DOC-08: the preview answers the text as it will print and stores nothing', async () => {
    const res = await post(PREVIEW, { documentType: 'data_card', sealId, typedFields: { 'DC-25': 'CC BY 4.0' } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ documentType: 'data_card', sealId });
    expect(json.text).toContain('CC BY 4.0');
    expect(json.notRecordedFields).toContain('DC-27');
    expect(await count()).toBe(0);
  });

  it('FR-DOC-04: an issue answers 201 with the document, and the download returns the stored bytes twice, as an attachment', async () => {
    const res = await post(ISSUE, bodyFor());
    expect(res.status).toBe(201);
    const doc = (await res.json()) as IssuedDocumentView;
    for (const _ of [1, 2]) {
      const r = await get(doc.id);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('application/pdf');
      expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="data-card-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.pdf"$/);
      const bytes = Buffer.from(await r.arrayBuffer());
      expect(r.headers.get('content-length')).toBe(String(bytes.length));
      expect(sha256(bytes)).toBe(doc.sha256);
    }
  });

  it('NFR-INT-02 FR-DOC-04: the same request id on another review answers 409 and issues nothing', async () => {
    const body = bodyFor();
    expect((await post(ISSUE, body)).status).toBe(201);
    const other = await post(ISSUE, { ...body, sealId: seal2 }, { reviewId: review2 });
    expect([other.status, (await other.json()).code]).toEqual([409, 'request_id_reused']);
    expect(await count()).toBe(1);
  });

  it('NFR-INT-02 FR-DOC-04 FR-REV-08 (WIO-1, R15-10): after the operator sets the issue request\'s requestDigest to erased, the original request answers 409 request_id_reused and issues nothing', async () => {
    const body = bodyFor({ typedFields: { 'DC-25': 'CC BY 4.0' } });
    const first = await post(ISSUE, body);
    expect(first.status).toBe(201);
    const doc = (await first.json()) as IssuedDocumentView;
    const sourcesBefore = await testDb.issuedDocumentSource.count({ where: { documentId: doc.id } });
    expect(sourcesBefore).toBeGreaterThan(0);
    await testDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE makrai_operator_fn');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${fx.org.id}', true)`);
      await tx.$executeRawUnsafe(`UPDATE issued_documents SET "requestDigest" = 'erased' WHERE id = '${doc.id}'`);
    });
    expect((await testDb.issuedDocument.findUniqueOrThrow({ where: { id: doc.id } })).requestDigest).toBe('erased');
    const retry = await post(ISSUE, body);
    expect(retry.status).toBe(409);
    const json = await retry.json();
    expect(json.code).toBe('request_id_reused');
    expect(Object.keys(json).sort()).toEqual(['code', 'error']);
    expect(JSON.stringify(json)).not.toContain(doc.id);
    expect(await count()).toBe(1);
    expect(await testDb.issuedDocumentSource.count({ where: { documentId: doc.id } })).toBe(sourcesBefore);
    expect((await testDb.issuedDocument.findUniqueOrThrow({ where: { id: doc.id } })).requestDigest).toBe('erased');
  });

  it('NFR-INT-06: a document whose bytes do not match its SHA-256 is never served', async () => {
    const real = (await (await post(ISSUE, bodyFor())).json()) as IssuedDocumentView;
    const [{ issuedAt }] = await testDb.$queryRaw<{ issuedAt: Date }[]>`SELECT date_trunc('second', clock_timestamp()) - interval '5 seconds' AS "issuedAt"`;
    const bad = await testDb.issuedDocument.create({ data: {
      orgId: fx.org.id, projectId, stageReviewId: reviewId, sealId, documentType: 'data_card', templateVersion: '5.0.0', typedFields: [],
      pdf: Uint8Array.from(Buffer.from('%PDF-other')), plainText: 'x', sha256: real.sha256, byteSize: 10, issuedById: fx.members.admin.userId, issuedAt,
      requestId: randomUUID(), requestDigest: 'x',
    } });
    const { result: r, lines } = await captureLogs(() => get(bad.id));
    expect(r.status).toBe(500);
    expect(await r.json()).toMatchObject({ error: MSG_DOCUMENT_CHECK_FAILED, code: 'integrity_failure', reference: expect.any(String) });
    expect(lines.filter((l) => l.includes('DOCUMENT_INTEGRITY_FAILURE'))).toHaveLength(1);
  });

  it('FR-DOC-04 FR-REV-08: an erased document answers 410 with its date and no bytes', async () => {
    const ev = await testDb.evidence.create({ data: { orgId: fx.org.id, projectId, kind: 'file', filename: 'a.pdf', mimeType: 'application/pdf', byteSize: 3, sha256: 'a'.repeat(64), uploadedById: fx.members.owner.userId, requestId: randomUUID(), requestDigest: 'x' } });
    await testDb.evidenceBlob.create({ data: { evidenceId: ev.id, orgId: fx.org.id, content: Uint8Array.from([1, 2, 3]) } });
    const doc = (await (await post(ISSUE, bodyFor())).json()) as IssuedDocumentView;
    await testDb.issuedDocumentSource.create({ data: { orgId: fx.org.id, documentId: doc.id, sourceTable: 'evidence', sourceId: ev.id, field: null } });
    await testDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE makrai_operator_fn');
      await tx.$executeRawUnsafe(`SELECT erase_evidence_bytes('${fx.org.id}','${ev.id}','ER','I')`);
    });
    const r = await get(doc.id);
    expect(r.status).toBe(410);
    expect(await r.json()).toEqual({ error: HTTP_COPY.erased(new Date().toISOString().slice(0, 10)), code: 'erased', erasedOn: new Date().toISOString().slice(0, 10) });
  });

  it('FR-DOC-04 NFR-SEC-02: a document of organisation B answers 404 to a member of A', async () => {
    const doc = (await (await post(ISSUE, bodyFor())).json()) as IssuedDocumentView;
    const b = await buildOrg({ label: 'drt-b' });
    sessionAs(b.members.admin.userId);
    const r = await get(doc.id, b.org.slug);
    expect([r.status, await r.json()]).toEqual([404, { error: API_COPY.notFound, code: 'not_found' }]);
    sessionAs(fx.members.admin.userId);
    const r2 = await get(doc.id, b.org.slug);
    expect(r2.status).toBe(404);
  });

  it('FR-DOC-01 FR-AUTHZ-01: assessor and viewer get 403 on preview and issue; reviewer may', async () => {
    for (const role of ['assessor', 'viewer'] as const) {
      sessionAs(fx.members[role].userId);
      for (const file of [PREVIEW, ISSUE]) {
        const r = await post(file, file === PREVIEW ? previewBody() : bodyFor());
        expect([role, r.status, (await r.json()).code]).toEqual([role, 403, 'forbidden']);
      }
    }
    expect(await count()).toBe(0);
    sessionAs(fx.members.reviewer.userId);
    expect((await post(PREVIEW, previewBody())).status).toBe(200);
    expect((await post(ISSUE, bodyFor())).status).toBe(201);
  });

  it('FR-DOC-01: every member who can read can download', async () => {
    const doc = (await (await post(ISSUE, bodyFor())).json()) as IssuedDocumentView;
    for (const role of ['viewer', 'assessor', 'reviewer', 'admin', 'owner'] as const) {
      sessionAs(fx.members[role].userId);
      expect([role, (await get(doc.id)).status]).toEqual([role, 200]);
    }
  });

  it('NFR-SEC-02 (D5): the body takes only its three keys and a request id, and a hostile or unknown value answers 422', async () => {
    const cases: Array<[string, unknown]> = [
      ['an extra key', { ...bodyFor(), issuedById: 'x' }], ['no seal', { ...bodyFor(), sealId: undefined }], ['a bad document type', bodyFor({ documentType: 'poster' })],
      ['an unknown typed field', bodyFor({ typedFields: { 'DC-99': 'x' } })], ['a bad request id', bodyFor({ requestId: 'nope' })], ['an array', []],
    ];
    for (const [name, body] of cases) {
      const r = await post(ISSUE, body);
      expect([name, r.status, (await r.json()).code]).toEqual([name, 422, 'validation']);
    }
    expect((await post(PREVIEW, bodyFor())).status).toBe(422);   // the preview takes no request id
    expect(await count()).toBe(0);
  });

  it('NFR-MNT-01: the three document routes are no longer pending', () => {
    for (const f of [PREVIEW, ISSUE, PDF]) expect(PENDING_ROUTES).not.toContain(f);
  });

  it('FR-DOC-04 FR-REV-08 (C4 D11, SO-1): after erase_text_field on the file name a document printed, route 17 answers 410 with the date, not 500', async () => {
    const { contentVersionId } = await useFixtureContent('0.0.1-fixture');
    const ev = await addEvidence(fx, projectId, { kind: 'file', fileName: 'protocol.pdf' });
    await withTriggersDisabled('evidence', () => testDb.$executeRawUnsafe(`UPDATE evidence SET "filenameSalt" = decode(md5(random()::text), 'hex') WHERE id = '${ev.id}'`));
    await addDecision(fx, projectId, { stage: 'pre-processing', questionId: 'Q-PP-13', contentVersionId, status: 'done', decidedBy: { kind: 'member', userId: fx.members.owner.userId }, declaredDate: '2026-10-30', evidenceIds: [ev.id] });
    const review = (await addStageReview(fx, projectId, { stage: 'pre-processing' })).id;
    const seal = await sealFixture(fx, review, { projectId });
    const doc = (await (await post(ISSUE, bodyFor({ sealId: seal.id }), { reviewId: review })).json()) as IssuedDocumentView;
    await testDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE makrai_operator_fn');
      await tx.$executeRawUnsafe(`SELECT erase_text_field('${fx.org.id}','evidence','${ev.id}','fileName','ER','I')`);
    });
    const r = await get(doc.id);
    expect(r.status).toBe(410);
    expect(await r.json()).toEqual({ error: HTTP_COPY.erased(new Date().toISOString().slice(0, 10)), code: 'erased', erasedOn: new Date().toISOString().slice(0, 10) });
  });
});
