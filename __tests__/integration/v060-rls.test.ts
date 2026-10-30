import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { OrgContext } from '../../lib/data/tenant';
import { withOrg } from '../../lib/data/tenant';
import { resetDb } from '../helpers/db';

/**
 * NFR-SEC-01 (SRS lines 2901-2905), 9.5 rules 1, 5 and 6 (lines 3632-3637): every table
 * with an organisation id has forced row-level security and the org_isolation policy on
 * the pinned predicate; a session in organisation A reads none of organisation B's rows
 * and cannot insert a row carrying B's id; makrai_app holds exactly the contract's grants
 * (00-contract.md, Data model, "Grants"); and the constraints 5.3 and 9.5 fix.
 *
 * Rows are written as the owner role (a superuser, so RLS does not apply and the triggers
 * do) by the per-table builders below. The tenant tables are enumerated from pg_catalog;
 * a new table with "orgId" and no builder fails the isolation test, so it cannot be
 * skipped by omission.
 */

const SALT_SQL = 'substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4)';
const FV = 'fv_k0a_rls';
const hex64 = (seed: string) => createHash('sha256').update(seed).digest('hex');

/** SRS 5.1 (lines 1198-1227) and 9.5 (lines 3643-3661), plus request_receipts (owner answer A1, contract New models). Written by hand: the second root. */
const TENANT_TABLES_FROM_SRS_51 = [
  'projects', 'project_metadata', 'assessments', 'remediation_items', 'memberships', 'invitations', 'evidence', 'evidence_blobs',
  'organization_agreements', 'organisation_events', 'decision_versions', 'decision_evidence', 'mitigation_evidence', 'findings',
  'finding_events', 'mitigation_versions', 'accepted_risks', 'stage_reviews', 'seals', 'issued_documents', 'issued_document_seals',
  'issued_document_sources', 'document_events', 'document_draft_fields', 'reminder_log', 'tombstones', 'request_receipts',
];

/** The new tables of v0.6.0 and makrai_app's grants on each (00-contract.md, Data model, "Grants"). */
const CONTRACT_APP_GRANTS: Record<string, string[]> = {
  decision_versions: ['INSERT', 'SELECT'], decision_evidence: ['INSERT', 'SELECT'], mitigation_evidence: ['INSERT', 'SELECT'],
  findings: ['INSERT', 'SELECT'], finding_events: ['INSERT', 'SELECT'], mitigation_versions: ['INSERT', 'SELECT'],
  accepted_risks: ['INSERT', 'SELECT'], stage_reviews: ['INSERT', 'SELECT'], seals: ['INSERT', 'SELECT'],
  issued_documents: ['INSERT', 'SELECT'], issued_document_seals: ['INSERT', 'SELECT'], issued_document_sources: ['INSERT', 'SELECT'],
  document_events: ['INSERT', 'SELECT'], organisation_events: ['INSERT', 'SELECT'],
  reminder_log: ['INSERT', 'SELECT'], document_draft_fields: ['INSERT', 'SELECT', 'UPDATE'], request_receipts: ['INSERT', 'SELECT'],
  tombstones: ['SELECT'], organization_agreements: ['SELECT'],
  password_reset_tokens: [], known_devices: [], platform_events: [],
};
const NEW_TABLES = Object.keys(CONTRACT_APP_GRANTS);

type Ids = {
  org: string; user: string; project: string; assessment: string; remediation: string; evidence: string;
  decision: string; finding: string; mitigationVersion: string; stageReview: string; seal: string; document: string;
};
type Builder = (ids: Ids, orgId: string) => [string, unknown[]];

const req = () => [randomUUID(), hex64(randomUUID())];

