import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { resetDb } from '../helpers/db';
import { derivedRequestId, idempotentWrite, requestDigest } from '../../lib/data/idempotency';
import type { OrgContext } from '../../lib/data/tenant';

/**
 * SRS 5.6 (lines 1302-1310), FR-EVD-05, FR-REV-08, NFR-SEC-12: the two operator erasure
 * procedures, exactly as 00-contract.md's row for 20261030000500_v060_05_functions fixes
 * them, and makrai_clear_consent_ip_addresses() (gap G099). Owned by the NOLOGIN role
 * makrai_operator_fn, SECURITY DEFINER, search_path pinned, executable by no application
 * role; each sets the organisation context from its argument, refuses unless exactly one
 * target row matches, writes one tombstone and follows issued_document_sources to null the
 * bytes of every document that printed the erased field or file.
 */

/** The digest of SRS line 1292, by Node: SHA-256(salt ‖ 0x00 ‖ field ‖ 0x00 ‖ UTF-8(NFC(text))). */
function expectedDigest(salt: Buffer, field: string, text: string): string {
  return createHash('sha256').update(Buffer.concat([salt, Buffer.from([0]), Buffer.from(field, 'utf8'), Buffer.from([0]),
    Buffer.from(text.normalize('NFC'), 'utf8')])).digest('hex');
}
const hex64 = (seed: string) => createHash('sha256').update(seed).digest('hex');

/** Every erasable free-text field: table, digest field name (the manifest key), column. */
const ERASABLE: Array<[string, string, string]> = [
  ['decision_versions', 'reason', 'reason'],
  ['evidence', 'fileName', 'filename'], ['evidence', 'url', 'url'], ['evidence', 'label', 'label'],
  ['findings', 'title', 'title'], ['findings', 'description', 'description'],
  ['finding_events', 'reason', 'reason'],
  ['mitigation_versions', 'what', 'what'], ['mitigation_versions', 'changeNote', 'changeNote'],
  ['mitigation_versions', 'closureNote', 'closureNote'], ['mitigation_versions', 'cancelReason', 'cancelReason'],
  ['accepted_risks', 'reason', 'reason'], ['accepted_risks', 'lookAgainNote', 'lookAgainNote'],
  ['stage_reviews', 'preparedFor', 'preparedFor'],
];

let su: Client;
type Org = { org: string; user: string; project: string; review: string; seal: string };
let A: Org;
let B: Org;
const FV = 'fv_k0a_op';

const q = async (sql: string, params: unknown[] = []) => (await su.query(sql, params)).rows;
const asOperator = (sql: string, params: unknown[] = []) => su.query(sql, params);   // the owner role runs operator functions (contract E-19 T8)

/** Runs `sql` as makrai_operator_fn with the organisation context set, in a rolled-back transaction. */
async function asOperatorIn(orgId: string, sql: string): Promise<void> {
  await su.query('BEGIN');
  try {
    await su.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
    await su.query('SET LOCAL ROLE makrai_operator_fn');
    await su.query(sql);
  } finally {
    await su.query('ROLLBACK');
  }
}

async function callAs(role: string, call: string): Promise<void> {
  const url = role === 'makrai_app' ? process.env.APP_DATABASE_URL : process.env.IDENTITY_DATABASE_URL;
  const c = new Client({ connectionString: url, options: '' });
  await c.connect();
  try {
    await c.query(`SELECT ${call}`);
  } finally {
    await c.end();
  }
}

