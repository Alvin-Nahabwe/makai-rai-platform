import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { APPEND_ONLY_TABLES } from '../../lib/data/appendOnly';
import { withOrg } from '../../lib/data/tenant';
import { resetDb, testDb } from '../helpers/db';
// Aliased: the name starts with "use", and react-hooks/rules-of-hooks reads any such call as a React hook.
import { useFixtureContent as publishFixtureContent } from '../helpers/content';
import {
  addAcceptedRisk, addDecision, addFindingEvent, addMitigationVersion, buildOrg, ctxFor, type OrgFixture,
} from '../helpers/recordFixture';
import { idsOf } from '../helpers/routeDriver';

/**
 * FR-AUTHZ-03 (SRS lines 653-657) against the database itself:
 *  - the append-only list is generated from the migrations (the functions that raise "append-only" and the
 *    tables whose triggers call them), not written by hand, and equals APPEND_ONLY_TABLES;
 *  - every database role in pg_roles, the NOLOGIN definer and operator roles and PostgreSQL's predefined roles
 *    included, is refused UPDATE and DELETE on every append-only table: by the refusal trigger where the role
 *    holds the privilege, by "permission denied" where it does not, except the operator's one exception;
 *  - for every table with an "orgId" column, makrai_app in organisation A's context reads all of A's rows and
 *    none of B's.
 * K0a's v060-rls.test.ts and v060-append-only.test.ts test three roles and hand-listed tables; this file adds
 * the generated lists and every other role.
 */

