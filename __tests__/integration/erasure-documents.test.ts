import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { checkSeal, sealStageReview } from '@/lib/data/seals';
import { listStageReviews } from '@/lib/data/reviews';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { markerFor, markerText } from '../helpers/markers';
import { addDecision, addIssuedDocument, addProject, addSealRow, addStageReview, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

/**
 * FR-REV-08 and NFR-PRIV-07: the operator's erasure reaches every stored copy. `erase_typed_field` (migration
 * 20261101000000_rev_b_erase_typed_field) erases a document-only value; K0a's `erase_text_field` erases a sealed
 * free-text field and the bytes of the documents that printed it. Operator functions run as their owner role, as
 * an operator runs them (contract E-19 T8); the application roles are refused.
 */

const MIGRATION = 'prisma/migrations/20261101000000_rev_b_erase_typed_field/migration.sql';
/** The eleven retry-keyed tables (lib/data/idempotency.ts, IdempotentTable). */
const IDEMPOTENT_TABLES = ['decision_versions', 'evidence', 'findings', 'finding_events', 'mitigation_versions', 'accepted_risks',
  'stage_reviews', 'seals', 'issued_documents', 'document_events', 'request_receipts'];

let fx: OrgFixture;
let fxB: OrgFixture;
let p: { id: string };
let r: { id: string };
let v1: string;

/** The digest of SRS line 1292, by Node: SHA-256(salt ‖ 0x00 ‖ field ‖ 0x00 ‖ UTF-8(NFC(text))). */
function saltedDigestHex(salt: Buffer, field: string, text: string): string {
  return createHash('sha256').update(Buffer.concat([salt, Buffer.from([0]), Buffer.from(field, 'utf8'), Buffer.from([0]),
    Buffer.from(text.normalize('NFC'), 'utf8')])).digest('hex');
}

const asOperator = (sql: string) => testDb.$transaction(async (tx) => {
  await tx.$executeRawUnsafe('SET LOCAL ROLE makrai_operator_fn');
  await tx.$executeRawUnsafe(sql);
});
const runAsRole = (role: string, sql: string) => testDb.$transaction(async (tx) => {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${fx.org.id}', true)`);
  await tx.$executeRawUnsafe(sql);
});

async function procRow(name: string) {
  const [row] = await testDb.$queryRaw<{ owner: string; prosecdef: boolean; proconfig: string[] | null; acl: string[] | null }[]>`
    SELECT pg_get_userbyid(proowner)::text AS owner, prosecdef, proconfig, proacl::text[] AS acl FROM pg_proc WHERE proname = ${name}`;
  return row;
}

async function sealOf(reviewId: string, role: OrgRole = 'reviewer') {
  const out = await sealStageReview(ctxFor(fx, role), { userId: fx.members[role].userId, role },
    { requestId: randomUUID(), projectId: p.id, reviewId }, randomUUID().replace(/-/g, '').padEnd(64, '0'));
  return out.value;
}

/**
 * A data card of the review's project holding one typed field (DOC-a's encoding: the salt is 16 random bytes as 32
 * lowercase hex characters), printed in its bytes and plain text, and the project's draft row (`opts.draft`, or the
 * erased value and one other field). Written as `makrai`, as the record fixture writes, with the request digest given.
 */
async function issuedWithTypedField(org: OrgFixture, projectId: string, reviewId: string, fieldId: string, value: string,
  opts: { draft?: Record<string, string>; requestDigest?: string } = {}): Promise<{ id: string; sha256: string; salt: string; requestDigest: string }> {
  const seal = await addSealRow(org, reviewId);
  const salt = randomBytes(16).toString('hex');
  const pdf = Buffer.from(`%PDF-1.4 data card ${value}`);
  const sha256 = createHash('sha256').update(pdf).digest('hex');
  const requestDigest = opts.requestDigest ?? createHash('sha256').update(randomUUID()).digest('hex');
  const [{ issuedAt }] = await testDb.$queryRaw<{ issuedAt: Date }[]>`SELECT date_trunc('second', clock_timestamp()) - interval '60 seconds' AS "issuedAt"`;
  const doc = await testDb.issuedDocument.create({ data: {
    orgId: org.org.id, projectId, stageReviewId: reviewId, sealId: seal.id, documentType: 'data_card', templateVersion: '1',
    typedFields: [{ fieldId, value, salt }], pdf: Uint8Array.from(pdf), plainText: `Data card. ${fieldId}: ${value}`, sha256,
    byteSize: pdf.byteLength, issuedById: org.members.owner.userId, issuedAt, requestId: randomUUID(), requestDigest,
  } });
  await testDb.issuedDocumentSeal.create({ data: { orgId: org.org.id, documentId: doc.id, sealId: seal.id } });
  await testDb.documentDraftFields.upsert({
    where: { orgId_projectId_documentType: { orgId: org.org.id, projectId, documentType: 'data_card' } },
    create: { orgId: org.org.id, projectId, documentType: 'data_card', fieldValues: opts.draft ?? { [fieldId]: value, 'DC-25': 'CC BY 4.0' }, updatedById: org.members.owner.userId },
    update: { fieldValues: opts.draft ?? { [fieldId]: value, 'DC-25': 'CC BY 4.0' } },
  });
  return { id: doc.id, sha256, salt, requestDigest };
}

async function draftValues(projectId: string, documentType: string): Promise<unknown> {
  return (await testDb.documentDraftFields.findFirstOrThrow({ where: { projectId, documentType } })).fieldValues;
}

/** The retry-keyed tables (of any organisation) with a row whose request digest is `d`. */
async function rowsWithDigest(d: string): Promise<string[]> {
  const out: string[] = [];
  for (const t of IDEMPOTENT_TABLES) {
    const [{ n }] = await testDb.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}" WHERE "requestDigest" = $1`, d);
    if (n > 0) out.push(t);
  }
  return out;
}

