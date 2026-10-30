import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * SRS 9.5 step 1 (line 3685): the operator and definer roles (NOLOGIN, names from SRS
 * line 3681), the append-only refusal trigger function and the database-time trigger
 * function; no extension (00-contract.md, Data model "Salts"; finding F02).
 */

/** The contract's salt expression (Data model, "Salts"), core functions only. */
const SALT_SQL = 'substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6) || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 4)';

let su: Client;
beforeAll(async () => {
  su = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
  await su.connect();
});
afterAll(async () => { await su.end(); });

const q = async (sql: string, params: unknown[] = []) => (await su.query(sql, params)).rows;

describe('v0.6.0 step 1: roles and record trigger functions', () => {
  it('NFR-SEC-12: operator and definer roles cannot log in and no application role is a member', async () => {
    const roles = await q(`SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('makrai_operator_fn','makrai_definer') ORDER BY 1`);
    expect(roles).toEqual([{ rolname: 'makrai_definer', rolcanlogin: false }, { rolname: 'makrai_operator_fn', rolcanlogin: false }]);
    const flags = await q(`SELECT bool_or(rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication) AS any
      FROM pg_roles WHERE rolname IN ('makrai_operator_fn','makrai_definer')`);
    expect(flags).toEqual([{ any: false }]);
    // No role at all is a member of either: a member could SET ROLE and pass the
    // refusal trigger's operator exception, or write as the definer.
    const members = await q(`SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
      JOIN pg_roles g ON g.oid = m.roleid WHERE g.rolname IN ('makrai_operator_fn','makrai_definer')`);
    expect(members.map((m) => m.rolname)).not.toEqual(expect.arrayContaining(['makrai_app']));
    expect(members.map((m) => m.rolname)).not.toEqual(expect.arrayContaining(['makrai_identity']));
    expect(members).toEqual([]);
  });

  it('FR-REV-03 (5.4): the salt expression gives 16 bytes with no fixed nibble, and no extension is installed', async () => {
    const [{ lo, hi, len }] = await q(`WITH s AS (SELECT ${SALT_SQL} AS b FROM generate_series(1, 4000)),
      p AS (SELECT i, count(DISTINCT get_byte(b, i) >> 4) h, count(DISTINCT get_byte(b, i) & 15) l FROM s, generate_series(0, 15) i GROUP BY i)
      SELECT min(l)::int lo, min(h)::int hi, (SELECT min(length(b)) FROM s)::int len FROM p`);
    expect({ lo, hi, len }).toEqual({ lo: 16, hi: 16, len: 16 });
    expect(await q(`SELECT extname FROM pg_extension WHERE extname <> 'plpgsql'`)).toEqual([]);
  });

  it('NFR-INT-01 FR-DEC-09 (helper): the refusal function refuses UPDATE, DELETE and TRUNCATE, also in replica mode, and the time function ignores the client value', async () => {
    await su.query('BEGIN');
    try {
      await su.query(`CREATE TABLE k0a_probe (id int PRIMARY KEY, note text, "receivedAt" timestamptz(3), "sealedAt" timestamptz(3))`);
      await su.query(`CREATE TRIGGER k0a_probe_refuse_row BEFORE UPDATE OR DELETE ON k0a_probe FOR EACH ROW EXECUTE FUNCTION record_refuse_change()`);
      await su.query(`CREATE TRIGGER k0a_probe_refuse_stmt BEFORE UPDATE OR DELETE OR TRUNCATE ON k0a_probe FOR EACH STATEMENT EXECUTE FUNCTION record_refuse_change()`);
      await su.query(`ALTER TABLE k0a_probe ENABLE ALWAYS TRIGGER k0a_probe_refuse_row, ENABLE ALWAYS TRIGGER k0a_probe_refuse_stmt`);
      await su.query(`CREATE TRIGGER k0a_probe_received BEFORE INSERT ON k0a_probe FOR EACH ROW EXECUTE FUNCTION record_set_db_time('receivedAt')`);
      await su.query(`CREATE TRIGGER k0a_probe_sealed BEFORE INSERT ON k0a_probe FOR EACH ROW EXECUTE FUNCTION record_set_db_time('sealedAt', 'transaction')`);
      await su.query(`ALTER TABLE k0a_probe ENABLE ALWAYS TRIGGER k0a_probe_received, ENABLE ALWAYS TRIGGER k0a_probe_sealed`);

      const [row] = (await su.query(`INSERT INTO k0a_probe VALUES (1, 'a', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')
        RETURNING "receivedAt", "sealedAt", date_trunc('milliseconds', transaction_timestamp()) AS tx, clock_timestamp() AS now`)).rows;
      expect(Math.abs(row.receivedAt.getTime() - row.now.getTime())).toBeLessThan(5000);
      expect(row.sealedAt.getTime()).toBe(row.tx.getTime());

      for (const replica of [false, true]) {
        await su.query(`SET LOCAL session_replication_role = ${replica ? 'replica' : 'origin'}`);
        for (const stmt of [`UPDATE k0a_probe SET note = 'b'`, `UPDATE k0a_probe SET note = 'b' WHERE false`,
          `DELETE FROM k0a_probe`, `DELETE FROM k0a_probe WHERE false`, `TRUNCATE k0a_probe`]) {
          await su.query('SAVEPOINT s');
          await expect(su.query(stmt)).rejects.toThrow(/k0a_probe is append-only: (UPDATE|DELETE|TRUNCATE) refused/);
          await su.query('ROLLBACK TO SAVEPOINT s');
        }
      }
      // The operator role passes only for the tables of its exceptions; this one has none.
      await su.query(`SET LOCAL session_replication_role = origin`);
      await su.query(`GRANT SELECT, UPDATE ON k0a_probe TO makrai_operator_fn`);
      await su.query('SAVEPOINT s');
      await su.query('SET LOCAL ROLE makrai_operator_fn');
      await expect(su.query(`UPDATE k0a_probe SET note = NULL`)).rejects.toThrow(/append-only: UPDATE refused/);
      await su.query('ROLLBACK TO SAVEPOINT s');
    } finally {
      await su.query('ROLLBACK');
    }
  });
});
