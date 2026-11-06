import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { PENDING_ROUTES } from '@/lib/authz/routeActions';
import { listDocuments } from '@/lib/data/documents';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent as publishFixtureContent } from '../helpers/content';
import { addDecision, addProject, addStageReview, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { sealFixture } from '../helpers/sealFixture';
import { callRoute, sessionAs } from '../helpers/routeDriver';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { markerFor } from '../helpers/markers';

vi.setConfig({ testTimeout: 60_000 });

const WITHDRAWAL = 'app/api/v1/orgs/[slug]/documents/[documentId]/withdrawal/route.ts';
const ISSUE = 'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents/route.ts';
const PDF = 'app/api/v1/orgs/[slug]/documents/[documentId]/pdf/route.ts';

let fx: OrgFixture;
let fxB: OrgFixture;
let projectId: string;
let reviewId: string;
let sealId: string;
let docId: string;
let docId2: string;
let storedSha: string;

const as = (role: OrgRole) => sessionAs(fx.members[role].userId);
const post = (documentId: string, body: unknown, slug = fx.org.slug) => callRoute(WITHDRAWAL, 'POST', { slug, params: { documentId }, body });
async function issue(documentType: 'data_card' | 'model_card'): Promise<{ id: string; sha256: string }> {
  as('admin');
  const res = await callRoute(ISSUE, 'POST', { slug: fx.org.slug, params: { id: projectId, reviewId }, body: { requestId: randomUUID(), documentType, sealId, typedFields: {} } });
  expect(res.status).toBe(201);
  return res.json();
}
const withdraw = async (documentId = docId, reason = 'Sent to the wrong committee.') => {
  as('owner');
  const res = await post(documentId, { requestId: randomUUID(), reason });
  expect(res.status).toBe(201);
  return res;
};
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeEach(async () => {
  await resetDb();
  const { contentVersionId } = await publishFixtureContent('0.0.1-fixture');
  fx = await buildOrg({ label: 'dwd' });
  fxB = await buildOrg({ label: 'dwdb' });
  projectId = (await addProject(fx)).id;
  await addDecision(fx, projectId, { stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'done', decidedBy: { kind: 'member', userId: fx.members.owner.userId }, declaredDate: '2026-10-30' });
  reviewId = (await addStageReview(fx, projectId, { stage: 'pre-processing' })).id;
  sealId = (await sealFixture(fx, reviewId, { projectId })).id;
  const a = await issue('data_card');
  const b = await issue('model_card');
  docId = a.id; storedSha = a.sha256; docId2 = b.id;
});

describe('withdrawing an issued document (route 19)', () => {
  it('FR-DOC-06: an owner withdraws with a reason; S-18 data shows withdrawn on the date with the reason; the document stays stored', async () => {
    as('owner');
    const r = await post(docId, { requestId: randomUUID(), reason: 'Sent to the wrong committee.' });
    expect(r.status).toBe(201);
    const v = (await listDocuments(ctxFor(fx, 'owner'), { projectId, reviewId })).find((d) => d.id === docId)!;
    const ev = await testDb.documentEvent.findFirstOrThrow({ where: { documentId: docId } });
    expect(v.withdrawn).toEqual({ on: ev.at.toISOString().slice(0, 10), reason: 'Sent to the wrong committee.' });
    expect(ev).toMatchObject({ kind: 'withdrawn', byId: fx.members.owner.userId });
    expect(await testDb.issuedDocument.count({ where: { id: docId } })).toBe(1);
    expect(await r.json()).toMatchObject({ id: docId, withdrawn: { reason: 'Sent to the wrong committee.' } });
  });

  it('FR-DOC-06 NFR-INT-06: after withdrawal the download still returns the stored bytes', async () => {
    await withdraw();
    as('viewer');
    const res = await callRoute(PDF, 'GET', { slug: fx.org.slug, params: { documentId: docId } });
    expect(res.status).toBe(200);
    expect(sha256(Buffer.from(await res.arrayBuffer()))).toBe(storedSha);
  });

  it('NFR-INT-02 FR-DOC-06: the same request id on another document answers 409 and writes nothing', async () => {
    as('admin');
    const body = { requestId: randomUUID(), reason: 'Wrong file.' };
    expect((await post(docId, body)).status).toBe(201);
    const other = await post(docId2, body);
    expect([other.status, (await other.json()).code]).toEqual([409, 'request_id_reused']);
    expect(await testDb.documentEvent.count()).toBe(1);
  });

  it('FR-DOC-06: a second withdrawal answers 409 already_withdrawn and keeps the first reason', async () => {
    await withdraw();
    const r = await post(docId, { requestId: randomUUID(), reason: 'Again.' });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('already_withdrawn');
    expect((await testDb.documentEvent.findMany()).map((e) => e.reason)).toEqual(['Sent to the wrong committee.']);
  });

  it('FR-DOC-06 FR-AUTHZ-01: reviewer, assessor and viewer get 403 and no event is written', async () => {
    for (const role of ['reviewer', 'assessor', 'viewer'] as const) {
      as(role);
      const r = await post(docId, { requestId: randomUUID(), reason: 'No.' });
      expect([role, r.status, (await r.json()).code]).toEqual([role, 403, 'forbidden']);
    }
    expect(await testDb.documentEvent.count()).toBe(0);
  });

  it('FR-PRJ-03 RF-4: withdrawing in an archived project answers 409 project_archived and writes nothing', async () => {
    await testDb.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    as('owner');
    const r = await post(docId, { requestId: randomUUID(), reason: 'Late.' });
    expect([r.status, (await r.json()).code]).toEqual([409, 'project_archived']);
    expect(await testDb.documentEvent.count()).toBe(0);
  });

  it('FR-DOC-06: a missing, blank or 1001-character reason answers 422 on reason, and a reason of 1000 is kept', async () => {
    as('owner');
    for (const reason of [undefined, '', '   ', 'x'.repeat(1001)]) {
      const r = await post(docId, { requestId: randomUUID(), ...(reason === undefined ? {} : { reason }) });
      const json = await r.json();
      expect([reason?.length, r.status, json.fields[0].field]).toEqual([reason?.length, 422, 'reason']);
    }
    expect(await testDb.documentEvent.count()).toBe(0);
    expect((await post(docId, { requestId: randomUUID(), reason: ` ${'x'.repeat(1000)} ` })).status).toBe(201);
  });

  it('FR-DOC-06: a body key the route does not take, or a bad request id, answers 422', async () => {
    as('owner');
    const extra = await post(docId, { requestId: randomUUID(), reason: 'ok', documentId: docId2 });
    expect([extra.status, (await extra.json()).fields[0].field]).toEqual([422, 'documentId']);
    const bad = await post(docId, { requestId: 'nope', reason: 'ok' });
    expect([bad.status, (await bad.json()).fields[0].field]).toEqual([422, 'requestId']);
    expect(await testDb.documentEvent.count()).toBe(0);
  });

  it('NFR-SEC-02: a document of organisation B answers 404 and writes nothing', async () => {
    as('owner');
    const r = await post(docId, { requestId: randomUUID(), reason: 'Mine now.' }, fxB.org.slug);
    expect(r.status).toBe(404);
    sessionAs(fxB.members.owner.userId);
    const own = await post(docId, { requestId: randomUUID(), reason: 'Mine now.' }, fxB.org.slug);
    expect([own.status, (await own.json()).code]).toEqual([404, 'not_found']);
    expect(await testDb.documentEvent.count()).toBe(0);
  });

  it('FR-AUTHZ-02: a cross-origin request is refused before anything is read', async () => {
    as('owner');
    const r = await callRoute(WITHDRAWAL, 'POST', { slug: fx.org.slug, params: { documentId: docId }, origin: 'http://evil.example', body: { requestId: randomUUID(), reason: 'x' } });
    expect(r.status).toBe(403);
    expect(await testDb.documentEvent.count()).toBe(0);
  });

  it('NFR-OBS-01 NFR-PRIV-03: one DOCUMENT_WITHDRAWN line with ids only', async () => {
    as('owner');
    const reason = markerFor('reason', 1);
    const { lines } = await captureLogs(() => post(docId, { requestId: randomUUID(), reason }));
    const mine = lines.filter((l) => l.includes('DOCUMENT_WITHDRAWN'));
    expect(mine).toHaveLength(1);
    expect(JSON.parse(mine[0]).details).toEqual({ orgId: fx.org.id, documentId: docId });
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
  });

  it('NFR-OBS-01: a replay of the same request logs nothing more', async () => {
    as('owner');
    const body = { requestId: randomUUID(), reason: 'Once.' };
    await post(docId, body);
    const { lines, result } = await captureLogs(() => post(docId, body));
    expect(result.status).toBe(200);
    expect(lines.filter((l) => l.includes('DOCUMENT_WITHDRAWN'))).toEqual([]);
  });

  it('NFR-MNT-01: route 19 is no longer pending', () => {
    expect(PENDING_ROUTES).not.toContain(WITHDRAWAL);
  });
});
