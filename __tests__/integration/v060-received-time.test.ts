import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { OrgContext } from '../../lib/data/tenant';
import { withOrg } from '../../lib/data/tenant';
import { resetDb } from '../helpers/db';

/**
 * FR-DEC-09, NFR-INT-04, SRS 5.3 item 5 (line 1262): received time and every other
 * "(db)" time column of the v0.6.0 tables come from the database clock in a BEFORE INSERT
 * trigger, truncated to milliseconds; a value the client sends is ignored.
 */

/** Every "(db)" time column of 00-contract.md's New models rows, and the clock each uses. */
const DB_TIME_COLUMNS = [
  ['accepted_risks', 'receivedAt', 'clock'], ['decision_versions', 'receivedAt', 'clock'], ['document_events', 'at', 'clock'],
  ['finding_events', 'at', 'clock'], ['findings', 'raisedAt', 'clock'], ['mitigation_versions', 'receivedAt', 'clock'],
  ['organisation_events', 'at', 'clock'], ['organization_agreements', 'recordedAt', 'clock'], ['platform_events', 'at', 'clock'],
  ['reminder_log', 'at', 'clock'], ['request_receipts', 'createdAt', 'clock'], ['seals', 'sealedAt', 'transaction'],
  ['stage_reviews', 'openedAt', 'clock'], ['tombstones', 'at', 'clock'],
].map(([table, column, clock]) => ({ table, column, clock }));

let su: Client;
let org: string;
let user: string;
let project: string;
const FV = 'fv_k0a_rt';

beforeAll(async () => {
  await resetDb();
  su = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
  await su.connect();
  user = randomUUID(); org = randomUUID(); project = randomUUID();
  await su.query(`INSERT INTO users (id, email, name, "passwordHash", "updatedAt") VALUES ($1, $2, 'u', 'x', now())`, [user, `rt-${user}@fixture.test`]);
  await su.query(`INSERT INTO organizations (id, name, slug, "updatedAt") VALUES ($1, 'rt', $2, now())`, [org, `rt-${org.slice(0, 8)}`]);
  await su.query(`INSERT INTO projects (id, "orgId", name, "createdById", "updatedAt") VALUES ($1, $2, 'p', $3, now())`, [project, org, user]);
  await su.query(`INSERT INTO framework_versions (id, semver, "contentHash", "publishedAt", status) VALUES ($1, '0.0.0-k0a-rt', $2, now(), 'deprecated') ON CONFLICT (id) DO NOTHING`, [FV, 'b'.repeat(64)]);
});
afterAll(async () => { await su.end(); });

describe('database-set times', () => {
  it('FR-DEC-09 NFR-INT-04: received time comes from the database clock', async () => {
    const ctx = { orgId: org, role: 'assessor' } as OrgContext;
    const id = randomUUID();
    const [row] = await withOrg(ctx, (tx) => tx.$queryRaw<{ receivedAt: Date; now: Date }[]>`
      INSERT INTO decision_versions (id, "orgId", "projectId", stage, "questionId", "contentVersionId", "versionNumber", status, "enteredById", "enteredByRole", "receivedAt", "requestId", "requestDigest")
      VALUES (${id}, ${org}, ${project}, 'pre-processing', 'Q-PP-01', ${FV}, 1, 'done', ${user}, 'assessor', '2000-01-01T00:00:00Z'::timestamptz, gen_random_uuid(), 'd')
      RETURNING "receivedAt", clock_timestamp() AS now`);
    expect(Math.abs(row.receivedAt.getTime() - row.now.getTime())).toBeLessThan(5000);
    expect(row.receivedAt.getTime() % 1).toBe(0);
    const [{ us }] = (await su.query(`SELECT extract(microseconds FROM "receivedAt")::bigint % 1000 AS us FROM decision_versions WHERE id = $1`, [id])).rows;
    expect(Number(us)).toBe(0);   // truncated to milliseconds
  });

  it('FR-DEC-09 NFR-INT-04: every "(db)" time column has an always-firing insert trigger on the database clock', async () => {
    const rows = (await su.query(`SELECT c.relname AS "table", encode(t.tgargs, 'escape') AS args, t.tgenabled AS mode, (t.tgtype & 2) <> 0 AS before, (t.tgtype & 4) <> 0 AS ins
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND p.proname = 'record_set_db_time' ORDER BY 1`)).rows;
    const found = rows.map((r) => {
      const [column, clock] = r.args.split('\\000').filter(Boolean);
      expect({ t: r.table, mode: r.mode, before: r.before, ins: r.ins }).toEqual({ t: r.table, mode: 'A', before: true, ins: true });
      return { table: r.table, column, clock: clock ?? 'clock' };
    });
    expect(found.sort((a, b) => a.table.localeCompare(b.table))).toEqual(DB_TIME_COLUMNS);
  });
});