async function buildOrg(label: string): Promise<Org> {
  const o = { org: randomUUID(), user: randomUUID(), project: randomUUID(), review: randomUUID(), seal: randomUUID() };
  await q(`INSERT INTO users (id, email, name, "passwordHash", "updatedAt") VALUES ($1, $2, 'u', 'x', now())`, [o.user, `op-${o.user}@fixture.test`]);
  await q(`INSERT INTO organizations (id, name, slug, "updatedAt") VALUES ($1, $2, $3, now())`, [o.org, `op ${label}`, `op-${o.org.slice(0, 8)}`]);
  await q(`INSERT INTO projects (id, "orgId", name, "createdById", "updatedAt") VALUES ($1, $2, 'p', $3, now())`, [o.project, o.org, o.user]);
  await q(`INSERT INTO stage_reviews (id, "orgId", "projectId", stage, "numberInStage", "preparedFor", "openedById", "requestId", "requestDigest")
    VALUES ($1, $2, $3, 'pre-processing', 1, 'ZZMARK-preparedFor-1-QX', $4, gen_random_uuid(), 'd')`, [o.review, o.org, o.project, o.user]);
  await q(`INSERT INTO seals (id, "orgId", "stageReviewId", "sealNumber", format, "contentVersionId", manifest, fingerprint, "sealedById", "sealedByRole", "requestId", "requestDigest")
    VALUES ($1, $2, $3, 1, 'makrai.seal/1', $4, '\\x7b7d', $5, $6, 'owner', gen_random_uuid(), 'd')`, [o.seal, o.org, o.review, FV, hex64('{}'), o.user]);
  return o;
}

/** A document that printed (sourceTable, sourceId, field), with bytes; issuedAt one second past the seal's latest (C4 CR-1). */
async function addDocumentPrinting(o: Org, sourceTable: string, sourceId: string, field: string | null, typedFields = '[]'): Promise<string> {
  const doc = randomUUID();
  await q(`INSERT INTO issued_documents (id, "orgId", "projectId", "stageReviewId", "sealId", "documentType", "templateVersion", "typedFields", pdf, "plainText", sha256, "byteSize", "issuedById", "issuedAt", "requestId", "requestDigest")
    VALUES ($1, $2, $3, $4, $5, 'data_card', '1', $6::jsonb, '\\x255044462d', 'plain text', $7, 5, $8,
      GREATEST(date_trunc('second', clock_timestamp()) - interval '119 seconds',
               (SELECT max("issuedAt") FROM issued_documents WHERE "orgId" = $2 AND "sealId" = $5 AND "documentType" = 'data_card') + interval '1 second'),
      gen_random_uuid(), 'd')`,
    [doc, o.org, o.project, o.review, o.seal, typedFields, hex64('DOC'), o.user]);
  await q(`INSERT INTO issued_document_sources (id, "orgId", "documentId", "sourceTable", "sourceId", field) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5)`,
    [o.org, doc, sourceTable, sourceId, field]);
  return doc;
}

/** One row per erasable table, every free-text field of it a marker; returns the ids. */
async function addRecordRows(o: Org): Promise<Record<string, string>> {
  const ids: Record<string, string> = {
    decision_versions: randomUUID(), evidence: randomUUID(), findings: randomUUID(), finding_events: randomUUID(),
    mitigation_versions: randomUUID(), accepted_risks: randomUUID(), stage_reviews: o.review,
  };
  await q(`INSERT INTO decision_versions (id, "orgId", "projectId", stage, "questionId", "contentVersionId", "versionNumber", status, reason, "enteredById", "enteredByRole", "requestId", "requestDigest")
    VALUES ($1, $2, $3, 'pre-processing', $4, $5, 1, 'partly', 'ZZMARK-reason-1-QX', $6, 'owner', gen_random_uuid(), 'd')`,
    [ids.decision_versions, o.org, o.project, `Q-${randomUUID().slice(0, 6)}`, FV, o.user]);
  await q(`INSERT INTO evidence (id, "orgId", "projectId", kind, filename, url, label, "uploadedById", "requestId", "requestDigest")
    VALUES ($1, $2, $3, 'link', 'ZZMARK-fileName-1-QX', 'https://x.test/ZZMARK-url-1-QX', 'ZZMARK-label-1-QX', $4, gen_random_uuid(), 'd')`,
    [ids.evidence, o.org, o.project, o.user]);
  await q(`INSERT INTO findings (id, "orgId", "projectId", stage, source, title, description, "raisedById", "requestId", "requestDigest")
    VALUES ($1, $2, $3, 'pre-processing', 'team', 'ZZMARK-title-1-QX', 'ZZMARK-description-1-QX', $4, gen_random_uuid(), 'd')`,
    [ids.findings, o.org, o.project, o.user]);
  await q(`INSERT INTO finding_events (id, "orgId", "findingId", kind, reason, "byId", "requestId", "requestDigest")
    VALUES ($1, $2, $3, 'reopened', 'ZZMARK-reason-2-QX', $4, gen_random_uuid(), 'd')`, [ids.finding_events, o.org, ids.findings, o.user]);
  await q(`INSERT INTO mitigation_versions (id, "orgId", "findingId", "mitigationId", "versionNumber", what, "changeNote", "closureNote", "cancelReason", "ownerUserId", "dueDate", status, kind, "enteredById", "enteredByRole", "requestId", "requestDigest")
    VALUES ($1, $2, $3, $4, 1, 'ZZMARK-what-1-QX', 'ZZMARK-changeNote-1-QX', 'ZZMARK-closureNote-1-QX', 'ZZMARK-cancelReason-1-QX', $5, '2026-11-10', 'cancelled', 'action', $5, 'owner', gen_random_uuid(), 'd')`,
    [ids.mitigation_versions, o.org, ids.findings, randomUUID(), o.user]);
  await q(`INSERT INTO accepted_risks (id, "orgId", "findingId", reason, "lookAgainNote", "enteredById", "enteredByRole", "requestId", "requestDigest")
    VALUES ($1, $2, $3, 'ZZMARK-reason-3-QX', 'ZZMARK-lookAgainNote-1-QX', $4, 'owner', gen_random_uuid(), 'd')`, [ids.accepted_risks, o.org, ids.findings, o.user]);
  return ids;
}