/** Every `table.column` of the public schema, of any text, array, jsonb or bytea type, with a row that holds `s`. */
async function tablesHolding(s: string): Promise<string[]> {
  const cols = await testDb.$queryRaw<{ t: string; c: string; type: string }[]>`
    SELECT table_name::text AS t, column_name::text AS c, data_type::text AS type FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'bytea', 'ARRAY')
    ORDER BY 1, 2`;
  expect(cols.length).toBeGreaterThan(50);   // the scan reads the real column list, not an empty one
  const out: string[] = [];
  for (const { t, c, type } of cols) {
    const test = type === 'bytea' ? `position(convert_to($1, 'UTF8') in "${c}") > 0` : `strpos("${c}"::text, $1) > 0`;
    const [{ n }] = await testDb.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}" WHERE ${test}`, s);
    if (n > 0) out.push(`${t}.${c}`);
  }
  return out;
}

beforeEach(async () => {
  await resetDb();
  const { contentVersionId } = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg({ text: markerText });
  fxB = await buildOrg({ label: 'b' });
  p = await addProject(fx);
  v1 = (await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, declaredDate: '2026-10-20' })).id;
  r = await addStageReview(fx, p.id, { stage: 'pre-processing' });
});

describe('erase_typed_field', () => {
  it('FR-REV-08 NFR-SEC-12: erase_typed_field is a definer function only its owner may run, and makrai_app and makrai_identity are refused', async () => {
    const doc = await issuedWithTypedField(fx, p.id, r.id, 'DC-05', 'Issued text');
    expect(await procRow('erase_typed_field')).toMatchObject({
      owner: 'makrai_operator_fn', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], acl: ['makrai_operator_fn=X/makrai_operator_fn'],
    });
    for (const role of ['makrai_app', 'makrai_identity']) {
      await expect(runAsRole(role, `SELECT erase_typed_field('${fx.org.id}','${doc.id}','DC-05','ER','I')`)).rejects.toThrow(/permission denied/);
    }
    expect((await testDb.issuedDocument.findUniqueOrThrow({ where: { id: doc.id } })).typedFields).toEqual([{ fieldId: 'DC-05', value: 'Issued text', salt: doc.salt }]);
    expect(readFileSync(MIGRATION, 'utf8')).not.toMatch(/erase_text_field|erase_evidence_bytes/);   // K0a's functions untouched
  });

  it("FR-REV-08 NFR-PRIV-07: erase_typed_field nulls the value, its salt and its document's bytes, removes the equal draft value, writes the tombstone, and erases the issue request's digest", async () => {
    const value = markerFor('typed', 1);
    const doc = await issuedWithTypedField(fx, p.id, r.id, 'DC-05', value);
    // Another row of the same request in this organisation carries the same digest (rows made under derived request
    // ids do); a row of organisation B that happens to hold the same digest is not this organisation's to change.
    const sibling = await testDb.stageReview.create({ data: {
      orgId: fx.org.id, projectId: p.id, stage: 'in-processing', numberInStage: 1, openedById: fx.members.owner.userId,
      requestId: randomUUID(), requestDigest: doc.requestDigest,
    } });
    const pB = await addProject(fxB);
    const ofB = await testDb.stageReview.create({ data: {
      orgId: fxB.org.id, projectId: pB.id, stage: 'pre-processing', numberInStage: 1, openedById: fxB.members.owner.userId,
      requestId: randomUUID(), requestDigest: doc.requestDigest,
    } });

    await asOperator(`SELECT erase_typed_field('${fx.org.id}','${doc.id}','DC-05','ER-3','INSTR-3')`);

    const row = await testDb.issuedDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(row.typedFields).toEqual([{ fieldId: 'DC-05', value: null, salt: null }]);
    expect([row.pdf, row.plainText, row.sha256]).toEqual([null, null, doc.sha256]);
    expect(await draftValues(p.id, 'data_card')).toEqual({ 'DC-25': 'CC BY 4.0' });
    expect(await testDb.tombstone.findMany({ where: { targetId: doc.id } })).toEqual([expect.objectContaining({
      orgId: fx.org.id, targetTable: 'issued_documents', field: 'typedFields.DC-05',
      digest: saltedDigestHex(Buffer.from(doc.salt, 'hex'), 'typedFields.DC-05', value), erasureCode: 'ER-3', instructionReference: 'INSTR-3',
    })]);
    expect(row.requestDigest).toBe('erased');
    expect((await testDb.stageReview.findUniqueOrThrow({ where: { id: sibling.id } })).requestDigest).toBe('erased');
    expect(await rowsWithDigest(doc.requestDigest)).toEqual(['stage_reviews']);   // only organisation B's row still holds it
    expect((await testDb.stageReview.findUniqueOrThrow({ where: { id: ofB.id } })).requestDigest).toBe(doc.requestDigest);
    expect(await tablesHolding(value)).toEqual([]);
  });

  it('FR-REV-08: a draft value that differs from the erased text is kept', async () => {
    const doc = await issuedWithTypedField(fx, p.id, r.id, 'DC-05', 'Issued text', { draft: { 'DC-05': 'Edited since' } });
    await asOperator(`SELECT erase_typed_field('${fx.org.id}','${doc.id}','DC-05','ER','I')`);
    expect(await draftValues(p.id, 'data_card')).toEqual({ 'DC-05': 'Edited since' });
  });

  it('FR-REV-08: erase_typed_field refuses a document of another organisation, an unknown field id and an already erased field, and changes nothing', async () => {
    const doc = await issuedWithTypedField(fx, p.id, r.id, 'DC-05', 'Issued text');
    const pB = await addProject(fxB);
    const rB = await addStageReview(fxB, pB.id, { stage: 'pre-processing' });
    const docOfB = await issuedWithTypedField(fxB, pB.id, rB.id, 'DC-05', 'Text of B');
    const snapshot = async () => ({
      docs: await testDb.issuedDocument.findMany({ orderBy: { id: 'asc' }, select: { id: true, typedFields: true, pdf: true, plainText: true, requestDigest: true } }),
      drafts: await testDb.documentDraftFields.findMany({ orderBy: { id: 'asc' }, select: { id: true, fieldValues: true } }),
      tombstones: await testDb.tombstone.count(),
    });
    const before = await snapshot();
    await expect(asOperator(`SELECT erase_typed_field('${fx.org.id}','${docOfB.id}','DC-05','ER','I')`)).rejects.toThrow(/erase_typed_field/);
    await expect(asOperator(`SELECT erase_typed_field('${fx.org.id}','${doc.id}','DC-99','ER','I')`)).rejects.toThrow(/erase_typed_field/);
    await expect(asOperator(`SELECT erase_typed_field('${fx.org.id}','${doc.id}','DC-05','','I')`)).rejects.toThrow(/erase_typed_field/);
    expect(await snapshot()).toEqual(before);
    await asOperator(`SELECT erase_typed_field('${fx.org.id}','${doc.id}','DC-05','ER','I')`);
    const afterOne = await snapshot();
    await expect(asOperator(`SELECT erase_typed_field('${fx.org.id}','${doc.id}','DC-05','ER','I')`)).rejects.toThrow(/erase_typed_field/);
    expect(await snapshot()).toEqual(afterOne);
    expect(afterOne.tombstones).toBe(before.tombstones + 1);   // only the one real erasure
    expect((await testDb.issuedDocument.findUniqueOrThrow({ where: { id: docOfB.id } })).typedFields).toEqual([{ fieldId: 'DC-05', value: 'Text of B', salt: docOfB.salt }]);
  });
});

