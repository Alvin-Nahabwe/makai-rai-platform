import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentType } from '@/types/record';
import type { IssuedDocumentView, PreviewDocumentRequest } from '@/types/api';
import { documentDraft, documentViews, issueDocument, listDocuments, previewDocument, readDocumentPdf } from '@/lib/data/documents';
import { requestDigest } from '@/lib/data/idempotency';
import { withOrg } from '@/lib/data/tenant';
import { RENDERERS, type Renderer } from '@/lib/documents/render';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import {
  addDecision, addEvidence, addProject, addStageReview, buildOrg, ctxFor, type OrgFixture,
} from '../helpers/recordFixture';
import { sealFixture } from '../helpers/sealFixture';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { markerFor } from '../helpers/markers';
import { pdfTextRuns } from '../helpers/pdfText';

// Each issue renders a PDF with an embedded font (about a second on a loaded host); several tests issue two or three.
vi.setConfig({ testTimeout: 60_000 });

let fx: OrgFixture;
let contentVersionId: string;
let projectId: string;
let ppReview: string;
let ipReview: string;
let poReview: string;
let ppSeal: string;
let ipSeal1: string;
let ppSealLatest: string;
let poSealLatest: string;
let evidenceId: string;

const ctx = () => ctxFor(fx, 'admin');
const admin = () => ({ userId: fx.members.admin.userId, role: 'admin' as const });
const count = (table: 'issued_documents' | 'document_draft_fields') => (table === 'issued_documents' ? testDb.issuedDocument.count() : testDb.documentDraftFields.count());
const utcSecond = (iso: string) => `${new Date(iso).toISOString().slice(11, 19)} UTC`;

type Args = { reviewId?: string; sealId?: string; documentType?: DocumentType; typedFields?: Record<string, string>; projectId?: string };
const body = (a: Args = {}): PreviewDocumentRequest & { projectId: string; reviewId: string } => ({
  projectId: a.projectId ?? projectId, reviewId: a.reviewId ?? ppReview, sealId: a.sealId ?? ppSeal, documentType: a.documentType ?? 'data_card', typedFields: a.typedFields ?? {},
});
const preview = (a: Args = {}) => previewDocument(ctx(), admin(), body(a));
async function issue(a: Args = {}, requestId = randomUUID()) {
  const b = body(a);
  const digest = requestDigest({ path: { id: b.projectId, reviewId: b.reviewId }, body: { requestId, documentType: b.documentType, sealId: b.sealId, typedFields: b.typedFields } });
  return issueDocument(ctx(), admin(), { ...b, requestId }, digest);
}
const issueIp = (documentType: DocumentType, sealId = ipSeal1, typedFields: Record<string, string> = {}) => issue({ reviewId: ipReview, sealId, documentType, typedFields });
async function pdfOf(id: string): Promise<Buffer> {
  return Buffer.from((await withOrg(ctx(), (tx) => tx.issuedDocument.findUniqueOrThrow({ where: { id }, select: { pdf: true } }))).pdf as Uint8Array);
}

beforeEach(async () => {
  await resetDb();
  ({ contentVersionId } = await useFixtureContent('0.0.1-fixture'));
  fx = await buildOrg({ label: 'dsvc' });
  projectId = (await addProject(fx)).id;
  const ev = await addEvidence(fx, projectId, { kind: 'file', fileName: 'protocol.pdf' });
  evidenceId = ev.id;
  const decide = async (stage: 'pre-processing' | 'in-processing' | 'post-processing', questionId: string, evidenceIds: string[] = []) =>
    (await addDecision(fx, projectId, { stage, questionId, contentVersionId, status: 'done', decidedBy: { kind: 'member', userId: fx.members.owner.userId }, declaredDate: '2026-10-30', evidenceIds })).id;
  const pp = [await decide('pre-processing', 'Q-PP-12', [ev.id]), await decide('pre-processing', 'Q-PP-13'), await decide('pre-processing', 'Q-PP-08')];
  const ip = [await decide('in-processing', 'Q-IP-01')];
  const po = [await decide('post-processing', 'Q-PO-01')];
  ppReview = (await addStageReview(fx, projectId, { stage: 'pre-processing' })).id;
  ipReview = (await addStageReview(fx, projectId, { stage: 'in-processing' })).id;
  poReview = (await addStageReview(fx, projectId, { stage: 'post-processing' })).id;
  ppSeal = (await sealFixture(fx, ppReview, { projectId, stage: 'pre-processing', contentVersionId, decisionVersionIds: pp })).id;
  ppSealLatest = ppSeal;
  ipSeal1 = (await sealFixture(fx, ipReview, { projectId, stage: 'in-processing', contentVersionId, decisionVersionIds: ip })).id;
  poSealLatest = (await sealFixture(fx, poReview, { projectId, stage: 'post-processing', contentVersionId, decisionVersionIds: po })).id;
});

