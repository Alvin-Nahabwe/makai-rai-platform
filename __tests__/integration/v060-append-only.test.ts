import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { APPEND_ONLY_TABLES } from '../../lib/data/appendOnly';
import { resetDb } from '../helpers/db';

/**
 * NFR-INT-01 (SRS lines 3073-3077): UPDATE, DELETE and TRUNCATE are refused on every
 * append-only table for makrai_app, makrai_identity and the owner role makrai, also under
 * session_replication_role = replica, except inside the operator procedures. The tables
 * come from one registry in the schema code (`APPEND_ONLY_TABLES`), which is diffed both
 * against the contract's list (the second root) and against the triggers pg_trigger lists.
 */

/** 00-contract.md, Data model, "APPEND_ONLY_TABLES" (owner answer A1 adds request_receipts). */
const CONTRACT_APPEND_ONLY = [
  'organization_agreements', 'platform_events', 'organisation_events', 'decision_versions', 'decision_evidence',
  'mitigation_evidence', 'findings', 'finding_events', 'mitigation_versions', 'accepted_risks', 'stage_reviews', 'seals',
  'issued_documents', 'issued_document_seals', 'issued_document_sources', 'document_events', 'reminder_log', 'tombstones',
  'request_receipts', 'evidence', 'evidence_blobs', 'consent_records', 'integrity_log',
];

let su: Client;

/**
 * One row in every append-only table, as the owner role, so each UPDATE and DELETE below
 * reaches a row and its row trigger: SRS 5.3 item 1 refuses UPDATE and DELETE by row
 * triggers and TRUNCATE by a statement trigger, so a statement that changes no row is not
 * a refusal case. integrity_log is written only by integrity_append().
 */