describe("K0a's erase_text_field reaching seals, documents and reviews", () => {
  it('FR-REV-08: given a sealed reason, the operator erases text and salt, writes a tombstone, and the check reads valid with 1 field erased', async () => {
    const s = await sealOf(r.id);
    await asOperator(`SELECT erase_text_field('${fx.org.id}','decision_versions','${v1}','reason','ER-1','INSTR-1')`);
    expect(await testDb.decisionVersion.findUniqueOrThrow({ where: { id: v1 } })).toMatchObject({ reason: null, reasonSalt: null });
    expect(await testDb.tombstone.findFirstOrThrow({ where: { targetId: v1 } })).toMatchObject({ field: 'reason', erasureCode: 'ER-1', instructionReference: 'INSTR-1' });
    expect(await checkSeal(ctxFor(fx, 'viewer'), s.id)).toMatchObject({ kind: 'valid', erasedFields: 1 });
  });

  it('FR-REV-08 NFR-PRIV-07: an erased reason a mitigation plan printed nulls the plan bytes, keeps its SHA-256, and no row of any table holds the marker', async () => {
    const reason = (await testDb.decisionVersion.findUniqueOrThrow({ where: { id: v1 } })).reason as string;
    const marker = reason.match(/ZZMARK-reason-\d+-QX/)![0];   // the reason of v1, written by buildOrg({ text: markerText })
    const s = await sealOf(r.id);
    const original = Buffer.from(`%PDF-1.4 fixture ${marker}`);
    const doc = await addIssuedDocument(fx, r.id, { documentType: 'mitigation_plan', sealIds: [s.id], pdf: original });
    await testDb.issuedDocumentSource.create({ data: { orgId: fx.org.id, documentId: doc.id, sourceTable: 'decision_versions', sourceId: v1, field: 'reason' } });
    expect(await tablesHolding(marker)).toEqual(['decision_versions.reason', 'issued_documents.pdf']);   // the scan sees both copies before
    await asOperator(`SELECT erase_text_field('${fx.org.id}','decision_versions','${v1}','reason','ER-1','INSTR-1')`);
    expect(await testDb.issuedDocument.findUniqueOrThrow({ where: { id: doc.id } })).toMatchObject({ pdf: null, plainText: null, sha256: doc.sha256 });
    expect(createHash('sha256').update(original).digest('hex')).toBe(doc.sha256);   // the holder's copy still matches
    expect(await tablesHolding(marker)).toEqual([]);
  });

  it('FR-REV-01 FR-REV-08 (R-67): erasing a sealed review note keeps the seal valid and S-16 reads erased', async () => {
    const rWithNote = await addStageReview(fx, p.id, { stage: 'pre-processing', preparedFor: markerFor('preparedFor', 1) });
    const s = await sealOf(rWithNote.id);
    await asOperator(`SELECT erase_text_field('${fx.org.id}','stage_reviews','${rWithNote.id}','preparedFor','ER-4','INSTR-4')`);
    expect(await checkSeal(ctxFor(fx, 'viewer'), s.id)).toMatchObject({ kind: 'valid', erasedFields: 1 });
    const [v] = (await listStageReviews(ctxFor(fx, 'viewer'), p.id)).filter((x) => x.id === rWithNote.id);
    expect([v.preparedFor, v.preparedForErased]).toEqual([null, { erasedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }]);
  });
});