beforeAll(async () => {
  await resetDb();
  su = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
  await su.connect();
  await q(`INSERT INTO framework_versions (id, semver, "contentHash", "publishedAt", status) VALUES ($1, '0.0.0-k0a-op', $2, now(), 'deprecated') ON CONFLICT (id) DO NOTHING`, [FV, hex64('fv')]);
  A = await buildOrg('a');
  B = await buildOrg('b');
});
afterAll(async () => {
  // framework_versions survives resetDb (reference data): remove this file's row, after the rows that reference it.
  await resetDb();
  await su.query(`DELETE FROM framework_versions WHERE id = $1`, [FV]);
  await su.end();
});

describe('operator erasure functions (SRS 5.6)', () => {
  it('NFR-SEC-12: erasure functions are not executable by makrai_app or makrai_identity', async () => {
    for (const role of ['makrai_app', 'makrai_identity']) {
      for (const [fn, call] of [
        ['erase_evidence_bytes(text,text,text,text)', `erase_evidence_bytes('a','b','c','d')`],
        ['erase_text_field(text,text,text,text,text,text)', `erase_text_field('a','b','c','d','e','f')`],
        ['makrai_clear_consent_ip_addresses()', 'makrai_clear_consent_ip_addresses()'],
      ]) {
        expect((await q(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]))[0].ok).toBe(false);
        await expect(callAs(role, call)).rejects.toThrow(/permission denied/);
      }
    }
    expect(await q(`SELECT p.proname, r.rolname AS owner, p.proconfig AS config FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.proname IN ('erase_evidence_bytes', 'erase_text_field', 'makrai_clear_consent_ip_addresses') ORDER BY 1`)).toEqual(
      ['erase_evidence_bytes', 'erase_text_field', 'makrai_clear_consent_ip_addresses'].map((proname) =>
        ({ proname, owner: 'makrai_operator_fn', config: ['search_path=pg_catalog, public, pg_temp'] })));
    expect(await q(`SELECT proname, pg_get_function_arguments(oid) AS args, pg_get_function_result(oid) AS result, prosecdef FROM pg_proc WHERE proname IN ('erase_evidence_bytes', 'erase_text_field', 'makrai_clear_consent_ip_addresses') ORDER BY 1`)).toEqual([   // the contract rows, exactly
      { proname: 'erase_evidence_bytes', args: 'org_id text, evidence_id text, erasure_code text, instruction_reference text', result: 'void', prosecdef: true },
      { proname: 'erase_text_field', args: 'org_id text, target_table text, target_id text, field text, erasure_code text, instruction_reference text', result: 'void', prosecdef: true },
      { proname: 'makrai_clear_consent_ip_addresses', args: '', result: 'integer', prosecdef: true }]);
  });

  it('FR-REV-08 NFR-MNT-05: the SQL digest equals Node for decomposed text', async () => {
    const salt = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    const [{ d }] = await q(`SELECT encode(sha256($1::bytea || '\\x00'::bytea || convert_to($2, 'UTF8') || '\\x00'::bytea || convert_to(normalize($3, NFC), 'UTF8')), 'hex') AS d`,
      [salt, 'reason', 'Café ZZ']);
    expect(d).toBe('9e87cc554bffec891093a67095d8f2b7f67d09fc52b9e2350dc6a707ed81b9c5');   // contract E-14
    expect(expectedDigest(salt, 'reason', 'Café ZZ')).toBe('9e87cc554bffec891093a67095d8f2b7f67d09fc52b9e2350dc6a707ed81b9c5');
  });

  it('FR-REV-08 NFR-MNT-05: erasing each free-text field nulls text and salt, writes a tombstone with the digest, keeps the row, and nulls the documents that printed it', async () => {
    const ids = await addRecordRows(A);
    for (const [table, field, column] of ERASABLE) {
      const id = ids[table];
      const [before] = await q(`SELECT "${column}" AS text, "${column}Salt" AS salt FROM "${table}" WHERE id = $1`, [id]);
      expect(before.text, `${table}.${column}`).toMatch(/ZZMARK/);
      const doc = await addDocumentPrinting(A, table, id, field);
      await asOperator(`SELECT erase_text_field($1, $2, $3, $4, 'ER-1', 'INSTR-1')`, [A.org, table, id, field]);
      const [after] = await q(`SELECT "${column}" AS text, "${column}Salt" AS salt FROM "${table}" WHERE id = $1`, [id]);
      expect({ table, field, after }).toEqual({ table, field, after: { text: null, salt: null } });
      const tombs = await q(`SELECT field, digest, "erasureCode", "instructionReference" FROM tombstones WHERE "targetTable" = $1 AND "targetId" = $2 AND field = $3`, [table, id, field]);
      expect(tombs).toEqual([{ field, digest: expectedDigest(before.salt, field, before.text), erasureCode: 'ER-1', instructionReference: 'INSTR-1' }]);
      expect(await q(`SELECT pdf, "plainText", sha256 FROM issued_documents WHERE id = $1`, [doc])).toEqual([{ pdf: null, plainText: null, sha256: hex64('DOC') }]);
    }
    // The rows themselves are kept.
    for (const [table, id] of Object.entries(ids)) expect(await q(`SELECT count(*)::int n FROM "${table}" WHERE id = $1`, [id])).toEqual([{ n: 1 }]);
    // A field erased once cannot be erased again (there is no text to digest).
    await expect(asOperator(`SELECT erase_text_field($1, 'decision_versions', $2, 'reason', 'ER', 'I')`, [A.org, ids.decision_versions])).rejects.toThrow(/already erased/);
  });

  it('FR-EVD-05: erasing bytes deletes the blob, keeps the evidence row and sha256, nulls documents that printed it', async () => {
    const ev = randomUUID();
    const SHA = hex64('bytes');
    await q(`INSERT INTO evidence (id, "orgId", "projectId", kind, filename, "mimeType", "byteSize", sha256, "uploadedById", "requestId", "requestDigest")
      VALUES ($1, $2, $3, 'file', 'f.pdf', 'application/pdf', 3, $4, $5, gen_random_uuid(), 'd')`, [ev, A.org, A.project, SHA, A.user]);
    await q(`INSERT INTO evidence_blobs ("evidenceId", "orgId", content) VALUES ($1, $2, '\\x010203')`, [ev, A.org]);
    const doc = await addDocumentPrinting(A, 'evidence', ev, null);
    const untouched = await addDocumentPrinting(A, 'evidence', randomUUID(), null);
    await asOperator(`SELECT erase_evidence_bytes($1, $2, 'ER-2', 'INSTR-2')`, [A.org, ev]);
    expect(await q(`SELECT count(*)::int n FROM evidence_blobs WHERE "evidenceId" = $1`, [ev])).toEqual([{ n: 0 }]);
    expect(await q(`SELECT sha256 FROM evidence WHERE id = $1`, [ev])).toEqual([{ sha256: SHA }]);
    expect(await q(`SELECT pdf, "plainText", sha256 FROM issued_documents WHERE id = $1`, [doc])).toEqual([{ pdf: null, plainText: null, sha256: hex64('DOC') }]);
    expect((await q(`SELECT pdf IS NOT NULL AS kept FROM issued_documents WHERE id = $1`, [untouched]))[0].kept).toBe(true);
    expect(await q(`SELECT "targetTable", field, digest, "erasureCode", "instructionReference" FROM tombstones WHERE "targetId" = $1`, [ev]))
      .toEqual([{ targetTable: 'evidence', field: null, digest: null, erasureCode: 'ER-2', instructionReference: 'INSTR-2' }]);
    await expect(asOperator(`SELECT erase_evidence_bytes($1, $2, 'ER', 'I')`, [A.org, ev])).rejects.toThrow(/no bytes/);
  });

  it('FR-REV-08 NFR-INT-01: the operator may null one typed field and the bytes, and may not rewrite a value', async () => {
    const doc = await addDocumentPrinting(A, 'decision_versions', randomUUID(), 'reason',
      JSON.stringify([{ fieldId: 'DC-03', value: 'erase me', salt: 'aa' }, { fieldId: 'DC-04', value: 'keep', salt: 'ff' }]));
    await asOperatorIn(A.org, `UPDATE issued_documents SET "typedFields" = jsonb_set(jsonb_set("typedFields", '{0,value}', 'null'), '{0,salt}', 'null'), pdf = NULL, "plainText" = NULL WHERE id = '${doc}'`);
    await expect(asOperatorIn(A.org, `UPDATE issued_documents SET "typedFields" = jsonb_set("typedFields", '{1,value}', '"other"') WHERE id = '${doc}'`)).rejects.toThrow(/append-only/);
    await expect(asOperatorIn(A.org, `UPDATE issued_documents SET "typedFields" = jsonb_set("typedFields", '{0,value}', 'null') WHERE id = '${doc}'`)).rejects.toThrow(/append-only/);   // value without its salt
    await expect(asOperatorIn(A.org, `UPDATE issued_documents SET sha256 = '${'0'.repeat(64)}' WHERE id = '${doc}'`)).rejects.toThrow(/permission denied/);
    await expect(asOperator(`UPDATE issued_documents SET "plainText" = NULL WHERE id = '${doc}'`)).rejects.toThrow(/append-only/);
    // A fresh row with its text and salt in place (the case above erased the earlier ones).
    const fresh = (await addRecordRows(A)).decision_versions;
    await expect(asOperatorIn(A.org, `UPDATE decision_versions SET reason = 'rewritten' WHERE id = '${fresh}'`)).rejects.toThrow(/append-only/);
    await expect(asOperatorIn(A.org, `UPDATE decision_versions SET reason = NULL WHERE id = '${fresh}'`)).rejects.toThrow(/append-only/);   // text without its salt
    await expect(asOperatorIn(A.org, `UPDATE decision_versions SET reason = NULL, "reasonSalt" = NULL WHERE id = '${fresh}'`)).resolves.toBeUndefined();   // together: the exception
  });

  it('NFR-INT-01 (C4 DBSEC-1, SEC-3): on evidence and consent rows the operator may only null a text with its salt, and null an IP address', async () => {
    const ev = (await addRecordRows(A)).evidence;   // a v1 link row: filename, url and label with their salts
    const consent = randomUUID();
    await q(`INSERT INTO consent_records (id, "userId", "consentType", version, granted, "ipAddress") VALUES ($1, $2, 'terms_of_service', '1.0', true, '10.0.0.9')`, [consent, A.user]);
    for (const set of [`label = 'x'`, `url = NULL`, `"urlSalt" = NULL`, `filename = NULL`]) {
      await expect(asOperatorIn(A.org, `UPDATE evidence SET ${set} WHERE id = '${ev}'`), set).rejects.toThrow(/append-only/);
    }
    await expect(asOperatorIn(A.org, `UPDATE consent_records SET "ipAddress" = '1.1.1.1' WHERE id = '${consent}'`)).rejects.toThrow(/append-only/);
    await expect(asOperatorIn(A.org, `UPDATE evidence SET url = NULL, "urlSalt" = NULL WHERE id = '${ev}'`)).resolves.toBeUndefined();
    await expect(asOperatorIn(A.org, `UPDATE consent_records SET "ipAddress" = NULL WHERE id = '${consent}'`)).resolves.toBeUndefined();
    await q('SELECT makrai_clear_consent_ip_addresses()');   // asOperatorIn rolled back; leave no address for the next case
    // The three tables step 6 made append-only fire their refusal triggers always.
    expect(await q(`SELECT c.relname AS t, tg.tgname AS name, tg.tgenabled AS mode FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
      WHERE c.relname IN ('evidence', 'evidence_blobs', 'consent_records') AND tg.tgfoid = 'record_refuse_change'::regproc ORDER BY 1, 2`))
      .toEqual(['consent_records', 'evidence', 'evidence_blobs'].flatMap((t) =>
        [`${t}_refuse_row`, `${t}_refuse_truncate`].map((name) => ({ t, name, mode: 'A' }))));
  });

  it('NFR-SEC-12: makrai_clear_consent_ip_addresses clears ipAddress and no application role may run it', async () => {
    await q(`INSERT INTO consent_records (id, "userId", "consentType", version, granted, "ipAddress") VALUES (gen_random_uuid()::text, $1, 'terms_of_service', '1.0', true, '10.0.0.1')`, [A.user]);
    expect(await q(`SELECT makrai_clear_consent_ip_addresses() AS n`)).toEqual([{ n: 1 }]);
    expect(await q(`SELECT count(*)::int n FROM consent_records WHERE "ipAddress" IS NOT NULL`)).toEqual([{ n: 0 }]);
    expect(await q(`SELECT makrai_clear_consent_ip_addresses() AS n`)).toEqual([{ n: 0 }]);
    for (const role of ['makrai_app', 'makrai_identity']) await expect(callAs(role, 'makrai_clear_consent_ip_addresses()')).rejects.toThrow(/permission denied/);
  });

  it('FR-REV-08 NFR-INT-02: erasing a decision reason wipes the request digest of every row of that request in the organisation, and a retry answers 409 request_id_reused', async () => {
    const REQ = randomUUID();
    const path = { slug: 'op-a', projectId: A.project };
    const D = requestDigest({ path, body: { questionId: 'Q-DIG', status: 'partly', reason: 'ZZMARK-secret-reason-QX' } });
    const dv = randomUUID();
    const ev = randomUUID();
    const dvB = randomUUID();
    await q(`INSERT INTO decision_versions (id, "orgId", "projectId", stage, "questionId", "contentVersionId", "versionNumber", status, reason, "enteredById", "enteredByRole", "requestId", "requestDigest")
      VALUES ($1, $2, $3, 'pre-processing', 'Q-DIG', $4, 1, 'partly', 'ZZMARK-secret-reason-QX', $5, 'owner', $6, $7)`, [dv, A.org, A.project, FV, A.user, REQ, D]);
    // A second row of the same request, under a derived request id (9.5 rule 5): the same digest.
    await q(`INSERT INTO evidence (id, "orgId", "projectId", kind, url, "uploadedById", "requestId", "requestDigest")
      VALUES ($1, $2, $3, 'link', 'https://x.test/dig', $4, $5, $6)`, [ev, A.org, A.project, A.user, derivedRequestId(REQ, 'evidence:0'), D]);
    await q(`INSERT INTO request_receipts (id, "orgId", "requestId", "requestDigest", "actorUserId", route, "rowId") VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'decisions.save', $5)`,
      [A.org, derivedRequestId(REQ, 'receipt'), D, A.user, dv]);
    // The same digest in another organisation is not this erasure's concern.
    await q(`INSERT INTO decision_versions (id, "orgId", "projectId", stage, "questionId", "contentVersionId", "versionNumber", status, reason, "enteredById", "enteredByRole", "requestId", "requestDigest")
      VALUES ($1, $2, $3, 'pre-processing', 'Q-DIG', $4, 1, 'partly', 'ZZMARK-reason-B-QX', $5, 'owner', $6, $7)`, [dvB, B.org, B.project, FV, B.user, REQ, D]);

    await asOperator(`SELECT erase_text_field($1, 'decision_versions', $2, 'reason', 'ER-D', 'INSTR-D')`, [A.org, dv]);

    const left = await q(`SELECT 'decision_versions' t, "orgId" FROM decision_versions WHERE "requestDigest" = $1
      UNION ALL SELECT 'evidence', "orgId" FROM evidence WHERE "requestDigest" = $1
      UNION ALL SELECT 'request_receipts', "orgId" FROM request_receipts WHERE "requestDigest" = $1`, [D]);
    expect(left).toEqual([{ t: 'decision_versions', orgId: B.org }]);
    expect(await q(`SELECT "requestDigest" FROM decision_versions WHERE id = $1 UNION ALL SELECT "requestDigest" FROM evidence WHERE id = $2`, [dv, ev]))
      .toEqual([{ requestDigest: 'erased' }, { requestDigest: 'erased' }]);

    const retry = await idempotentWrite({ orgId: A.org, role: 'owner' } as OrgContext, {
      table: 'decision_versions', requestId: REQ, digest: D, actorUserId: A.user,
      write: async () => { throw new Error('the write must not run'); },
      replay: async (_tx, rowId) => rowId,
    }).catch((e: unknown) => e);
    expect(retry).toMatchObject({ status: 409, code: 'request_id_reused' });
  });

  it("NFR-INT-01 NFR-SEC-12: the operator may change requestDigest only to 'erased', and makrai_app cannot change it at all", async () => {
    const fresh = (await addRecordRows(A)).decision_versions;
    await expect(asOperatorIn(A.org, `UPDATE decision_versions SET "requestDigest" = 'x' WHERE id = '${fresh}'`)).rejects.toThrow(/append-only/);
    await expect(asOperatorIn(A.org, `UPDATE decision_versions SET "requestDigest" = NULL WHERE id = '${fresh}'`)).rejects.toThrow(/append-only|null value/);
    await expect(asOperatorIn(A.org, `UPDATE decision_versions SET "requestDigest" = 'erased' WHERE id = '${fresh}'`)).resolves.toBeUndefined();
    // On a table with no erasable text, the digest is the only change the operator may make.
    await expect(asOperatorIn(A.org, `UPDATE seals SET "requestDigest" = 'erased' WHERE id = '${A.seal}'`)).resolves.toBeUndefined();
    await expect(asOperatorIn(A.org, `UPDATE seals SET "requestDigest" = 'x' WHERE id = '${A.seal}'`)).rejects.toThrow(/append-only/);
    // The owner role is refused as before.
    await expect(asOperator(`UPDATE decision_versions SET "requestDigest" = 'erased' WHERE id = '${fresh}'`)).rejects.toThrow(/append-only/);
    const app = new Client({ connectionString: process.env.APP_DATABASE_URL, options: '' });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.current_org_id', $1, true)`, [A.org]);
      await expect(app.query(`UPDATE decision_versions SET "requestDigest" = 'erased' WHERE id = $1`, [fresh])).rejects.toThrow(/permission denied|append-only/);
    } finally {
      await app.query('ROLLBACK').catch(() => undefined);
      await app.end();
    }
  });

  it('FR-REV-08: erasure refuses a target of another organisation, an unknown field and an absent row', async () => {
    const ofB = await addRecordRows(B);
    await expect(asOperator(`SELECT erase_text_field($1, 'decision_versions', $2, 'reason', 'ER', 'I')`, [A.org, ofB.decision_versions])).rejects.toThrow(/exactly one/);
    expect((await q(`SELECT reason FROM decision_versions WHERE id = $1`, [ofB.decision_versions]))[0].reason).toMatch(/ZZMARK/);
    await expect(asOperator(`SELECT erase_evidence_bytes($1, $2, 'ER', 'I')`, [A.org, ofB.evidence])).rejects.toThrow(/exactly one/);
    await expect(asOperator(`SELECT erase_text_field($1, 'decision_versions', $2, 'questionId', 'ER', 'I')`, [B.org, ofB.decision_versions])).rejects.toThrow(/not an erasable field/);
    await expect(asOperator(`SELECT erase_text_field($1, 'users', $2, 'name', 'ER', 'I')`, [B.org, B.user])).rejects.toThrow(/not an erasable field/);
    await expect(asOperator(`SELECT erase_text_field($1, 'decision_versions', $2, 'reason', 'ER', 'I')`, [B.org, randomUUID()])).rejects.toThrow(/exactly one/);
    await expect(asOperator(`SELECT erase_text_field($1, 'decision_versions', $2, 'reason', '', 'I')`, [B.org, ofB.decision_versions])).rejects.toThrow(/erasure code/);
  });
});