const SEED = `
  INSERT INTO users (id, email, name, "passwordHash", "updatedAt") VALUES ('ao_u', 'ao-seed@fixture.test', 'u', 'x', now());
  INSERT INTO organizations (id, name, slug, "updatedAt") VALUES ('ao_o', 'ao seed', 'ao-seed', now());
  INSERT INTO projects (id, "orgId", name, "createdById", "updatedAt") VALUES ('ao_p', 'ao_o', 'p', 'ao_u', now());
  INSERT INTO framework_versions (id, semver, "contentHash", "publishedAt", status) VALUES ('fv_k0a_ao', '0.0.0-k0a-ao', repeat('a', 64), now(), 'deprecated') ON CONFLICT (id) DO NOTHING;
  INSERT INTO consent_records (id, "userId", "consentType", version, granted) VALUES ('ao_c', 'ao_u', 'terms_of_service', '1', true);
  INSERT INTO platform_events (id, "actorId", action, "targetUserId") VALUES ('ao_pe', 'ao_u', 'account_deactivated', 'ao_u');
  INSERT INTO organization_agreements (id, "orgId", "agreementVersion", "textHash", "acceptedOn", "controllerLegalName", "dpContactEmail", "recordedById")
    VALUES ('ao_oa', 'ao_o', '1', repeat('b', 64), '2026-10-30', 'C', 'dpo@fixture.test', 'ao_u');
  INSERT INTO organisation_events (id, "orgId", "actorId", "actorRole", action) VALUES ('ao_oe', 'ao_o', 'ao_u', 'platform_admin', 'organisation_created');
  INSERT INTO evidence (id, "orgId", "projectId", kind, filename, sha256, "uploadedById", "requestId", "requestDigest") VALUES ('ao_e', 'ao_o', 'ao_p', 'file', 'f', repeat('c', 64), 'ao_u', gen_random_uuid(), 'd');
  INSERT INTO evidence_blobs ("evidenceId", "orgId", content) VALUES ('ao_e', 'ao_o', '\\x01');
  INSERT INTO decision_versions (id, "orgId", "projectId", stage, "questionId", "contentVersionId", "versionNumber", status, "enteredById", "enteredByRole", "requestId", "requestDigest")
    VALUES ('ao_d', 'ao_o', 'ao_p', 'pre-processing', 'Q-PP-01', 'fv_k0a_ao', 1, 'partly', 'ao_u', 'owner', gen_random_uuid(), 'd');
  INSERT INTO decision_evidence ("orgId", "versionId", "evidenceId") VALUES ('ao_o', 'ao_d', 'ao_e');
  INSERT INTO findings (id, "orgId", "projectId", stage, source, "raisedById", "requestId", "requestDigest") VALUES ('ao_f', 'ao_o', 'ao_p', 'pre-processing', 'team', 'ao_u', gen_random_uuid(), 'd');
  INSERT INTO finding_events (id, "orgId", "findingId", kind, "byId", "requestId", "requestDigest") VALUES ('ao_fe', 'ao_o', 'ao_f', 'reopened', 'ao_u', gen_random_uuid(), 'd');
  INSERT INTO mitigation_versions (id, "orgId", "findingId", "mitigationId", "versionNumber", "ownerUserId", "dueDate", status, kind, "enteredById", "enteredByRole", "requestId", "requestDigest")
    VALUES ('ao_m', 'ao_o', 'ao_f', 'ao_mid', 1, 'ao_u', '2026-11-10', 'planned', 'action', 'ao_u', 'owner', gen_random_uuid(), 'd');
  INSERT INTO mitigation_evidence ("orgId", "versionId", "evidenceId") VALUES ('ao_o', 'ao_m', 'ao_e');
  INSERT INTO accepted_risks (id, "orgId", "findingId", "enteredById", "enteredByRole", "requestId", "requestDigest") VALUES ('ao_ar', 'ao_o', 'ao_f', 'ao_u', 'owner', gen_random_uuid(), 'd');
  INSERT INTO stage_reviews (id, "orgId", "projectId", stage, "numberInStage", "openedById", "requestId", "requestDigest") VALUES ('ao_sr', 'ao_o', 'ao_p', 'pre-processing', 1, 'ao_u', gen_random_uuid(), 'd');
  INSERT INTO seals (id, "orgId", "stageReviewId", "sealNumber", format, "contentVersionId", manifest, fingerprint, "sealedById", "sealedByRole", "requestId", "requestDigest")
    VALUES ('ao_s', 'ao_o', 'ao_sr', 1, 'makrai.seal/1', 'fv_k0a_ao', '\\x7b7d', repeat('d', 64), 'ao_u', 'owner', gen_random_uuid(), 'd');
  INSERT INTO issued_documents (id, "orgId", "projectId", "stageReviewId", "sealId", "documentType", "templateVersion", pdf, "plainText", sha256, "byteSize", "issuedById", "issuedAt", "requestId", "requestDigest")
    VALUES ('ao_doc', 'ao_o', 'ao_p', 'ao_sr', 'ao_s', 'data_card', '1', '\\x01', 't', repeat('e', 64), 1, 'ao_u', date_trunc('second', clock_timestamp()), gen_random_uuid(), 'd');
  INSERT INTO issued_document_seals ("orgId", "documentId", "sealId") VALUES ('ao_o', 'ao_doc', 'ao_s');
  INSERT INTO issued_document_sources (id, "orgId", "documentId", "sourceTable", "sourceId", field) VALUES ('ao_ds', 'ao_o', 'ao_doc', 'evidence', 'ao_e', NULL);
  INSERT INTO document_events (id, "orgId", "documentId", kind, reason, "byId", "requestId", "requestDigest") VALUES ('ao_de', 'ao_o', 'ao_doc', 'withdrawn', 'r', 'ao_u', gen_random_uuid(), 'd');
  INSERT INTO reminder_log (id, "orgId", "mitigationId", "dueDate", kind, attempt, outcome) VALUES ('ao_rl', 'ao_o', 'ao_mid', '2026-11-10', 'due', 1, 'claimed');
  INSERT INTO tombstones (id, "orgId", "targetTable", "targetId", "erasureCode", "instructionReference") VALUES ('ao_t', 'ao_o', 'evidence', 'ao_e', 'ER', 'I');
  INSERT INTO request_receipts (id, "orgId", "requestId", "requestDigest", "actorUserId", route) VALUES ('ao_rr', 'ao_o', gen_random_uuid(), 'd', 'ao_u', 'r');
`;

