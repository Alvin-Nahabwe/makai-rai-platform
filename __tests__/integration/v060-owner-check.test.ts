import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { resetDb } from '../helpers/db';

/**
 * FR-ORG-04, SRS 9.5 step 0 (lines 553, 3684): the first v0.6.0 migration removes every
 * membership of a platform-administrator account; an organisation that this leaves
 * with no owner is archived (`deletedAt` set) when it has no project, and otherwise the
 * migration aborts naming it.
 *
 * The step-0 SQL is replayed over crafted rows of the A-6 shape (the seeded
 * administrator as sole owner of an empty organisation, a synthetic organisation with
 * its own owner) inside a transaction that is always rolled back, as the owner role.
 * The membership lock of NFR-SEC-04 (d) would refuse the crafted administrator
 * membership, so the crafting first disables the user triggers of `memberships` and
 * `users` inside that same transaction; the rollback restores them.
 */

const STEP0 = 'prisma/migrations/20261030000000_v060_00_owner_check/migration.sql';
const step0Sql = () => readFileSync(STEP0, 'utf8');

let su: Client;

beforeAll(async () => {
  // Leftover rows of other files (an administrator with a membership) would also be
  // processed by the replay and could abort it on their own organisation's name.
  await resetDb();
  su = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
  await su.connect();
});
afterAll(async () => { await su.end(); });

async function withRolledBack<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  await su.query('BEGIN');
  try {
    return await fn(su);
  } finally {
    await su.query('ROLLBACK');
  }
}

async function disableLockTriggersIfPresent(c: Client): Promise<void> {
  // Valid with or without triggers on the table (contract executed claim E-19 T7).
  await c.query('ALTER TABLE "memberships" DISABLE TRIGGER USER');
  await c.query('ALTER TABLE "users" DISABLE TRIGGER USER');
}

async function lockTriggersEnabledOrAbsent(): Promise<boolean> {
  const r = await su.query(`SELECT count(*)::int AS n FROM pg_trigger
    WHERE tgrelid IN ('memberships'::regclass, 'users'::regclass) AND NOT tgisinternal AND tgenabled = 'D'`);
  return r.rows[0].n === 0;
}

type Crafted = { admin: string; assessor: string; ownerY: string; S: string; Y: string };

async function craftA6Rows(c: Client, opts: { withProject?: boolean } = {}): Promise<Crafted> {
  const run = randomUUID().slice(0, 8);
  const ids = { admin: randomUUID(), assessor: randomUUID(), ownerY: randomUUID(), S: randomUUID(), Y: randomUUID() };
  const user = (id: string, email: string, role: 'admin' | 'assessor') => c.query(
    `INSERT INTO users (id, email, name, "passwordHash", role, "updatedAt") VALUES ($1, $2, 'Fixture', 'x', $3, now())`,
    [id, email, role]);
  await user(ids.admin, `admin-${run}@fixture.test`, 'admin');
  await user(ids.assessor, `assessor-${run}@fixture.test`, 'assessor');
  await user(ids.ownerY, `owner-y-${run}@fixture.test`, 'assessor');
  const org = (id: string, name: string) => c.query(
    `INSERT INTO organizations (id, name, slug, "updatedAt") VALUES ($1, $2, $3, now())`, [id, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${run}`]);
  await org(ids.S, 'Fixture Seeded Org');
  await org(ids.Y, 'Fixture Synthetic Org');
  const member = (orgId: string, userId: string, role: string) => c.query(
    `INSERT INTO memberships (id, "orgId", "userId", role) VALUES ($1, $2, $3, $4)`, [randomUUID(), orgId, userId, role]);
  await member(ids.S, ids.admin, 'owner');
  await member(ids.S, ids.assessor, 'assessor');
  await member(ids.Y, ids.ownerY, 'owner');
  if (opts.withProject) {
    await c.query(`INSERT INTO projects (id, "orgId", name, "createdById", "updatedAt") VALUES ($1, $2, 'p', $3, now())`,
      [randomUUID(), ids.S, ids.assessor]);
  }
  return ids;
}

const count = async (c: Client, sql: string, params: unknown[]) => (await c.query(sql, params)).rows[0].n as number;

describe('v0.6.0 step 0: the owner check (FR-ORG-04)', () => {
  it('FR-ORG-04: A-6 shape: admin memberships removed, empty seeded organisation archived, synthetic unchanged', async () => {
    await withRolledBack(async (tx) => {
      await disableLockTriggersIfPresent(tx);
      const x = await craftA6Rows(tx);
      await tx.query(step0Sql());
      expect(await count(tx, `SELECT count(*)::int n FROM memberships WHERE "userId" = $1`, [x.admin])).toBe(0);
      expect((await tx.query(`SELECT "deletedAt" FROM organizations WHERE id = $1`, [x.S])).rows[0].deletedAt).not.toBeNull();
      expect(await count(tx, `SELECT count(*)::int n FROM memberships WHERE "userId" = $1`, [x.assessor])).toBe(1);
      expect((await tx.query(`SELECT "deletedAt" FROM organizations WHERE id = $1`, [x.Y])).rows[0].deletedAt).toBeNull();
      expect(await count(tx, `SELECT count(*)::int n FROM memberships WHERE "orgId" = $1`, [x.Y])).toBe(1);
      // Rerunnable: a second run over the migrated rows changes nothing.
      await tx.query(step0Sql());
      expect(await count(tx, `SELECT count(*)::int n FROM memberships WHERE "orgId" IN ($1, $2)`, [x.S, x.Y])).toBe(2);
    });
    expect(await lockTriggersEnabledOrAbsent()).toBe(true);   // the rollback restored them
  });

  it('FR-ORG-04: with a project in the seeded organisation, step 0 aborts naming it', async () => {
    await expect(withRolledBack(async (tx) => {
      await disableLockTriggersIfPresent(tx);
      await craftA6Rows(tx, { withProject: true });
      await tx.query(step0Sql());
    })).rejects.toThrow(/Fixture Seeded Org/);
    expect(await lockTriggersEnabledOrAbsent()).toBe(true);
  });
});
