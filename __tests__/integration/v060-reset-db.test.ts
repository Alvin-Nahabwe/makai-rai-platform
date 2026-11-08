import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { resetDb, testDb } from '../helpers/db';

/**
 * NFR-INT-01 (S15): the v0.6.0 refusal triggers refuse TRUNCATE for every role, so the test
 * harness's `resetDb()` disables the refusal triggers of the tables it truncates, truncates,
 * and re-enables them ENABLE ALWAYS, in one transaction as the test owner role
 * (00-contract.md, Test harness API, `__tests__/helpers/db.ts` row). No production path and
 * no setting can skip a refusal trigger; `integrity_log` stays untouched, as before.
 */

let su: Client;
beforeAll(async () => {
  su = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
  await su.connect();
});
afterAll(async () => { await su.end(); });

const q = async (sql: string, params: unknown[] = []) => (await su.query(sql, params)).rows;

/** Tables carrying a trigger on the step-1 refusal function, from pg_catalog. */
async function refusalTriggerTables(): Promise<string[]> {
  return (await q(`SELECT DISTINCT c.relname AS t FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND p.proname = 'record_refuse_change' ORDER BY 1`)).map((r) => r.t);
}

describe('resetDb under the v0.6.0 refusal triggers', () => {
  it('NFR-INT-01: refusal triggers are back in mode A after resetDb, and no trigger function reads a setting', async () => {
    const tables = await refusalTriggerTables();
    expect(tables.length).toBeGreaterThan(0);   // there is something for resetDb to work around
    await su.query(`INSERT INTO platform_events (id, "actorId", action, "targetUserId") VALUES (gen_random_uuid()::text, 'a', 'account_deactivated', 'a')`);
    await resetDb();
    expect(await q(`SELECT count(*)::int n FROM platform_events`)).toEqual([{ n: 0 }]);   // it did truncate
    const modes = await q(`SELECT DISTINCT tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = ANY($1) AND NOT t.tgisinternal`, [tables]);
    expect(modes).toEqual([{ tgenabled: 'A' }]);
    expect(await q(`SELECT proname FROM pg_proc WHERE prosrc ILIKE '%current_setting%' AND proname ILIKE '%refuse%'`)).toEqual([]);
    // TRUNCATE is still refused once resetDb has returned.
    await expect(su.query(`TRUNCATE platform_events`)).rejects.toThrow(/append-only: TRUNCATE refused/);
  });

  it('NFR-INT-01: resetDb refuses to run, rather than re-enable it, when a refusal trigger is not in mode A', async () => {
    // A migration that left a trigger in mode O would otherwise be "repaired" in the test
    // database only, and the mode checks of v060-append-only.test.ts would pass while
    // production kept mode O.
    await su.query(`ALTER TABLE platform_events ENABLE TRIGGER platform_events_refuse_row`);   // mode O
    try {
      await expect(resetDb()).rejects.toThrow(/platform_events_refuse_row.*mode O/);
    } finally {
      await su.query(`ALTER TABLE platform_events ENABLE ALWAYS TRIGGER platform_events_refuse_row`);
    }
    await expect(resetDb()).resolves.toBeUndefined();
  });

  it('NFR-INT-01: integrity_log is kept, not truncated', async () => {
    const count = async () => (await testDb.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM integrity_log`)[0].n;
    const before = await count();
    await q(`SELECT integrity_append('k0a-test', 'resetDb', '{}'::jsonb)`);
    await resetDb();
    expect(await count()).toBe(before + 1);
  });

  it('NFR-INT-01: a failed reset leaves the refusal triggers enabled (one transaction)', { timeout: 20000 }, async () => {
    // A lock held by another session makes the reset's TRUNCATE wait past its lock_timeout
    // (after the disables have run); the reset fails and its one transaction, disables
    // included, rolls back.
    const holder = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE platform_events IN ACCESS SHARE MODE');
      await expect(resetDb()).rejects.toThrow(/lock timeout/);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    const tables = await refusalTriggerTables();
    expect(await q(`SELECT DISTINCT tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = ANY($1) AND NOT t.tgisinternal`, [tables])).toEqual([{ tgenabled: 'A' }]);
  });
});
