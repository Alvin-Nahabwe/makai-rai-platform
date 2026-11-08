import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgRole } from '@prisma/client';
import type { DocumentType } from '@/types/record';
import type { IssuedDocumentView } from '@/types/api';
import { PENDING_ROUTES } from '@/lib/authz/routeActions';
import { readDocumentPdf } from '@/lib/data/documents';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import { formatUtcDay } from '@/lib/documents/copy';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent as publishFixtureContent } from '../helpers/content';
import {
  addDecision, addEvidence, addFinding, addMitigationVersion, addProject, addStageReview, buildOrg, ctxFor, type OrgFixture,
} from '../helpers/recordFixture';
import { sealFixture } from '../helpers/sealFixture';
import { callRoute, sessionAs } from '../helpers/routeDriver';
import { pdfTextRuns } from '../helpers/pdfText';
import { withTriggersDisabled } from '../helpers/triggers';
import { HOSTILE_STRINGS, hostileText } from '../helpers/hostile';

vi.setConfig({ testTimeout: 90_000 });

const TEXT = 'app/api/v1/orgs/[slug]/documents/[documentId]/text/route.ts';
const ISSUE = 'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents/route.ts';

let fx: OrgFixture;
let fxB: OrgFixture;
let projectId: string;
let ppReview: string;
let ipReview: string;
let ppSeal: string;
let ipSeal: string;
let contentVersionId: string;

const as = (role: OrgRole, f: OrgFixture = fx) => sessionAs(f.members[role].userId);
const getText = (documentId: string, slug = fx.org.slug) => callRoute(TEXT, 'GET', { slug, params: { documentId } });
const squeeze = (s: string) => s.replace(/[\s-]+/g, '');

async function issue(type: DocumentType, f: OrgFixture = fx, p = projectId, review = ppReview, seal = ppSeal): Promise<IssuedDocumentView> {
  as('admin', f);
  const res = await callRoute(ISSUE, 'POST', { slug: f.org.slug, params: { id: p, reviewId: review }, body: { requestId: randomUUID(), documentType: type, sealId: seal, typedFields: {} } });
  expect(res.status).toBe(201);
  return res.json();
}