beforeAll(async () => {
  await resetDb();
  su = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
  await su.connect();
  await su.query(SEED);
});
afterAll(async () => {
  // framework_versions survives resetDb (reference data): remove this file's row, after the rows that reference it.
  await resetDb();
  await su.query(`DELETE FROM framework_versions WHERE id = 'fv_k0a_ao'`);
  await su.end();
});

const q = async (sql: string, params: unknown[] = []) => (await su.query(sql, params)).rows;

// pg_trigger.tgtype bits (src/include/catalog/pg_trigger.h).
const ROW = 1, BEFORE = 2, DELETE = 8, UPDATE = 16, TRUNCATE = 32;

/** Tables with a non-internal trigger on the step-1 refusal function or integrity_log's own. */
async function refusalTriggerTables(): Promise<string[]> {
  return (await q(`SELECT DISTINCT c.relname AS t FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
      AND p.proname IN ('record_refuse_change', 'integrity_log_refuse_change') ORDER BY 1`)).map((r) => r.t);
}

/** Runs one statement as `role` (the superuser session switches to it), optionally in replica mode, always rolled back. */
async function runAs(role: string, table: string, stmt: 'UPDATE' | 'DELETE' | 'TRUNCATE', opts: { replica?: boolean } = {}) {
  const [{ col }] = await q(`SELECT quote_ident(attname) AS col FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum LIMIT 1`, [table]);
  const sql = stmt === 'UPDATE' ? `UPDATE "${table}" SET ${col} = ${col}` : stmt === 'DELETE' ? `DELETE FROM "${table}"` : `TRUNCATE "${table}" CASCADE`;
  await su.query('BEGIN');
  try {
    if (opts.replica) await su.query(`SET LOCAL session_replication_role = replica`);
    if (role !== 'makrai') await su.query(`SET LOCAL ROLE ${role}`);
    await su.query(sql);
  } finally {
    await su.query('ROLLBACK');
  }
}