const MIGRATIONS = 'prisma/migrations';
const migrationSql = (): string =>
  readdirSync(MIGRATIONS).filter((d) => !d.endsWith('.toml')).sort()
    .map((d) => readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8')).join('\n')
    .replace(/(^|\s)--[^\n]*/g, '$1');   // a comment is not DDL

/** A function and its body, whatever its dollar-quote tag. */
const FN = /CREATE (?:OR REPLACE )?FUNCTION\s+"?(?:public\.)?(\w+)"?\s*\([^)]*\)[\s\S]*?\$(\w*)\$([\s\S]*?)\$\2\$/gi;
/** A trigger written out: `CREATE TRIGGER "x" BEFORE ... ON "t" ... EXECUTE FUNCTION fn()`. */
const TRG = /CREATE (?:OR REPLACE )?TRIGGER\s+"?\w+"?\s+(?:BEFORE|AFTER)\s+[\w\s]+?\s+ON\s+(?:public\.)?"?(\w+)"?[\s\S]*?EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:public\.)?"?(\w+)"?/gi;
/** A trigger created in a loop: `FOREACH t IN ARRAY ARRAY['a', 'b'] LOOP ... EXECUTE format('CREATE TRIGGER %I ... ON %I ... EXECUTE FUNCTION fn()', <name>, t) ... END LOOP`. */
const LOOP = /FOREACH\s+(\w+)\s+IN\s+ARRAY\s+ARRAY\[([^\]]*)\]\s+LOOP([\s\S]*?)END\s+LOOP/gi;
const LOOP_TRG = /format\(\s*'CREATE (?:OR REPLACE )?TRIGGER %I\s+(?:BEFORE|AFTER)\s+[\w\s]+?\s+ON\s+%I[^']*?EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(\w+)\([^']*'\s*,\s*[^,]+?\s*,\s*(\w+)\s*\)/gi;

/** The tables whose triggers, as the migrations create them, call a function that raises "append-only". */
function appendOnlyFromMigrations(): string[] {
  const sql = migrationSql();
  const refusers = new Set([...sql.matchAll(FN)].filter((m) => /RAISE EXCEPTION[\s\S]*append-only/i.test(m[3])).map((m) => m[1]));
  const tables = new Set([...sql.matchAll(TRG)].filter((m) => refusers.has(m[2])).map((m) => m[1]));
  for (const [, variable, list, body] of sql.matchAll(LOOP))
    for (const [, fn, onArg] of body.matchAll(LOOP_TRG))
      if (refusers.has(fn) && onArg === variable)
        for (const t of list.split(',').map((x) => x.trim().replace(/^'|'$/g, ''))) tables.add(t);
  return [...tables].sort();
}

/** The operator's exceptions (00-contract.md, Data model, Grants): only the DELETE of an evidence_blobs row. Its
 * UPDATE grants are on the erasable columns and requestDigest, and the probe writes neither. */
const OPERATOR_EXCEPTIONS: Record<string, string[]> = { evidence_blobs: ['makrai_operator_fn:DELETE'] };

let su: Client;
const q = async (sql: string, params: unknown[] = []) => (await su.query(sql, params)).rows;

/** The column a probe writes: the first primary-key column, never an erasable column or requestDigest. */
async function probeColumn(table: string): Promise<string> {
  const [row] = await q(`SELECT a.attname AS col FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid = $1::regclass AND i.indisprimary`, [`public."${table}"`]);
  if (!row) throw new Error(`authz-db-policies: ${table} has no primary key to probe`);
  return row.col;
}

/** UPDATE ... SET <key> = DEFAULT (no SELECT privilege needed, so a write-only role reaches the trigger) or DELETE, every row. */
async function refusalProbe(table: string, stmt: 'UPDATE' | 'DELETE'): Promise<string> {
  return stmt === 'UPDATE' ? `UPDATE "${table}" SET "${await probeColumn(table)}" = DEFAULT` : `DELETE FROM "${table}"`;
}

/**
 * Runs `sql` as `role` in this owner session (the only way to reach a NOLOGIN role), always rolled back. The
 * organisation context is set to `orgId` first: without it, org_isolation (forced, no TO clause) hides every row
 * from a role without BYPASSRLS, the statement matches no row, and no row trigger fires. Any session may set
 * `app.current_org_id` (lib/data/tenant.ts:219 is how withOrg sets it), so the refusal that counts is the one
 * with the rows in view.
 */
async function asRoleInSuperuserSession(role: string, sql: string, orgId?: string): Promise<void> {
  await su.query('BEGIN');
  try {
    if (orgId) await su.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
    await su.query(`SET LOCAL ROLE "${role}"`);
    await su.query(sql);
  } finally {
    await su.query('ROLLBACK');
  }
}

/** Whether `role` holds the privilege the probe needs, so the trigger, not the grants, is what must refuse it. */
async function holdsPrivilege(role: string, table: string, stmt: 'UPDATE' | 'DELETE'): Promise<boolean> {
  const [row] = stmt === 'UPDATE'
    ? await q(`SELECT has_column_privilege($1, $2::regclass, $3, 'UPDATE') AS ok`, [role, `public."${table}"`, await probeColumn(table)])
    : await q(`SELECT has_table_privilege($1, $2::regclass, 'DELETE') AS ok`, [role, `public."${table}"`]);
  return row.ok;
}

/** Every public table with an "orgId" column, from pg_attribute. */
async function orgIdTables(): Promise<string[]> {
  return (await q(`SELECT c.relname AS t FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attname = 'orgId' AND NOT a.attisdropped ORDER BY 1`)).map((r) => r.t);
}

/** Rows in every table that holds organisation rows, for `fx`, through the record fixture builder and, where it has no helper, testDb. */
async function seedEveryTenantTable(fx: OrgFixture): Promise<void> {
  const ids = {
    ...(await idsOf(fx, 'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/mitigations/[mitigationId]/route.ts')),
    ...(await idsOf(fx, 'app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts')),
    ...(await idsOf(fx, 'app/api/v1/orgs/[slug]/documents/[documentId]/pdf/route.ts')),
  };
  const { contentVersionId } = await publishFixtureContent('0.0.1-fixture');
  await addDecision(fx, ids.id, { stage: 'pre-processing', questionId: 'Q-PP-02', contentVersionId, evidenceIds: [ids.evidenceId] });
  await addMitigationVersion(fx, ids.findingId, { mitigationId: ids.mitigationId, status: 'in_progress', owner: 'assessor', dueDate: '2026-12-01', evidenceIds: [ids.evidenceId] });
  await addFindingEvent(fx, ids.findingId, { kind: 'reopened' });
  await addAcceptedRisk(fx, ids.findingId, {});
  const [org, owner] = [fx.org.id, fx.members.owner.userId];
  const run = (sql: string, ...params: unknown[]) => testDb.$executeRawUnsafe(sql, ...params);
  await run(`INSERT INTO project_metadata (id, "projectId", "orgId", "updatedAt") VALUES (gen_random_uuid()::text, $1, $2, now())`, ids.id, org);
  const [{ id: assessmentId }] = await testDb.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO assessments (id, "orgId", "projectId", "userId", "engineState", "frameworkVersionId")
     VALUES (gen_random_uuid()::text, $1, $2, $3, '{}'::jsonb, 'fv_4_0_0') RETURNING id`, org, ids.id, owner);
  await run(`INSERT INTO remediation_items (id, "assessmentId", "areaId", "areaName", tier, description, "orgId")
    VALUES (gen_random_uuid()::text, $1, 'A1', 'Area', 'gap', 'Probe item', $2)`, assessmentId, org);
  await run(`INSERT INTO issued_document_sources (id, "orgId", "documentId", "sourceTable", "sourceId") VALUES (gen_random_uuid()::text, $1, $2, 'evidence', $3)`, org, ids.documentId, ids.evidenceId);
  await run(`INSERT INTO document_events (id, "orgId", "documentId", kind, reason, "byId", "requestId", "requestDigest")
    VALUES (gen_random_uuid()::text, $1, $2, 'withdrawn', 'Probe reason', $3, gen_random_uuid(), 'probe')`, org, ids.documentId, owner);
  await run(`INSERT INTO document_draft_fields (id, "orgId", "projectId", "documentType", "updatedById", "updatedAt") VALUES (gen_random_uuid()::text, $1, $2, 'data_card', $3, now())`, org, ids.id, owner);
  await run(`INSERT INTO reminder_log (id, "orgId", "mitigationId", "dueDate", kind, attempt, outcome) VALUES (gen_random_uuid()::text, $1, $2, '2026-12-01', 'due', 1, 'claimed')`, org, ids.mitigationId);
  await run(`INSERT INTO tombstones (id, "orgId", "targetTable", "targetId", "erasureCode", "instructionReference") VALUES (gen_random_uuid()::text, $1, 'evidence', $2, 'ER', 'I')`, org, ids.evidenceId);
  await run(`INSERT INTO request_receipts (id, "orgId", "requestId", "requestDigest", "actorUserId", route) VALUES (gen_random_uuid()::text, $1, gen_random_uuid(), 'probe', $2, 'probe')`, org, owner);
  await run(`INSERT INTO organisation_events (id, "orgId", "actorId", "actorRole", action) VALUES (gen_random_uuid()::text, $1, $2, 'platform_admin', 'organisation_created')`, org, owner);
}

let a: OrgFixture;
let b: OrgFixture;

beforeAll(async () => {
  await resetDb();
  [a, b] = [await buildOrg({ label: 'db-a' }), await buildOrg({ label: 'db-b' })];
  for (const fx of [a, b]) await seedEveryTenantTable(fx);
  await testDb.$executeRawUnsafe(`INSERT INTO platform_events (id, "actorId", action, "targetUserId") VALUES (gen_random_uuid()::text, $1, 'account_deactivated', $1)`, a.members.viewer.userId);
  su = new Client({ connectionString: process.env.DATABASE_URL });
  await su.connect();
});
afterAll(async () => {
  await su.end();
});

describe('database policies for every role and table (FR-AUTHZ-03)', () => {
  it('FR-AUTHZ-03: the append-only list is generated from the migrations', () => {
    expect(appendOnlyFromMigrations()).toEqual([...APPEND_ONLY_TABLES].sort());
  });

  it('FR-AUTHZ-03: every database role is refused UPDATE and DELETE on every append-only table', async () => {
    const roles = (await q(`SELECT rolname FROM pg_roles ORDER BY 1`)).map((r) => r.rolname as string);
    expect(roles).toEqual(expect.arrayContaining(['makrai', 'makrai_app', 'makrai_identity', 'makrai_definer', 'makrai_operator_fn', 'pg_write_all_data']));
    // Not vacuous: every table holds a row, so a row trigger has a row to fire on (integrity_log's trigger is per statement).
    for (const t of APPEND_ONLY_TABLES.filter((x) => x !== 'integrity_log'))
      expect({ t, rows: (await q(`SELECT count(*)::int AS n FROM "${t}"`))[0].n > 0 }).toEqual({ t, rows: true });
    // Every outcome is collected and compared at once, so a failure names every role, statement and table that
    // was not refused as it should be.
    const wrong: string[] = [];
    let byTrigger = 0;
    for (const t of APPEND_ONLY_TABLES) for (const role of roles) for (const stmt of ['UPDATE', 'DELETE'] as const) {
      if (OPERATOR_EXCEPTIONS[t]?.includes(`${role}:${stmt}`)) continue;
      const privileged = await holdsPrivilege(role, t, stmt);
      if (privileged) byTrigger += 1;
      const expected = privileged ? new RegExp(`^${t} is append-only: ${stmt} refused`) : /^permission denied for table/;
      const outcome = await asRoleInSuperuserSession(role, await refusalProbe(t, stmt), b.org.id).then(() => 'not refused', (e: Error) => e.message);
      if (!expected.test(outcome)) wrong.push(`${role} ${stmt} ${t}: ${outcome}`);
    }
    expect(wrong).toEqual([]);
    expect(byTrigger).toBeGreaterThan(APPEND_ONLY_TABLES.length);   // the owner and pg_write_all_data, at least, reach the triggers
  });

  it('FR-AUTHZ-03: the operator\'s one exception, the DELETE of an evidence_blobs row, is what the trigger admits', async () => {
    await expect(asRoleInSuperuserSession('makrai_operator_fn', `DELETE FROM evidence_blobs WHERE "orgId" = '${b.org.id}'`, b.org.id)).resolves.toBeUndefined();
    expect((await q(`SELECT count(*)::int AS n FROM evidence_blobs WHERE "orgId" = $1`, [b.org.id]))[0].n).toBeGreaterThan(0);   // rolled back
  });

  it('FR-AUTHZ-03: for each tenant table, organisation A reads none of organisation B\'s rows', async () => {
    const tables = await orgIdTables();
    expect(tables.length).toBeGreaterThan(20);
    for (const t of tables) {
      const count = (org: string) => async (tx: Parameters<Parameters<typeof withOrg>[1]>[0]) =>
        (await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}" WHERE "orgId" = $1`, org))[0].n;
      expect({ t, bRows: (await q(`SELECT count(*)::int AS n FROM "${t}" WHERE "orgId" = $1`, [b.org.id]))[0].n > 0 }).toEqual({ t, bRows: true });
      expect({ t, seenOfB: await withOrg(ctxFor(a, 'owner'), count(b.org.id)) }).toEqual({ t, seenOfB: 0 });
      // Not vacuous: the same read in A's context sees all of A's rows, so the policy filters by organisation, not everything.
      const aRows = (await q(`SELECT count(*)::int AS n FROM "${t}" WHERE "orgId" = $1`, [a.org.id]))[0].n;
      expect({ t, seenOfA: await withOrg(ctxFor(a, 'owner'), count(a.org.id)) }).toEqual({ t, seenOfA: aRows });
      expect({ t, aRows: aRows > 0 }).toEqual({ t, aRows: true });
    }
  });
});