async function build(f: OrgFixture): Promise<{ projectId: string; ppReview: string; ppSeal: string; ipReview: string; ipSeal: string }> {
  const p = (await addProject(f)).id;
  const ev = await addEvidence(f, p, { kind: 'file', fileName: 'protocol.pdf' });
  const decide = async (stage: 'pre-processing' | 'in-processing', questionId: string, evidenceIds: string[] = []) =>
    addDecision(f, p, { stage, questionId, contentVersionId, status: 'done', decidedBy: { kind: 'member', userId: f.members.owner.userId }, declaredDate: '2026-10-30', evidenceIds });
  await decide('pre-processing', 'Q-PP-12', [ev.id]);
  await decide('pre-processing', 'Q-PP-13');
  await decide('in-processing', 'Q-IP-01');
  const finding = await addFinding(f, p, { stage: 'pre-processing', source: 'team', riskArea: 'PP-02' });
  await addMitigationVersion(f, finding.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
  const pr = (await addStageReview(f, p, { stage: 'pre-processing', preparedFor: 'ethics submission' })).id;
  const ir = (await addStageReview(f, p, { stage: 'in-processing' })).id;
  return { projectId: p, ppReview: pr, ipReview: ir, ppSeal: (await sealFixture(f, pr, { projectId: p })).id, ipSeal: (await sealFixture(f, ir, { projectId: p })).id };
}

beforeEach(async () => {
  await resetDb();
  ({ contentVersionId } = await publishFixtureContent('0.0.1-fixture'));
  fx = await buildOrg({ label: 'dtx' });
  fxB = await buildOrg({ label: 'dtxb' });
  ({ projectId, ppReview, ppSeal, ipReview, ipSeal } = await build(fx));
});

describe('the plain-text copy (route 18)', () => {
  it.each(['data_card', 'model_card', 'mitigation_plan'] as const)('FR-DOC-07 NFR-A11Y-06: the %s copy holds the marking and every field of the PDF, and the PDF every line of the copy', async (type) => {
    const value = type === 'model_card' ? await issue(type, fx, projectId, ipReview, ipSeal) : await issue(type);
    as('viewer');
    const res = await getText(value.id);
    expect(res.status).toBe(200);
    const text = await res.text();
    const words = type.replace('_', ' ');
    expect(text.split('\n')[0]).toBe(`Copy of the ${words} issued on ${formatUtcDay(value.issuedAt)}; the PDF is the issued version`);
    expect(text.split('\n')[1]).toBe('');
    for (const f of loadFieldMap(type).fields) expect(text).toContain(f.label);
    const pdf = squeeze(pdfTextRuns((await readDocumentPdf(ctxFor(fx, 'viewer'), value.id)).bytes).join(' '));
    const copy = squeeze(text);
    // Both ways: no line of the copy is missing from the PDF (the marking aside), and no run of the PDF is missing from the copy.
    for (const line of text.split('\n').slice(2).filter((l) => l.trim() !== '')) expect(pdf, line).toContain(squeeze(line));
    for (const run of pdfTextRuns((await readDocumentPdf(ctxFor(fx, 'viewer'), value.id)).bytes).filter((r) => r.trim() !== '')) expect(copy, run).toContain(squeeze(run));
  });

  it('FR-DOC-07: the copy is the stored text of the issue, not a regeneration', async () => {
    const value = await issue('data_card');
    await withTriggersDisabled('issued_documents', () => testDb.$executeRaw`UPDATE "issued_documents" SET "plainText" = 'Stored words only' WHERE "id" = ${value.id}`);
    as('reviewer');
    expect(await (await getText(value.id)).text()).toMatch(/\n\nStored words only$/);
  });

  it('NFR-SEC-11 FR-DOC-07: hostile text comes back as plain text', async () => {
    await resetDb();
    ({ contentVersionId } = await publishFixtureContent('0.0.1-fixture'));
    fx = await buildOrg({ label: 'dtxh', text: hostileText });
    const b = await build(fx);
    const value = await issue('mitigation_plan', fx, b.projectId, b.ppReview, b.ppSeal);
    as('viewer');
    const r = await getText(value.id);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(r.headers.get('content-disposition')).toBeNull();
    const body = await r.clone().text();
    for (const h of HOSTILE_STRINGS) expect(body).toContain(h);
  });

  it('FR-DOC-07 FR-REV-08: an erased document\'s text answers 410 with the date', async () => {
    const value = await issue('data_card');
    const reasonRow = await testDb.decisionVersion.findFirstOrThrow({ where: { questionId: 'Q-PP-12' } });
    await testDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE makrai_operator_fn');
      await tx.$executeRawUnsafe(`SELECT erase_text_field('${fx.org.id}','decision_versions','${reasonRow.id}','reason','ER-TXT','INSTR-TXT')`);
    });
    as('viewer');
    const r = await getText(value.id);
    expect(r.status).toBe(410);
    expect(await r.json()).toMatchObject({ code: 'erased', erasedOn: new Date().toISOString().slice(0, 10) });
  });

  it('NFR-SEC-02: a document of organisation B answers 404 with no text', async () => {
    const b = await build(fxB);
    const other = await issue('data_card', fxB, b.projectId, b.ppReview, b.ppSeal);
    as('owner');
    const r = await getText(other.id);
    expect([r.status, (await r.json()).code]).toEqual([404, 'not_found']);
    as('owner');
    const missing = await getText(randomUUID());
    expect(missing.status).toBe(404);
  });

  it('FR-AUTHZ-01: a caller with no session is refused', async () => {
    const value = await issue('data_card');
    sessionAs(null);
    expect((await getText(value.id)).status).toBe(401);
  });

  it('NFR-MNT-01: route 18 is no longer pending', () => {
    expect(PENDING_ROUTES).not.toContain(TEXT);
  });
});