describe('append-only tables (NFR-INT-01)', () => {
  it('NFR-INT-01: APPEND_ONLY_TABLES is the contract list and equals the tables whose refusal triggers pg_trigger lists', async () => {
    expect([...APPEND_ONLY_TABLES].sort()).toEqual([...CONTRACT_APPEND_ONLY].sort());   // second root: the contract's list
    expect(await refusalTriggerTables()).toEqual([...APPEND_ONLY_TABLES].sort());
  });

  it('NFR-INT-01: each table has an always-firing row trigger on UPDATE and DELETE and a statement trigger on TRUNCATE (SRS 5.3 item 1)', async () => {
    const rows = await q(`SELECT c.relname AS t, t.tgtype::int AS type, t.tgenabled AS mode FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND p.proname = 'record_refuse_change'`);
    for (const t of APPEND_ONLY_TABLES.filter((x) => x !== 'integrity_log')) {
      const mine = rows.filter((r) => r.t === t);
      expect({ t, modes: [...new Set(mine.map((r) => r.mode))] }).toEqual({ t, modes: ['A'] });
      expect({ t, shapes: mine.map((r) => r.type & (ROW | BEFORE | UPDATE | DELETE | TRUNCATE)).sort((a, b) => a - b) })
        .toEqual({ t, shapes: [BEFORE | TRUNCATE, ROW | BEFORE | DELETE | UPDATE].sort((a, b) => a - b) });
    }
    expect(await q(`SELECT tgenabled AS mode FROM pg_trigger WHERE tgname = 'integrity_log_append_only'`)).toEqual([{ mode: 'A' }]);
  });

  it('NFR-INT-01: UPDATE, DELETE, TRUNCATE refused for three roles and in replica mode', async () => {
    // Not vacuous: every table holds a row (integrity_log's trigger is statement-level).
    for (const t of APPEND_ONLY_TABLES.filter((x) => x !== 'integrity_log'))
      expect({ t, rows: (await q(`SELECT count(*)::int AS n FROM "${t}"`))[0].n > 0 }).toEqual({ t, rows: true });
    for (const t of APPEND_ONLY_TABLES) for (const role of ['makrai_app', 'makrai_identity', 'makrai'])
      for (const stmt of ['UPDATE', 'DELETE', 'TRUNCATE'] as const) for (const replica of [false, true]) {
        // The owner holds every privilege, so only the trigger can refuse it, and the refusal
        // must name this table: TRUNCATE ... CASCADE fires the named table's trigger first, so a
        // dependent table's trigger cannot stand in for a missing one.
        const expected = role === 'makrai' ? new RegExp(`^${t} is append-only: ${stmt} refused`) : /append-only|permission denied/;
        await expect(runAs(role, t, stmt, { replica }), `${role} ${stmt} ${t}${replica ? ' (replica)' : ''}`).rejects.toThrow(expected);
      }
  });

  it('NFR-INT-01: deleting a project with a decision version is refused for makrai', async () => {
    const user = randomUUID(); const org = randomUUID(); const project = randomUUID();
    await q(`INSERT INTO users (id, email, name, "passwordHash", "updatedAt") VALUES ($1, $2, 'u', 'x', now())`, [user, `ao-${user}@fixture.test`]);
    await q(`INSERT INTO organizations (id, name, slug, "updatedAt") VALUES ($1, 'ao', $2, now())`, [org, `ao-${org.slice(0, 8)}`]);
    await q(`INSERT INTO projects (id, "orgId", name, "createdById", "updatedAt") VALUES ($1, $2, 'p', $3, now())`, [project, org, user]);
    await q(`INSERT INTO framework_versions (id, semver, "contentHash", "publishedAt", status) VALUES ('fv_k0a_ao', '0.0.0-k0a-ao', $1, now(), 'deprecated') ON CONFLICT (id) DO NOTHING`, ['a'.repeat(64)]);
    await q(`INSERT INTO decision_versions (id, "orgId", "projectId", stage, "questionId", "contentVersionId", "versionNumber", status, "enteredById", "enteredByRole", "requestId", "requestDigest")
      VALUES (gen_random_uuid()::text, $1, $2, 'pre-processing', 'Q-PP-01', 'fv_k0a_ao', 1, 'done', $3, 'owner', gen_random_uuid(), 'd')`, [org, project, user]);
    await expect(q(`DELETE FROM projects WHERE id = $1`, [project])).rejects.toThrow(/decision_versions_orgId_projectId_fkey/);
    // Deleting the organisation cascades to the project and is refused the same way.
    await expect(q(`DELETE FROM organizations WHERE id = $1`, [org])).rejects.toThrow(/violates foreign key constraint/);
  });

  it('NFR-INT-01: a cascade that removes no append-only row passes, and one that would remove an evidence row is refused', async () => {
    const org = randomUUID(); const user = randomUUID();
    await q(`INSERT INTO users (id, email, name, "passwordHash", "updatedAt") VALUES ($1, $2, 'u', 'x', now())`, [user, `ao2-${user}@fixture.test`]);
    await q(`INSERT INTO organizations (id, name, slug, "updatedAt") VALUES ($1, 'ao2', $2, now())`, [org, `ao2-${org.slice(0, 8)}`]);
    const project = async (withEvidence: boolean) => {
      const p = randomUUID(); const a = randomUUID();
      await q(`INSERT INTO projects (id, "orgId", name, "createdById", "updatedAt") VALUES ($1, $2, 'p', $3, now())`, [p, org, user]);
      await q(`INSERT INTO assessments (id, "orgId", "projectId", "userId", "frameworkVersionId", "engineState") VALUES ($1, $2, $3, $4, 'fv_k0a_ao', '{}')`, [a, org, p, user]);
      if (withEvidence) {
        await q(`INSERT INTO evidence (id, "orgId", "assessmentId", "frameworkVersionId", "questionId", filename, "mimeType", "byteSize", sha256)
          VALUES (gen_random_uuid()::text, $1, $2, 'fv_k0a_ao', 'Q-PP-01', 'f', 'application/pdf', 1, repeat('f', 64))`, [org, a]);
      }
      return p;
    };
    const plain = await project(false);
    await expect(q(`DELETE FROM projects WHERE id = $1`, [plain])).resolves.toBeDefined();   // its assessment goes by cascade
    const withRecord = await project(true);
    await expect(q(`DELETE FROM projects WHERE id = $1`, [withRecord])).rejects.toThrow(/evidence is append-only: DELETE refused/);
  });
});
