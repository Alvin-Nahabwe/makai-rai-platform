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
beforeAll(async () => {
  await resetDb();
  su = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
  await su.connect();
});
afterAll(async () => { await su.end(); });

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

  it('NFR-INT-01: each refusal trigger fires always, before the statement and each row, on UPDATE, DELETE and TRUNCATE', async () => {
    const rows = await q(`SELECT c.relname AS t, t.tgtype::int AS type, t.tgenabled AS mode FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND p.proname = 'record_refuse_change'`);
    for (const t of APPEND_ONLY_TABLES.filter((x) => x !== 'integrity_log')) {
      const mine = rows.filter((r) => r.t === t);
      expect({ t, modes: [...new Set(mine.map((r) => r.mode))] }).toEqual({ t, modes: ['A'] });
      const stmt = mine.find((r) => (r.type & ROW) === 0);
      const row = mine.find((r) => (r.type & ROW) !== 0);
      expect({ t, stmt: stmt && (stmt.type & (BEFORE | UPDATE | DELETE | TRUNCATE)) }).toEqual({ t, stmt: BEFORE | UPDATE | DELETE | TRUNCATE });
      expect({ t, row: row && (row.type & (BEFORE | UPDATE | DELETE)) }).toEqual({ t, row: BEFORE | UPDATE | DELETE });
    }
    expect(await q(`SELECT tgenabled AS mode FROM pg_trigger WHERE tgname = 'integrity_log_append_only'`)).toEqual([{ mode: 'A' }]);
  });

  it('NFR-INT-01: UPDATE, DELETE, TRUNCATE refused for three roles and in replica mode', async () => {
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
});