/** One valid row per tenant table, for organisation `orgId`, pointing at the parents in `ids`. */
const BUILDERS: Record<string, Builder> = {
  projects: (i, o) => [`INSERT INTO projects (id, "orgId", name, "createdById", "updatedAt") VALUES ($1, $2, 'p', $3, now())`, [randomUUID(), o, i.user]],
  project_metadata: (i, o) => [`INSERT INTO project_metadata (id, "orgId", "projectId", "updatedAt") VALUES ($1, $2, $3, now())`, [randomUUID(), o, i.project]],
  assessments: (i, o) => [`INSERT INTO assessments (id, "orgId", "projectId", "userId", "frameworkVersionId", "engineState") VALUES ($1, $2, $3, $4, $5, '{}')`,
    [randomUUID(), o, i.project, i.user, FV]],
  remediation_items: (i, o) => [`INSERT INTO remediation_items (id, "orgId", "assessmentId", "areaId", "areaName", tier, description) VALUES ($1, $2, $3, 'PO-01', 'a', 'gap', 'd')`,
    [randomUUID(), o, i.assessment]],
  memberships: (i, o) => [`INSERT INTO memberships (id, "orgId", "userId", role) VALUES ($1, $2, $3, 'viewer')`, [randomUUID(), o, i.user]],
  invitations: (i, o) => [`INSERT INTO invitations (id, "orgId", email, role, "tokenHash", "invitedById", "expiresAt") VALUES ($1, $2, 'x@fixture.test', 'viewer', $3, $4, now() + interval '1 day')`,
    [randomUUID(), o, hex64(randomUUID()), i.user]],
  evidence: (i, o) => [`INSERT INTO evidence (id, "orgId", "projectId", kind, filename, "mimeType", "byteSize", sha256, "uploadedById", "requestId", "requestDigest")
    VALUES ($1, $2, $3, 'file', 'f.pdf', 'application/pdf', 3, $4, $5, $6, $7)`, [randomUUID(), o, i.project, hex64(randomUUID()), i.user, ...req()]],
  evidence_blobs: (i, o) => [`INSERT INTO evidence_blobs ("evidenceId", "orgId", content) VALUES ($1, $2, '\\x010203')`, [i.evidence, o]],
  organization_agreements: (i, o) => [`INSERT INTO organization_agreements (id, "orgId", "agreementVersion", "textHash", "acceptedOn", "controllerLegalName", "dpContactEmail", "recordedById")
    VALUES ($1, $2, '1', $3, '2026-10-30', 'C', 'dpo@fixture.test', $4)`, [randomUUID(), o, hex64('a'), i.user]],
  organisation_events: (i, o) => [`INSERT INTO organisation_events (id, "orgId", "actorId", "actorRole", action) VALUES ($1, $2, $3, 'owner', 'member_invited')`,
    [randomUUID(), o, i.user]],
  decision_versions: (i, o) => [`INSERT INTO decision_versions (id, "orgId", "projectId", stage, "questionId", "contentVersionId", "versionNumber", status, reason, "enteredById", "enteredByRole", "requestId", "requestDigest")
    VALUES ($1, $2, $3, 'pre-processing', $4, $5, 1, 'done', 'r', $6, 'owner', $7, $8)`, [randomUUID(), o, i.project, `Q-${randomUUID().slice(0, 6)}`, FV, i.user, ...req()]],
  decision_evidence: (i, o) => [`INSERT INTO decision_evidence ("orgId", "versionId", "evidenceId") VALUES ($1, $2, $3)`, [o, i.decision, i.evidence]],
  findings: (i, o) => [`INSERT INTO findings (id, "orgId", "projectId", stage, source, title, "raisedById", "requestId", "requestDigest")
    VALUES ($1, $2, $3, 'pre-processing', 'team', 't', $4, $5, $6)`, [randomUUID(), o, i.project, i.user, ...req()]],
  finding_events: (i, o) => [`INSERT INTO finding_events (id, "orgId", "findingId", kind, reason, "byId", "requestId", "requestDigest")
    VALUES ($1, $2, $3, 'reopened', 'r', $4, $5, $6)`, [randomUUID(), o, i.finding, i.user, ...req()]],
  mitigation_versions: (i, o) => [`INSERT INTO mitigation_versions (id, "orgId", "findingId", "mitigationId", "versionNumber", what, "ownerUserId", "dueDate", status, kind, "enteredById", "enteredByRole", "requestId", "requestDigest")
    VALUES ($1, $2, $3, $4, 1, 'w', $5, '2026-11-10', 'planned', 'action', $5, 'owner', $6, $7)`, [randomUUID(), o, i.finding, randomUUID(), i.user, ...req()]],
  mitigation_evidence: (i, o) => [`INSERT INTO mitigation_evidence ("orgId", "versionId", "evidenceId") VALUES ($1, $2, $3)`, [o, i.mitigationVersion, i.evidence]],
  accepted_risks: (i, o) => [`INSERT INTO accepted_risks (id, "orgId", "findingId", reason, "enteredById", "enteredByRole", "requestId", "requestDigest")
    VALUES ($1, $2, $3, 'r', $4, 'owner', $5, $6)`, [randomUUID(), o, i.finding, i.user, ...req()]],
  stage_reviews: (i, o) => [`INSERT INTO stage_reviews (id, "orgId", "projectId", stage, "numberInStage", "openedById", "requestId", "requestDigest")
    VALUES ($1, $2, $3, 'pre-processing', (SELECT coalesce(max("numberInStage"), 0) + 1 FROM stage_reviews WHERE "orgId" = $2 AND "projectId" = $3), $4, $5, $6)`,
    [randomUUID(), o, i.project, i.user, ...req()]],
  seals: (i, o) => [`INSERT INTO seals (id, "orgId", "stageReviewId", "sealNumber", format, "contentVersionId", manifest, fingerprint, "sealedById", "sealedByRole", "requestId", "requestDigest")
    VALUES ($1, $2, $3, (SELECT coalesce(max("sealNumber"), 0) + 1 FROM seals WHERE "orgId" = $2 AND "stageReviewId" = $3), 'makrai.seal/1', $4, '\\x7b7d', $5, $6, 'owner', $7, $8)`,
    [randomUUID(), o, i.stageReview, FV, hex64('{}'), i.user, ...req()]],
  issued_documents: (i, o) => [`INSERT INTO issued_documents (id, "orgId", "projectId", "stageReviewId", "sealId", "documentType", "templateVersion", "typedFields", pdf, "plainText", sha256, "byteSize", "issuedById", "issuedAt", "requestId", "requestDigest")
    VALUES ($1, $2, $3, $4, $5, 'data_card', '1', '[]', '\\x25504446', 'text', $6, 4, $7, date_trunc('second', clock_timestamp()), $8, $9)`,
    [randomUUID(), o, i.project, i.stageReview, i.seal, hex64('%PDF'), i.user, ...req()]],
  issued_document_seals: (i, o) => [`INSERT INTO issued_document_seals ("orgId", "documentId", "sealId") VALUES ($1, $2, $3)`, [o, i.document, i.seal]],
  issued_document_sources: (i, o) => [`INSERT INTO issued_document_sources (id, "orgId", "documentId", "sourceTable", "sourceId", field) VALUES ($1, $2, $3, 'decision_versions', $4, 'reason')`,
    [randomUUID(), o, i.document, i.decision]],
  document_events: (i, o) => [`INSERT INTO document_events (id, "orgId", "documentId", kind, reason, "byId", "requestId", "requestDigest") VALUES ($1, $2, $3, 'withdrawn', 'r', $4, $5, $6)`,
    [randomUUID(), o, i.document, i.user, ...req()]],
  document_draft_fields: (i, o) => [`INSERT INTO document_draft_fields (id, "orgId", "projectId", "documentType", "fieldValues", "updatedById", "updatedAt") VALUES ($1, $2, $3, $4, '{}', $5, now())`,
    [randomUUID(), o, i.project, ['data_card', 'model_card', 'mitigation_plan'][Math.floor(Math.random() * 3)], i.user]],
  reminder_log: (i, o) => [`INSERT INTO reminder_log (id, "orgId", "mitigationId", "dueDate", kind, attempt, outcome) VALUES ($1, $2, $3, '2026-11-10', 'due', 1, 'claimed')`,
    [randomUUID(), o, randomUUID()]],
  tombstones: (i, o) => [`INSERT INTO tombstones (id, "orgId", "targetTable", "targetId", field, digest, "erasureCode", "instructionReference") VALUES ($1, $2, 'decision_versions', $3, 'reason', $4, 'ER', 'I')`,
    [randomUUID(), o, i.decision, hex64('d')]],
  request_receipts: (i, o) => [`INSERT INTO request_receipts (id, "orgId", "requestId", "requestDigest", "actorUserId", route) VALUES ($1, $2, $3, $4, $5, 'app/api/v1/orgs/[slug]/projects/route.ts::POST')`,
    [randomUUID(), o, randomUUID(), hex64('r'), i.user]],
};

