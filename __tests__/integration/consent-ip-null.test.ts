import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { identityDb } from '../../lib/data/identity';
import { testDb, resetDb } from '../helpers/db';
import { buildOrg } from '../helpers/recordFixture';

/**
 * consent_records never stores a client address, whoever inserts (SRS 9.5 step 6, line 3690): a
 * BEFORE INSERT trigger, ENABLE ALWAYS, sets "ipAddress" to null. A trigger and not a CHECK,
 * because a new CHECK on a table v0.5.0 writes would refuse a rolled-back v0.5.0 (NFR-REL-07,
 * SRS line 3166).
 */

const MIGRATIONS = 'prisma/migrations';
let owner: Client;
let identity: Client;

async function query(c: Client, sql: string): Promise<unknown[]> {
  return (await c.query(sql)).rows;
}
const asOwner = (sql: string) => query(owner, sql);
const asIdentity = (sql: string) => query(identity, sql);

/** The SQL of the migration folder whose name ends `_<name>`, with comments removed as K0a's expand-only lint removes them. */
function readMigration(name: string): string {
  const dirs = readdirSync(MIGRATIONS).filter((d) => d.endsWith(`_${name}`));
  expect(dirs).toHaveLength(1);
  return readFileSync(join(MIGRATIONS, dirs[0], 'migration.sql'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

beforeAll(async () => {
  owner = new Client({ connectionString: process.env.DATABASE_URL });
  identity = new Client({ connectionString: process.env.IDENTITY_DATABASE_URL });
  await owner.connect();
  await identity.connect();
});
afterAll(async () => {
  await owner.end();
  await identity.end();
});
beforeEach(async () => {
  await resetDb();
});

describe('consent_records stores no client address (SRS 9.5 step 6)', () => {
  it('FR-ACC-03: an insert into consent_records with an address stores null, from the owner role and from makrai_identity', async () => {
    const fx = await buildOrg();
    for (const run of [asOwner, asIdentity]) {
      const id = randomUUID();
      await run(`INSERT INTO consent_records (id,"userId","consentType",version,granted,"ipAddress")
        VALUES ('${id}','${fx.members.owner.userId}','terms_of_service','1',true,'203.0.113.9')`);
      expect(await asOwner(`SELECT count(*)::int AS n FROM consent_records WHERE id = '${id}' AND "ipAddress" IS NULL`)).toEqual([{ n: 1 }]);
    }
  });

  it('FR-ACC-03: an insert under session_replication_role = replica (a data-only restore) stores null too', async () => {
    const fx = await buildOrg();
    const id = randomUUID();
    await asOwner(`BEGIN; SET LOCAL session_replication_role = replica;
      INSERT INTO consent_records (id,"userId","consentType",version,granted,"ipAddress")
      VALUES ('${id}','${fx.members.owner.userId}','privacy_policy','1',true,'203.0.113.9'); COMMIT`);
    expect(await asOwner(`SELECT "ipAddress" FROM consent_records WHERE id = '${id}'`)).toEqual([{ ipAddress: null }]);
  });

  it('FR-ACC-03: an identity-lane Prisma create that passes an address stores null', async () => {
    const fx = await buildOrg();
    const row = await identityDb.consentRecord.create({ data: { userId: fx.members.owner.userId, consentType: 'privacy_policy',
      version: '1', granted: true, ipAddress: '203.0.113.9' } });
    expect((await testDb.consentRecord.findUniqueOrThrow({ where: { id: row.id } })).ipAddress).toBeNull();
  });

  it('NFR-REL-07 FR-ACC-03: the trigger fires always, and the migration (comments removed) adds no CHECK, NOT NULL, column, DROP or RENAME', async () => {
    expect(await asOwner(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'consent_records_null_ip'`)).toEqual([{ tgenabled: 'A' }]);
    const sql = readMigration('v060_consent_ip_null');   // comments removed, as K0a's expand-only lint reads it
    expect(sql).toMatch(/CREATE TRIGGER consent_records_null_ip BEFORE INSERT ON "consent_records"/);   // the scan below ran over real statements, not an empty string
    expect(sql).toMatch(/ENABLE ALWAYS TRIGGER consent_records_null_ip/);
    expect(sql).not.toMatch(/\bCHECK\b|ADD\s+CONSTRAINT|NOT\s+NULL|ADD\s+COLUMN|\bDROP\b|\bRENAME\b/i);
  });
});