describe('preview and issue', () => {
  it('FR-DOC-08: preview stores nothing; after Back to edit still nothing; after Issue exactly one row', async () => {
    const p = await preview();
    expect(p.text).toContain('Data card');
    expect(p.notRecordedFields).toContain('DC-25');
    expect(p.typedFields).toContain('DC-25');
    expect(p.documentType).toBe('data_card');
    expect(p.sealId).toBe(ppSeal);
    expect(await count('issued_documents')).toBe(0);
    expect(await count('document_draft_fields')).toBe(0);
    await preview({ typedFields: { 'DC-25': 'CC BY 4.0' } });
    expect(await count('issued_documents')).toBe(0);
    expect(await count('document_draft_fields')).toBe(0);
    await issue();
    expect(await count('issued_documents')).toBe(1);
  });

  it('FR-DOC-04: the stored row holds the SHA-256 of the stored bytes, the seals used, the type and the issuer', async () => {
    const { value } = await issue({ typedFields: { 'DC-25': 'CC BY 4.0' } });
    const row = await testDb.issuedDocument.findUniqueOrThrow({ where: { id: value.id } });
    expect(createHash('sha256').update(row.pdf!).digest('hex')).toBe(row.sha256);
    expect(row.byteSize).toBe(row.pdf!.length);
    expect(row.issuedById).toBe(admin().userId);
    expect(row.documentType).toBe('data_card');
    expect(row.stageReviewId).toBe(ppReview);
    expect(row.templateVersion).toBe('5.0.0');
    expect(value.seals.map((s) => s.sealId)).toContain(ppSeal);
    expect(value.sha256).toBe(row.sha256);
    expect(row.plainText).toContain('Data card');
    for (const t of row.typedFields as Array<{ fieldId: string; value: string; salt: string }>) expect(t.salt).toMatch(/^[0-9a-f]{32}$/);
    const links = await testDb.issuedDocumentSeal.findMany({ where: { documentId: value.id } });
    expect(links.map((l) => l.sealId).sort()).toEqual(value.seals.map((s) => s.sealId).sort());
  });

  it('FR-DOC-05 (G069): seals[0] is the home seal and the other stages follow in STAGES order', async () => {
    const { value } = await issueIp('model_card');
    expect(value.seals.map((s) => s.sealId)).toEqual([ipSeal1, ppSealLatest, poSealLatest]);
    expect(value.seals[0]).toMatchObject({ sealNumber: 1, reviewId: ipReview, reviewName: 'In-processing review 1' });
    expect(value.seals[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('FR-DOC-05: a stage never sealed is "Not recorded at the time of issue" and has no seal entry', async () => {
    const lone = await buildOrg({ label: 'dsvc-lone' });
    const loneProject = (await addProject(lone)).id;
    const review = (await addStageReview(lone, loneProject, { stage: 'in-processing' })).id;
    const d = (await addDecision(lone, loneProject, { stage: 'in-processing', questionId: 'Q-IP-01', contentVersionId, status: 'done', decidedBy: { kind: 'member', userId: lone.members.owner.userId }, declaredDate: '2026-10-30' })).id;
    const seal = await sealFixture(lone, review, { projectId: loneProject, stage: 'in-processing', contentVersionId, decisionVersionIds: [d] });
    const lctx = ctxFor(lone, 'admin');
    const p = await previewDocument(lctx, { userId: lone.members.admin.userId, role: 'admin' }, { projectId: loneProject, reviewId: review, sealId: seal.id, documentType: 'model_card', typedFields: {} });
    expect(p.text).toContain('Not recorded at the time of issue');
    const out = await issueDocument(lctx, { userId: lone.members.admin.userId, role: 'admin' }, { projectId: loneProject, reviewId: review, sealId: seal.id, documentType: 'model_card', typedFields: {}, requestId: randomUUID() },
      requestDigest({ path: { id: loneProject, reviewId: review }, body: {} }));
    expect(out.value.seals.map((s) => s.sealId)).toEqual([seal.id]);
  });

  it('FR-DOC-04 (R-66): two data cards from one seal within one second print different issue times', async () => {
    const [a, b] = await Promise.all([issue(), issue()]);
    expect(a.value.issuedAt.slice(0, 19)).not.toBe(b.value.issuedAt.slice(0, 19));
    for (const d of [a, b]) expect(pdfTextRuns(await pdfOf(d.value.id)).join(' ')).toContain(utcSecond(d.value.issuedAt));
    expect(a.value.issuedAt.endsWith('.000Z')).toBe(true);
  });

  it('FR-DOC-04 FR-DEC-07: issuedById is the session user and issuedAt equals the printed issue time', async () => {
    const { value } = await issueIp('model_card');
    expect(value.issuedBy.userId).toBe(admin().userId);
    expect(pdfTextRuns(await pdfOf(value.id)).join(' ')).toContain(utcSecond(value.issuedAt));
    const row = await testDb.issuedDocument.findUniqueOrThrow({ where: { id: value.id } });
    expect(row.issuedAt.toISOString()).toBe(value.issuedAt);
  });

  it('FR-DOC-03: typed values are kept as the project draft and prefill the next document of that type', async () => {
    await issueIp('model_card', ipSeal1, { 'MC-18': '0.81' });
    expect(await documentDraft(ctx(), projectId, 'model_card')).toEqual({ 'MC-18': '0.81' });
    expect(await documentDraft(ctx(), projectId, 'data_card')).toEqual({});
    const second = await issueIp('model_card', ipSeal1, { 'MC-18': '0.81' });
    expect(pdfTextRuns(await pdfOf(second.value.id)).join(' ')).toContain('0.81');
  });

  it('FR-DOC-03 FR-REV-08 (REV-b F2): the draft value is byte-identical to the issued typed value, whatever the characters', async () => {
    const odd = '  Café ŋ  ';   // leading and trailing spaces, a combining accent, ŋ
    const { value } = await issueIp('model_card', ipSeal1, { 'MC-18': odd, 'MC-05': '   ' });
    const row = await testDb.issuedDocument.findUniqueOrThrow({ where: { id: value.id } });
    const issued = (row.typedFields as Array<{ fieldId: string; value: string }>).find((t) => t.fieldId === 'MC-18');
    const draft = await documentDraft(ctx(), projectId, 'model_card');
    expect(issued?.value).toBe(odd);
    expect(draft['MC-18']).toBe(odd);
    expect(Buffer.from(draft['MC-18'])).toEqual(Buffer.from(issued!.value));
    expect(Object.keys(draft)).toEqual(['MC-18']);   // a blank value is not kept
    expect((row.typedFields as Array<{ fieldId: string }>).map((t) => t.fieldId)).toEqual(['MC-18']);
  });

  it('FR-DOC-03 (D5): an unknown typed field id and a value over 2000 characters answer 422', async () => {
    await expect(preview({ typedFields: { 'DC-99': 'x' } })).rejects.toMatchObject({ status: 422, code: 'validation' });
    await expect(preview({ typedFields: { 'DC-25': 'x'.repeat(2001) } })).rejects.toMatchObject({ status: 422, code: 'validation' });
    await expect(preview({ typedFields: { 'DC-25': 5 as unknown as string } })).rejects.toMatchObject({ status: 422 });
    await expect(preview({ typedFields: { 'DC-01': 'a record field takes no typed value' } })).rejects.toMatchObject({ status: 422 });
    await expect(preview({ typedFields: { 'DC-25': 'x'.repeat(2000) } })).resolves.toBeDefined();
    await expect(issue({ typedFields: { 'DC-99': 'x' } })).rejects.toMatchObject({ status: 422 });
    expect(await count('issued_documents')).toBe(0);
  });

  it('FR-DOC-03 (CG-10): the ethics review takes its sub-fields and no other state', async () => {
    const p = await preview({ typedFields: { 'DC-15:state': 'approved', 'DC-15:committee': 'MakREC' } });
    expect(p.text).toContain('Approved (committee: MakREC');
    await expect(preview({ typedFields: { 'DC-15:state': 'maybe' } })).rejects.toMatchObject({ status: 422, code: 'validation' });
    await expect(preview({ typedFields: { 'DC-15': 'x' } })).rejects.toMatchObject({ status: 422 });
  });

  it('FR-DOC-02 FR-REV-08: every printed record field and evidence file has a source row', async () => {
    const { value } = await issue();
    const rows = await testDb.issuedDocumentSource.findMany({ where: { documentId: value.id } });
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ sourceTable: 'decision_versions', field: 'reason' }), expect.objectContaining({ sourceTable: 'evidence', field: null })]));
  });

  it('FR-PRJ-03 RF-4: preview and issue in an archived project answer 409 project_archived and write nothing', async () => {
    await testDb.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    await expect(preview()).rejects.toMatchObject({ status: 409, code: 'project_archived' });
    await expect(issue()).rejects.toMatchObject({ status: 409, code: 'project_archived' });
    expect(await count('issued_documents')).toBe(0);
    expect(await count('document_draft_fields')).toBe(0);
  });

  it('FR-PRJ-03 RF-4: a project archived while the document renders is still refused inside the write, and nothing is stored', async () => {
    const spy = vi.spyOn(RENDERERS as { data_card: Renderer }, 'data_card').mockImplementationOnce(async (input: Parameters<Renderer>[0]) => {
      await testDb.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
      return (await vi.importActual<typeof import('@/lib/documents/render/dataCard')>('@/lib/documents/render/dataCard')).renderDataCard(input);
    });
    await expect(issue({ typedFields: { 'DC-25': 'x' } })).rejects.toMatchObject({ status: 409, code: 'project_archived' });
    expect(await count('issued_documents')).toBe(0);
    expect(await count('document_draft_fields')).toBe(0);
    spy.mockRestore();
  });

  it('FR-DOC-01 NFR-SEC-02: a seal of another review answers 422 and of another organisation 404, and nothing is rendered', async () => {
    const spy = vi.spyOn(RENDERERS as { data_card: Renderer }, 'data_card');
    await expect(preview({ sealId: ipSeal1 })).rejects.toMatchObject({ status: 422, code: 'validation' });
    await expect(issue({ sealId: ipSeal1 })).rejects.toMatchObject({ status: 422, code: 'validation' });
    const other = await buildOrg({ label: 'dsvc-other' });
    const otherProject = (await addProject(other)).id;
    const otherReview = (await addStageReview(other, otherProject, { stage: 'pre-processing' })).id;
    const foreign = await sealFixture(other, otherReview, { projectId: otherProject, stage: 'pre-processing', contentVersionId, decisionVersionIds: [] });
    await expect(preview({ sealId: foreign.id })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(preview({ sealId: randomUUID() })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(preview({ reviewId: otherReview })).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(spy).not.toHaveBeenCalled();
    expect(await count('issued_documents')).toBe(0);
    spy.mockRestore();
  });

  it('NFR-OBS-01 NFR-PRIV-03: one DOCUMENT_ISSUED line with ids only and no marker', async () => {
    const { lines } = await captureLogs(() => issue({ typedFields: { 'DC-25': markerFor('typed', 1) } }));
    const issued = lines.filter((l) => l.includes('DOCUMENT_ISSUED'));
    expect(issued).toHaveLength(1);
    expect(JSON.parse(issued[0]).details).toEqual({ orgId: fx.org.id, documentId: expect.any(String), documentType: 'data_card', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
  });

  it('NFR-INT-02 FR-DEC-07: the same request id with the same body replays the first document, renders nothing and logs nothing', async () => {
    const requestId = randomUUID();
    const first = await issue({}, requestId);
    expect(first.replayed).toBe(false);
    const spy = vi.spyOn(RENDERERS as { data_card: Renderer }, 'data_card');
    const { result: again, lines } = await captureLogs(() => issue({}, requestId));
    expect(again.replayed).toBe(true);
    expect(again.value.id).toBe(first.value.id);
    expect(spy).not.toHaveBeenCalled();
    expect(lines.filter((l) => l.includes('DOCUMENT_ISSUED'))).toEqual([]);
    expect(await count('issued_documents')).toBe(1);
    await expect(issue({ typedFields: { 'DC-25': 'changed' } }, requestId)).rejects.toMatchObject({ status: 409, code: 'request_id_reused' });
    await testDb.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    expect((await issue({}, requestId)).replayed).toBe(true);   // a replay writes nothing, so an archive since does not refuse it
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('DOC-b boundary: preview and issue of a mitigation plan throw not_implemented until DOC-b registers it', async () => {
    await expect(preview({ documentType: 'mitigation_plan' })).rejects.toMatchObject({ status: 501 });
    await expect(issue({ documentType: 'mitigation_plan' })).rejects.toMatchObject({ status: 501 });
    expect(await count('issued_documents')).toBe(0);
  });

  it('FR-DOC-01: an unknown document type is refused on documentType', async () => {
    await expect(preview({ documentType: 'poster' as DocumentType })).rejects.toMatchObject({ status: 422, code: 'validation' });
  });

  it('FR-AUTHZ-01: an assessor cannot preview or issue at the service either', async () => {
    const actor = { userId: fx.members.assessor.userId, role: 'assessor' as const };
    await expect(previewDocument(ctxFor(fx, 'assessor'), actor, body())).rejects.toMatchObject({ name: 'ForbiddenError' });
    await expect(issueDocument(ctxFor(fx, 'assessor'), actor, { ...body(), requestId: randomUUID() }, 'x')).rejects.toMatchObject({ name: 'ForbiddenError' });
  });
});

describe('lists and downloads', () => {
  it('FR-DOC-04: documents list newest first, with the seals, issuer and size, and without bytes', async () => {
    const a = await issue();
    const b = await issueIp('model_card');
    const all = await listDocuments(ctx(), { projectId });
    expect(all.map((d) => d.id).sort()).toEqual([a.value.id, b.value.id].sort());
    expect(all.map((d) => d.issuedAt)).toEqual([...all.map((d) => d.issuedAt)].sort().reverse());   // newest first
    expect(all.find((d) => d.id === b.value.id)).toMatchObject({ documentType: 'model_card', reviewId: ipReview, projectId, withdrawn: null, erased: null });
    expect(all.find((d) => d.id === b.value.id)!.byteSize).toBeGreaterThan(1000);
    expect((await listDocuments(ctx(), { projectId, reviewId: ppReview })).map((d) => d.id)).toEqual([a.value.id]);
    const views: Map<string, IssuedDocumentView> = await withOrg(ctx(), (tx) => documentViews(tx, [a.value.id, b.value.id]));
    expect(views.get(a.value.id)?.seals[0].sealId).toBe(ppSeal);
    expect(JSON.stringify(all)).not.toContain('pdf');
  });

  it('FR-DOC-06 (view): a withdrawn document shows the date and reason of its withdrawal event', async () => {
    const a = await issue();
    await testDb.documentEvent.create({ data: { orgId: fx.org.id, documentId: a.value.id, kind: 'withdrawn', reason: 'Sent to the wrong committee.', byId: fx.members.owner.userId, requestId: randomUUID(), requestDigest: 'x' } });
    const [v] = await listDocuments(ctx(), { projectId });
    expect(v.withdrawn).toEqual({ on: new Date().toISOString().slice(0, 10), reason: 'Sent to the wrong committee.' });
  });

  it('FR-DOC-04: a download returns the stored bytes under a name that holds no team text', async () => {
    const a = await issue({ typedFields: { 'DC-25': 'CC BY 4.0' } });
    const { bytes, fileName } = await readDocumentPdf(ctx(), a.value.id);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(a.value.sha256);
    expect(fileName).toMatch(new RegExp(`^data-card-\\d{4}-\\d{2}-\\d{2}-${a.value.id.slice(0, 8)}\\.pdf$`));
    expect((await readDocumentPdf(ctx(), a.value.id)).bytes.equals(bytes)).toBe(true);
  });

  it('NFR-INT-06: a document whose bytes do not match its SHA-256 is never served, and the failure is logged once', async () => {
    const a = await issue();
    const real = await testDb.issuedDocument.findUniqueOrThrow({ where: { id: a.value.id } });
    // A row whose stored hash is that of other bytes (raw insert; the trigger only forbids changing a stored row).
    const [{ issuedAt }] = await testDb.$queryRaw<{ issuedAt: Date }[]>`SELECT date_trunc('second', clock_timestamp()) - interval '5 seconds' AS "issuedAt"`;
    const bad = await testDb.issuedDocument.create({ data: {
      orgId: fx.org.id, projectId, stageReviewId: ppReview, sealId: ppSeal, documentType: 'data_card', templateVersion: '5.0.0', typedFields: [],
      pdf: Uint8Array.from(Buffer.from('%PDF-not-what-was-hashed')), plainText: 'x', sha256: real.sha256, byteSize: 24, issuedById: admin().userId, issuedAt,
      requestId: randomUUID(), requestDigest: 'x',
    } });
    const { result, lines } = await captureLogs(() => readDocumentPdf(ctx(), bad.id).then(() => 'served', (e: unknown) => e));
    expect(result).toMatchObject({ status: 500, code: 'integrity_failure' });
    const failure = lines.filter((l) => l.includes('DOCUMENT_INTEGRITY_FAILURE'));
    expect(failure).toHaveLength(1);
    expect(JSON.parse(failure[0]).details).toEqual({ orgId: fx.org.id, documentId: bad.id });
  });

  it('FR-DOC-04 FR-REV-08: a document whose bytes the operator erased answers 410 with the date of the erasure', async () => {
    const a = await issue();
    expect(await testDb.issuedDocumentSource.count({ where: { documentId: a.value.id, sourceTable: 'evidence', sourceId: evidenceId, field: null } })).toBe(1);
    await testDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE makrai_operator_fn');
      await tx.$executeRawUnsafe(`SELECT erase_evidence_bytes('${fx.org.id}','${evidenceId}','ER','I')`);
    });
    const today = new Date().toISOString().slice(0, 10);
    await expect(readDocumentPdf(ctx(), a.value.id)).rejects.toMatchObject({ status: 410, code: 'erased', extra: { erasedOn: today } });
    const [v] = await listDocuments(ctx(), { projectId });
    expect(v.erased).toEqual({ erasedOn: today });
    expect(v.sha256).toBe(a.value.sha256);   // the row and its hash always stay
  });

  it('NFR-SEC-02: a document of another organisation, and one that does not exist, are not found', async () => {
    const a = await issue();
    const other = await buildOrg({ label: 'dsvc-b' });
    await expect(readDocumentPdf(ctxFor(other, 'admin'), a.value.id)).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(readDocumentPdf(ctx(), randomUUID())).rejects.toMatchObject({ name: 'NotFoundError' });
  });
});