let owner: Client;
let app: Client;
let A: Ids;
let B: Ids;

async function one(c: Client, sql: string, params: unknown[] = []) { return (await c.query(sql, params)).rows; }

async function buildOrg(label: string): Promise<Ids> {
  const ids = { org: randomUUID(), user: randomUUID() } as Ids;
  await owner.query(`INSERT INTO users (id, email, name, "passwordHash", "updatedAt") VALUES ($1, $2, 'u', 'x', now())`, [ids.user, `rls-${label}-${randomUUID()}@fixture.test`]);
  await owner.query(`INSERT INTO organizations (id, name, slug, "updatedAt") VALUES ($1, $2, $3, now())`, [ids.org, `RLS ${label}`, `rls-${label}-${randomUUID().slice(0, 8)}`]);
  const insert = async (t: string, key?: keyof Ids) => {
    const [sql, params] = BUILDERS[t](ids, ids.org);
    await owner.query(sql, params);
    if (key) ids[key] = params[0] as string;
  };
  // Dependency order, as 9.5 step 3 (line 3687).
  await insert('projects', 'project');
  await insert('project_metadata');
  await insert('assessments', 'assessment');
  await insert('remediation_items', 'remediation');
  await insert('memberships');
  await insert('invitations');
  await insert('evidence', 'evidence');
  await insert('evidence_blobs');
  await insert('organization_agreements');
  await insert('organisation_events');
  await insert('decision_versions', 'decision');
  await insert('decision_evidence');
  await insert('findings', 'finding');
  await insert('finding_events');
  await insert('mitigation_versions', 'mitigationVersion');
  await insert('mitigation_evidence');
  await insert('accepted_risks');
  await insert('stage_reviews', 'stageReview');
  await insert('seals', 'seal');
  await insert('issued_documents', 'document');
  await insert('issued_document_seals');
  await insert('issued_document_sources');
  await insert('document_events');
  await insert('document_draft_fields');
  await insert('reminder_log');
  await insert('tombstones');
  await insert('request_receipts');
  return ids;
}

