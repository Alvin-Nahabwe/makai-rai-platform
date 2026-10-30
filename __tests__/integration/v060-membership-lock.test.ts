import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { resetDb } from '../helpers/db';

/**
 * NFR-SEC-04 (d) (SRS line 2920) and NFR-SEC-19 (line 3003): the platform administrator holds
 * no membership, and no member holds the platform role. Two ENABLE ALWAYS triggers refuse
 * both directions for every role, the owner included; each locks the user row FOR SHARE before
 * it checks, so a membership insert and a role grant racing on one account cannot both commit.
 */

let su: Client;
let org: string;

const users: string[] = [];
async function makeUser(role: 'admin' | 'assessor' = 'assessor'): Promise<string> {
  const id = randomUUID();
  await su.query(`INSERT INTO users (id, email, name, "passwordHash", role, "updatedAt") VALUES ($1, $2, 'u', 'x', $3, now())`,
    [id, `lock-${id}@fixture.test`, role]);
  users.push(id);
  return id;
}
const asOwner = (sql: string, params: unknown[] = []) => su.query(sql, params);

beforeAll(async () => {
  await resetDb();
  su = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
  await su.connect();
  org = randomUUID();
  await su.query(`INSERT INTO organizations (id, name, slug, "updatedAt") VALUES ($1, 'lock', $2, now())`, [org, `lock-${org.slice(0, 8)}`]);
});
afterAll(async () => { await su.end(); });

/** One session: begin, act, hold the transaction briefly so the other session overlaps, commit. */
async function inSession(sql: string, params: unknown[], holdMs: number, url = process.env.DATABASE_URL): Promise<void> {
  const c = new Client({ connectionString: url, options: '' });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(sql, params);
    await c.query(`SELECT pg_sleep($1)`, [holdMs / 1000]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
const insertMembershipInSession = (orgId: string, userId: string, holdMs: number) =>
  inSession(`INSERT INTO memberships (id, "orgId", "userId", role) VALUES (gen_random_uuid()::text, $1, $2, 'viewer')`, [orgId, userId], holdMs);
const grantAdminInSession = (userId: string, holdMs: number) =>
  inSession(`UPDATE users SET role = 'admin' WHERE id = $1`, [userId], holdMs);

describe('the membership lock (NFR-SEC-04 (d))', () => {
  it('NFR-SEC-04 NFR-SEC-19: membership for an administrator and the role for a member are refused, also concurrently', async () => {
    const admin = await makeUser('admin');
    const member = await makeUser();
    await asOwner(`INSERT INTO memberships (id,"orgId","userId",role) VALUES (gen_random_uuid()::text,$1,$2,'viewer')`, [org, member]);
    await expect(asOwner(`INSERT INTO memberships (id,"orgId","userId",role) VALUES (gen_random_uuid()::text,'${org}','${admin}','viewer')`))
      .rejects.toThrow(/membership refused for a platform administrator/);
    await expect(asOwner(`UPDATE users SET role = 'admin' WHERE id = '${member}'`)).rejects.toThrow(/platform role refused for an account with a membership/);
    // Other updates of a member's row are untouched.
    await expect(asOwner(`UPDATE users SET name = 'renamed' WHERE id = '${member}'`)).resolves.toBeDefined();

    // Both orders of the race: whichever commits first, the other is refused.
    for (const [insertHold, grantHold, grantDelay] of [[300, 50, 0], [50, 300, 0], [200, 200, 20], [200, 200, 80]]) {
      const plainUser = await makeUser();
      const results = await Promise.allSettled([
        insertMembershipInSession(org, plainUser, insertHold),
        new Promise((r) => setTimeout(r, grantDelay)).then(() => grantAdminInSession(plainUser, grantHold)),
      ]);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const [{ role }] = (await su.query(`SELECT role FROM users WHERE id = $1`, [plainUser])).rows;
      const [{ n }] = (await su.query(`SELECT count(*)::int n FROM memberships WHERE "userId" = $1`, [plainUser])).rows;
      expect(role === 'admin' ? n : 1).toBe(role === 'admin' ? 0 : n);   // never both
    }
  });

  it('NFR-SEC-04: the identity lane is held by the lock too', async () => {
    const admin = await makeUser('admin');
    const identity = new Client({ connectionString: process.env.IDENTITY_DATABASE_URL, options: '' });
    await identity.connect();
    try {
      await expect(identity.query(`INSERT INTO memberships (id,"orgId","userId",role) VALUES (gen_random_uuid()::text,$1,$2,'owner')`, [org, admin]))
        .rejects.toThrow(/membership refused for a platform administrator/);
      const plain = await makeUser();
      await expect(identity.query(`INSERT INTO memberships (id,"orgId","userId",role) VALUES (gen_random_uuid()::text,$1,$2,'owner')`, [org, plain]))
        .resolves.toBeDefined();
      await expect(identity.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [plain])).rejects.toThrow(/platform role refused/);
    } finally {
      await identity.end();
    }
  });

  it('NFR-SEC-04: both lock triggers fire always (replica mode does not silence them)', async () => {
    const rows = (await su.query(`SELECT t.tgname AS name, t.tgenabled AS mode FROM pg_trigger t
      WHERE t.tgname IN ('memberships_platform_admin_lock', 'users_platform_admin_lock') ORDER BY 1`)).rows;
    expect(rows).toEqual([{ name: 'memberships_platform_admin_lock', mode: 'A' }, { name: 'users_platform_admin_lock', mode: 'A' }]);
    const admin = await makeUser('admin');
    await su.query('BEGIN');
    try {
      await su.query('SET LOCAL session_replication_role = replica');
      await expect(su.query(`INSERT INTO memberships (id,"orgId","userId",role) VALUES (gen_random_uuid()::text,$1,$2,'viewer')`, [org, admin]))
        .rejects.toThrow(/membership refused/);
    } finally {
      await su.query('ROLLBACK');
    }
  });

  // Runs after Task A7 (finding R2-07: the lock runs as makrai_definer inside accept_invitation).
  it.todo('NFR-SEC-04: a membership created through acceptInvitationViaDefiner as makrai_identity succeeds, and is refused for an administrator');
});