/** Runs `sql` as makrai_app inside a transaction whose organisation is `orgId`, then rolls back. */
async function asAppIn<T = Record<string, unknown>>(orgId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await app.query('BEGIN');
  try {
    await app.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
    return (await app.query(sql, params)).rows as T[];
  } finally {
    await app.query('ROLLBACK');
  }
}

const countAsApp = async (orgId: string, t: string) => (await asAppIn<{ n: number }>(orgId, `SELECT count(*)::int AS n FROM "${t}"`))[0].n;
const countAsOwner = async (t: string, orgId: string) => (await one(owner, `SELECT count(*)::int AS n FROM "${t}" WHERE "orgId" = $1`, [orgId]))[0].n as number;

async function hasPrivilege(role: string, t: string, p: string): Promise<boolean> {
  return (await one(owner, `SELECT has_table_privilege($1, $2::regclass, $3) AS ok`, [role, t, p]))[0].ok;
}

async function insertAsAppCarrying(ctxOrg: string, t: string, carried: Ids) {
  const [sql, params] = BUILDERS[t](carried, carried.org);
  return asAppIn(ctxOrg, sql, params);
}

async function orgIdTables(): Promise<string[]> {
  return (await one(owner, `SELECT c.relname AS t FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'orgId' AND NOT a.attisdropped
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' ORDER BY 1`)).map((r) => r.t);
}

async function tablePrivileges(role: string, tables: readonly string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of tables) {
    out[t] = (await one(owner, `SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      WHERE has_table_privilege($1, $2::regclass, p) ORDER BY 1`, [role, t])).map((r) => r.p);
  }
  return out;
}

const ctx = (orgId: string) => ({ orgId, role: 'owner' }) as OrgContext;

beforeAll(async () => {
  await resetDb();
  owner = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
  app = new Client({ connectionString: process.env.APP_DATABASE_URL, options: '' });
  await Promise.all([owner.connect(), app.connect()]);
  await owner.query(`INSERT INTO framework_versions (id, semver, "contentHash", "publishedAt", status) VALUES ($1, '0.0.0-k0a-rls', $2, now(), 'deprecated')
    ON CONFLICT (id) DO NOTHING`, [FV, hex64('fv')]);
  A = await buildOrg('a');
  B = await buildOrg('b');
});
afterAll(async () => {
  // framework_versions survives resetDb (reference data): remove this file's row, after the rows that reference it.
  await resetDb();
  await owner.query(`DELETE FROM framework_versions WHERE id = $1`, [FV]);
  await Promise.all([owner.end(), app.end()]);
});

describe('v0.6.0 step 3: tenant tables under forced RLS', () => {
  it('NFR-SEC-01: every table with an orgId column is forced and has org_isolation, enumerated from pg_catalog', async () => {
    const rows = await one(owner, `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
        EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'org_isolation'
          AND pg_get_expr(p.polqual, p.polrelid) = '("orgId" = NULLIF(current_setting(''app.current_org_id''::text, true), ''''::text))'
          AND pg_get_expr(p.polwithcheck, p.polrelid) = '("orgId" = NULLIF(current_setting(''app.current_org_id''::text, true), ''''::text))'
          AND p.polroles = '{0}') AS has_policy
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'orgId' AND NOT a.attisdropped
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' ORDER BY 1`);
    for (const r of rows) expect(r).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, has_policy: true });
    expect(rows.map((r) => r.relname)).toEqual(expect.arrayContaining(TENANT_TABLES_FROM_SRS_51)); // second root
  });

  it('NFR-SEC-01: for each tenant table, org A reads 0 rows of org B, and cannot insert a row carrying B where it may insert', async () => {
    const tables = await orgIdTables();
    expect(tables.filter((t) => !(t in BUILDERS))).toEqual([]);   // every tenant table has a builder
    for (const t of tables) {
      expect(await countAsOwner(t, B.org)).toBeGreaterThan(0);    // the row exists, so 0 below is RLS
      if (await hasPrivilege('makrai_app', t, 'SELECT')) expect({ t, n: await countAsApp(A.org, t) }).toEqual({ t, n: await countAsOwner(t, A.org) });
      if (await hasPrivilege('makrai_app', t, 'INSERT')) {
        await expect(insertAsAppCarrying(A.org, t, B), t).rejects.toThrow(/row-level security/);
      }
    }
  });

  it('NFR-SEC-01 (rule 1): a record row cannot point at a parent of another organisation', async () => {
    const [sql, params] = BUILDERS.decision_versions({ ...A, project: B.project }, A.org);
    await expect(owner.query(sql, params)).rejects.toThrow(/decision_versions_orgId_projectId_fkey/);
    const [sql2, params2] = BUILDERS.decision_evidence({ ...A, evidence: B.evidence }, A.org);
    await expect(owner.query(sql2, params2)).rejects.toThrow(/decision_evidence_orgId_evidenceId_fkey/);
  });

  it('NFR-INT-02 NFR-SEC-01 (owner answer A1): request_receipts is a forced tenant table with a uuid requestId, one receipt per (orgId, requestId), and SELECT and INSERT only for makrai_app', async () => {
    const cols = await one(owner, `SELECT column_name AS c, data_type AS t, is_nullable = 'YES' AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'request_receipts' ORDER BY ordinal_position`);
    expect(cols).toEqual([
      { c: 'id', t: 'text', n: false }, { c: 'orgId', t: 'text', n: false }, { c: 'requestId', t: 'uuid', n: false },
      { c: 'requestDigest', t: 'text', n: false }, { c: 'actorUserId', t: 'text', n: false }, { c: 'route', t: 'text', n: false },
      { c: 'rowId', t: 'text', n: true }, { c: 'result', t: 'jsonb', n: true }, { c: 'createdAt', t: 'timestamp with time zone', n: false },
    ]);   // contract round 9: no status column
    const uniques = await one(owner, `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols FROM pg_index i
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = 'request_receipts'::regclass AND i.indisunique GROUP BY i.indexrelid`);
    expect(uniques.map((u) => u.cols)).toContainEqual(['orgId', 'requestId']);
    expect(await tablePrivileges('makrai_app', ['request_receipts'])).toEqual({ request_receipts: ['INSERT', 'SELECT'] });
    expect(await tablePrivileges('makrai_identity', ['request_receipts'])).toEqual({ request_receipts: [] });
    const REQ = randomUUID();
    const insertReceiptAsApp = (orgId: string, requestId: string) => asAppIn(orgId,
      `INSERT INTO request_receipts (id, "orgId", "requestId", "requestDigest", "actorUserId", route) VALUES (gen_random_uuid()::text, $1, $2, 'd', 'u', 'r')`, [orgId, requestId]);
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.current_org_id', $1, true)`, [A.org]);
    await app.query(`INSERT INTO request_receipts (id, "orgId", "requestId", "requestDigest", "actorUserId", route) VALUES (gen_random_uuid()::text, $1, $2, 'd', 'u', 'r')`, [A.org, REQ]);
    await expect(app.query(`INSERT INTO request_receipts (id, "orgId", "requestId", "requestDigest", "actorUserId", route) VALUES (gen_random_uuid()::text, $1, $2, 'd', 'u', 'r')`, [A.org, REQ]))
      .rejects.toThrow(/unique/i);
    await app.query('ROLLBACK');
    await expect(insertReceiptAsApp(A.org, 'not-a-uuid')).rejects.toThrow(/invalid input syntax for type uuid/);
    expect(await countAsApp(B.org, 'request_receipts')).toBe(await countAsOwner('request_receipts', B.org));   // org B reads only its own
    await expect(asAppIn(A.org, `INSERT INTO request_receipts (id, "orgId", "requestId", "requestDigest", "actorUserId", route, result)
      VALUES (gen_random_uuid()::text, $1, $2, 'd', 'u', 'r', '[1]')`, [A.org, randomUUID()])).rejects.toThrow(/request_receipts_result_check/);
  });

  it('NFR-SEC-01: makrai_identity has policies only on the four named tables', async () => {
    const rows = await one(owner, `SELECT DISTINCT c.relname AS t FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE (SELECT oid FROM pg_roles WHERE rolname = 'makrai_identity') = ANY (p.polroles) ORDER BY 1`);
    expect(rows.map((r) => r.t)).toEqual(['invitations', 'memberships', 'organization_agreements', 'organizations']);
  });

  it('NFR-SEC-12 FR-REV-06: makrai_app cannot insert a tombstone', async () => {
    expect(await hasPrivilege('makrai_app', 'tombstones', 'INSERT')).toBe(false);
    await expect(insertAsAppCarrying(A.org, 'tombstones', A)).rejects.toThrow(/permission denied/);
    expect(await hasPrivilege('makrai_operator_fn', 'tombstones', 'INSERT')).toBe(true);
  });

  it('NFR-SEC-01: makrai_app has exactly the contract grants on every new table', async () => {
    expect(await tablePrivileges('makrai_app', NEW_TABLES)).toEqual(CONTRACT_APP_GRANTS);   // the contract's "Grants" table
  });

  it('FR-ORG-09 (helper): an app-lane insert into organisation_events takes orgId from the transaction', async () => {
    const before = await countAsOwner('organisation_events', A.org);
    // member_left carries its member as targetUserId: the insert trigger refuses it without one.
    await withOrg(ctx(A.org), (tx) => tx.$executeRaw`INSERT INTO organisation_events (id, "actorId", "actorRole", action, "targetUserId") VALUES (gen_random_uuid()::text, ${A.user}, 'owner', 'member_left', ${A.user})`);
    expect(await countAsOwner('organisation_events', A.org)).toBe(before + 1);
  });

  it('FR-ORG-09 NFR-SEC-04: the app lane cannot insert an administrator or join row, and a member row needs its target', async () => {
    await expect(withOrg(ctx(A.org), (tx) => tx.$executeRaw`INSERT INTO organisation_events (id, "actorId", "actorRole", action) VALUES (gen_random_uuid()::text, ${A.user}, 'platform_admin', 'account_deactivated')`)).rejects.toThrow(/refused for the app lane/);
    await expect(withOrg(ctx(A.org), (tx) => tx.$executeRaw`INSERT INTO organisation_events (id, "actorId", "actorRole", action, "targetUserId") VALUES (gen_random_uuid()::text, ${A.user}, 'owner', 'member_joined', ${B.user})`)).rejects.toThrow(/refused for the app lane/);
    await expect(withOrg(ctx(A.org), (tx) => tx.$executeRaw`INSERT INTO organisation_events (id, "actorId", "actorRole", action) VALUES (gen_random_uuid()::text, ${A.user}, 'owner', 'member_removed')`)).rejects.toThrow(/needs targetUserId/);
    // A member action with a platform_admin actor role is refused for the app lane too.
    await expect(withOrg(ctx(A.org), (tx) => tx.$executeRaw`INSERT INTO organisation_events (id, "actorId", "actorRole", action, "targetUserId") VALUES (gen_random_uuid()::text, ${A.user}, 'platform_admin', 'member_removed', ${B.user})`)).rejects.toThrow(/refused for the app lane/);
    // The definer's rows pass (the owner role stands in; the check applies only to makrai_app).
    await expect(owner.query(`INSERT INTO organisation_events (id, "orgId", "actorId", "actorRole", action) VALUES (gen_random_uuid()::text, $1, $2, 'platform_admin', 'organisation_created')`, [A.org, A.user])).resolves.toBeDefined();
    await expect(owner.query(`INSERT INTO organisation_events (id, "orgId", "actorId", "actorRole", action) VALUES (gen_random_uuid()::text, $1, $2, 'owner', 'member_joined')`, [A.org, A.user])).rejects.toThrow(/needs targetUserId/);
  });

  it('FR-REV-03 FR-DOC-04 FR-FUP-04 (helper): sealedAt is the transaction time, issuedAt is whole seconds and unique per seal and type, a claim and its outcome share an attempt', async () => {
    // E-19 T5 shape: the builder reads transaction_timestamp() first; the trigger writes the same instant.
    await owner.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      const [{ tx }] = await one(owner, `SELECT date_trunc('milliseconds', transaction_timestamp()) AS tx`);
      await owner.query(`SELECT pg_sleep(0.02)`);
      const [sql, params] = BUILDERS.seals(A, A.org);
      await owner.query(sql, params);
      const [{ sealedAt }] = await one(owner, `SELECT "sealedAt" FROM seals WHERE id = $1`, [params[0]]);
      expect(sealedAt.getTime()).toBe(tx.getTime());
    } finally {
      await owner.query('ROLLBACK');
    }
    const docAt = (at: string, seal = A.seal, type = 'model_card') => owner.query(`INSERT INTO issued_documents (id, "orgId", "projectId", "stageReviewId", "sealId", "documentType", "templateVersion", "typedFields", pdf, "plainText", sha256, "byteSize", "issuedById", "issuedAt", "requestId", "requestDigest")
      VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, '1', '[]', '\\x01', 't', $6, 1, $7, ${at}, gen_random_uuid(), 'd')`, [A.org, A.project, A.stageReview, seal, type, hex64('x'), A.user]);
    await expect(docAt(`date_trunc('second', clock_timestamp()) + interval '0.5 second' - interval '1 second'`)).rejects.toThrow(/issued_documents_issuedAt_whole_second_check/);
    await expect(docAt(`date_trunc('second', clock_timestamp()) - interval '121 second'`)).rejects.toThrow(/issuedAt/);
    await expect(docAt(`date_trunc('second', clock_timestamp()) + interval '2 second'`)).rejects.toThrow(/issuedAt/);
    const SECOND = `date_trunc('second', clock_timestamp()) - interval '30 second'`;
    await owner.query('BEGIN');
    try {
      const [{ s }] = await one(owner, `SELECT ${SECOND} AS s`);
      await docAt(`'${s.toISOString()}'::timestamptz`);
      await expect(docAt(`'${s.toISOString()}'::timestamptz`)).rejects.toThrow(/issued_documents_second_key/);
    } finally {
      await owner.query('ROLLBACK');
    }
    const mitigationId = randomUUID();
    const log = (attempt: number, outcome: string) => owner.query(`INSERT INTO reminder_log (id, "orgId", "mitigationId", "dueDate", kind, attempt, outcome) VALUES (gen_random_uuid()::text, $1, $2, '2026-11-10', 'due', $3, $4)`,
      [A.org, mitigationId, attempt, outcome]);
    await log(1, 'claimed');
    await log(1, 'sent');
    await expect(log(1, 'claimed')).rejects.toThrow(/unique/i);       // two runs cannot claim one attempt
    await log(2, 'claimed');
    await expect(log(2, 'sent')).rejects.toThrow(/reminder_log_one_sent_key/);   // at most one success
    await log(2, 'failed');
  });

  it('FR-REV-03 (5.4): every salt column has the one salt default', async () => {
    await owner.query('BEGIN');
    let stored: string;
    try {
      await owner.query(`CREATE TABLE k0a_salt_probe (s bytea DEFAULT ${SALT_SQL})`);
      stored = (await one(owner, `SELECT pg_get_expr(d.adbin, d.adrelid) AS e FROM pg_attrdef d WHERE d.adrelid = 'k0a_salt_probe'::regclass`))[0].e;
    } finally {
      await owner.query('ROLLBACK');
    }
    const salts = await one(owner, `SELECT c.relname AS t, a.attname AS col, pg_get_expr(d.adbin, d.adrelid) AS e, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS nn
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attname LIKE '%Salt' AND NOT a.attisdropped ORDER BY 1, 2`);
    expect(salts.length).toBe(14);
    for (const s of salts) expect(s).toMatchObject({ e: stored, type: 'bytea', nn: false });
  });

  it('FR-EVD-01 NFR-REL-07: a v1 evidence row needs no question, and the v0.5.0 dedupe still holds for assessment rows', async () => {
    const SHA = hex64(randomUUID());
    const v1 = (kind: 'file' | 'link') => asAppIn(A.org, kind === 'link'
      ? `INSERT INTO evidence (id, "orgId", "projectId", kind, url, label, "uploadedById", "requestId", "requestDigest") VALUES (gen_random_uuid()::text, $1, $2, 'link', 'https://x.test', 'l', $3, gen_random_uuid(), 'd')`
      : `INSERT INTO evidence (id, "orgId", "projectId", kind, filename, "mimeType", "byteSize", sha256, "uploadedById", "requestId", "requestDigest") VALUES (gen_random_uuid()::text, $1, $2, 'file', 'f', 'application/pdf', 1, '${SHA}', $3, gen_random_uuid(), 'd')`,
      [A.org, A.project, A.user]);
    await expect(v1('link')).resolves.toBeDefined();
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.current_org_id', $1, true)`, [A.org]);
    for (let i = 0; i < 2; i++) {
      await app.query(`INSERT INTO evidence (id, "orgId", "projectId", kind, filename, "mimeType", "byteSize", sha256, "uploadedById", "requestId", "requestDigest") VALUES (gen_random_uuid()::text, $1, $2, 'file', 'f', 'application/pdf', 1, '${SHA}', $3, gen_random_uuid(), 'd')`, [A.org, A.project, A.user]);
    }
    await app.query('ROLLBACK');
    const v050 = () => owner.query(`INSERT INTO evidence (id, "orgId", "assessmentId", "frameworkVersionId", "questionId", filename, "mimeType", "byteSize", sha256) VALUES (gen_random_uuid()::text, $1, $2, $3, 'Q-PP-01', 'f', 'application/pdf', 1, '${SHA}')`,
      [A.org, A.assessment, FV]);
    await v050();
    await expect(v050()).rejects.toThrow(/evidence_dedup_key/);
    // A row with neither a project nor exactly one v0.5.0 attach point is still refused.
    await expect(owner.query(`INSERT INTO evidence (id, "orgId", kind) VALUES (gen_random_uuid()::text, $1, 'link')`, [A.org])).rejects.toThrow(/evidence_attach_target_check/);
    await expect(owner.query(`INSERT INTO evidence (id, "orgId", "projectId", kind) VALUES (gen_random_uuid()::text, $1, $2, 'other')`, [A.org, A.project])).rejects.toThrow(/evidence_kind_check/);
  });

  it('FR-FND-07 (5.3 item 11): findingSeq runs 1, 2, 3 across events, mitigations and accepted risks, and a used number is refused', async () => {
    const [fsql, fparams] = BUILDERS.findings(A, A.org);
    await owner.query(fsql, fparams);
    const f = { ...A, finding: fparams[0] as string };
    const seqs: number[] = [];
    for (const t of ['mitigation_versions', 'finding_events', 'accepted_risks']) {
      const [sql, params] = BUILDERS[t](f, A.org);
      await owner.query(sql, params);
      seqs.push((await one(owner, `SELECT "findingSeq" AS s FROM "${t}" WHERE id = $1`, [params[0]]))[0].s);
    }
    expect(seqs).toEqual([1, 2, 3]);
    // A writer that passes a number must pass the next one (here 4), across the three tables.
    await expect(owner.query(`INSERT INTO finding_events (id, "orgId", "findingId", kind, "byId", "findingSeq", "requestId", "requestDigest")
      VALUES (gen_random_uuid()::text, $1, $2, 'reopened', $3, 2, gen_random_uuid(), 'd')`, [A.org, f.finding, A.user])).rejects.toThrow(/findingSeq/);
    await expect(owner.query(`INSERT INTO accepted_risks (id, "orgId", "findingId", "enteredById", "enteredByRole", "findingSeq", "requestId", "requestDigest")
      VALUES (gen_random_uuid()::text, $1, $2, $3, 'owner', 4, gen_random_uuid(), 'd')`, [A.org, f.finding, A.user])).resolves.toBeDefined();
  });
});
