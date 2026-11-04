import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { testDb, resetDb } from '../helpers/db';
import { buildOrg, buildPlatformAdmin, type FixtureAccount, type OrgFixture } from '../helpers/recordFixture';
import { acceptInvitationViaDefiner, adminCreateOrganisation } from '../../lib/data/definer';
import type { AgreementInput } from '../../types/api';

/**
 * v0.6.0 step 8 (ORG; SRS 9.5 grant table, line 3673): the identity lane loses its direct writes to
 * `organizations`, `memberships` and `invitations`, so only the definer functions (and their FR-ORG-09 rows)
 * create organisations and memberships and change invitations; and the platform keeps one administrator
 * (NFR-SEC-19, SRS line 3003): the `users_one_platform_admin` trigger refuses a second, and the migration
 * stops on a database that already holds two.
 */

const MIGRATIONS = 'prisma/migrations';
let owner: Client;
let identity: Client;

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

/** One statement on the identity lane (`makrai_identity`). */
const asIdentity = async (sql: string) => (await identity.query(sql)).rows;

/** Statements on one owner connection inside BEGIN ... ROLLBACK, so whatever they change is undone. */
async function inRolledBackTx(run: (q: (sql: string) => Promise<unknown>) => Promise<void>): Promise<void> {
  await owner.query('BEGIN');
  try {
    await run(async (sql) => (await owner.query(sql)).rows);
  } finally {
    await owner.query('ROLLBACK');
  }
}

/** The SQL of the migration folder whose name ends `_<name>`, with comments removed. */
function readMigration(name: string): string {
  const dirs = readdirSync(MIGRATIONS).filter((d) => d.endsWith(`_${name}`));
  expect(dirs).toHaveLength(1);
  return readFileSync(join(MIGRATIONS, dirs[0], 'migration.sql'), 'utf8').replace(/--[^\n]*/g, '');
}

async function tablePrivileges(role: string, tables: readonly string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of tables) {
    const r = await owner.query(`SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      WHERE has_table_privilege($1, $2::regclass, p) ORDER BY 1`, [role, table]);
    out[table] = r.rows.map((x) => x.p as string);
  }
  return out;
}

async function triggerEnabled(table: string, name: string): Promise<string> {
  const r = await owner.query(`SELECT tgenabled FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = $2`, [table, name]);
  return r.rows[0]?.tgenabled ?? 'missing';
}

const hex = (s: string) => createHash('sha256').update(s).digest('hex');
const AGREEMENT: AgreementInput = {
  agreementVersion: '1', textHash: hex('organisation agreement v1'), acceptedOn: '2026-10-30',
  controllerLegalName: 'Revoke Lab Controller', dpContactEmail: 'dpo@revoke.fixture.test',
};
const plainAccount = async (email: string) => (await testDb.user.create({ data: { email, name: email, passwordHash: 'x' } })).id;

let admin: FixtureAccount;
let fx: OrgFixture;
let stranger: string;
let pending: string;

beforeEach(async () => {
  await resetDb();
  admin = await buildPlatformAdmin();
  fx = await buildOrg();
  stranger = await plainAccount('stranger@fixture.test');
  pending = (await testDb.invitation.create({ data: {
    orgId: fx.org.id, email: 'pending@fixture.test', role: 'viewer', tokenHash: hex('pending'), invitedById: fx.members.owner.userId,
    expiresAt: new Date(Date.now() + 86_400_000),
  } })).id;
});

describe('step 8: the identity lane writes these tables only through the definer functions', () => {
  it('NFR-SEC-04 FR-ORG-09: makrai_identity cannot insert a membership, an organisation or update an invitation directly', async () => {
    await expect(asIdentity(`INSERT INTO memberships (id,"orgId","userId",role) VALUES (gen_random_uuid()::text,'${fx.org.id}','${stranger}','viewer')`)).rejects.toThrow(/permission denied for table memberships/);
    await expect(asIdentity(`INSERT INTO organizations (id,name,slug,"updatedAt") VALUES (gen_random_uuid()::text,'X','x',now())`)).rejects.toThrow(/permission denied for table organizations/);
    await expect(asIdentity(`UPDATE invitations SET status = 'revoked' WHERE id = '${pending}'`)).rejects.toThrow(/permission denied for table invitations/);
    expect(await tablePrivileges('makrai_identity', ['organizations', 'memberships', 'invitations'])).toEqual({ organizations: ['SELECT'], memberships: ['SELECT'], invitations: ['SELECT'] });
    expect(await testDb.membership.count({ where: { userId: stranger } })).toBe(0);
    expect((await testDb.invitation.findUniqueOrThrow({ where: { id: pending } })).status).toBe('pending');
  });

  it('FR-ORG-01 FR-ACC-01: the definer paths still work after the revocation', async () => {
    const token = randomBytes(32).toString('hex');
    const h = hex(token);
    const ownerUser = await plainAccount('o@fixture.test');
    const r = await adminCreateOrganisation({ actorUserId: admin.userId, name: 'Revoke Lab', slug: 'revoke-lab', agreement: AGREEMENT, ownerEmail: 'o@fixture.test', tokenHash: h, expiresAt: new Date(Date.now() + 7 * 86_400_000), linkShown: false });
    await expect(acceptInvitationViaDefiner({ tokenHash: h, userId: ownerUser })).resolves.toMatchObject({ orgId: r.orgId, role: 'owner' });
    expect(await testDb.membership.count({ where: { orgId: r.orgId, userId: ownerUser, role: 'owner' } })).toBe(1);
  });

  it('FR-ORG-01: no identity-lane code writes organizations, memberships or invitations', () => {
    const WRITE = /\b(organization|membership|invitation)\.(create|createMany|update|updateMany|upsert)\(/;
    const files = ['lib/data/preauth.ts', 'lib/data/identity.ts', 'lib/data/identityReads.ts', 'lib/data/admin.ts', 'lib/data/definer.ts'];
    const hits = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((line, i) => ({ f, i: i + 1, line })).filter((x) => WRITE.test(x.line)));
    expect(hits.map((h) => `${h.f}:${h.i}`)).toEqual([]);
    expect(WRITE.test('tx.membership.create({')).toBe(true);   // the pattern finds the shape it is for
  });
});

describe('step 8: one platform administrator (NFR-SEC-19)', () => {
  it('NFR-SEC-19: the database refuses a second platform administrator, also when two grants race', async () => {
    const [u1, u2] = [await plainAccount('one@fixture.test'), await plainAccount('two@fixture.test')];   // admin from beforeEach is the first
    await expect(testDb.user.update({ where: { id: u1 }, data: { role: 'admin' } })).rejects.toThrow(/one platform administrator/);
    await expect(testDb.user.create({ data: { email: 'three@fixture.test', name: 'T', passwordHash: 'x', role: 'admin' } })).rejects.toThrow(/one platform administrator/);
    await expect(asIdentity(`UPDATE users SET role = 'admin' WHERE id = '${u2}'`)).rejects.toThrow(/one platform administrator/);
    await testDb.user.update({ where: { id: admin.userId }, data: { name: 'Renamed Admin' } });   // the administrator's own row stays writable
    await testDb.user.update({ where: { id: admin.userId }, data: { role: 'admin' } });
    await testDb.user.update({ where: { id: admin.userId }, data: { role: 'assessor' } });
    for (let round = 0; round < 5; round++) {
      const rs = await Promise.allSettled([u1, u2].map((id) => testDb.user.update({ where: { id }, data: { role: 'admin' } })));
      expect(rs.filter((x) => x.status === 'fulfilled'), `round ${round}`).toHaveLength(1);
      expect(await testDb.user.count({ where: { role: 'admin' } })).toBe(1);
      await testDb.user.updateMany({ where: { id: { in: [u1, u2] } }, data: { role: 'assessor' } });
    }
  });

  it('NFR-SEC-19: the migration aborts, naming the count, when two accounts already hold the platform role', async () => {
    const guard = readMigration('v060_identity_revoke').split('\nREVOKE')[0];      // the DO block
    expect(guard).toMatch(/DO \$\$/);
    await expect(inRolledBackTx(async (q) => {
      await q('ALTER TABLE "users" DISABLE TRIGGER users_one_platform_admin');
      await q(`UPDATE "users" SET "role" = 'admin' WHERE id = '${stranger}'`);
      await q(guard);
    })).rejects.toThrow(/2 accounts hold the platform role admin/);
    expect(await triggerEnabled('users', 'users_one_platform_admin')).toBe('O');
    await inRolledBackTx(async (q) => { await q(guard); });   // one administrator: the guard passes
    expect(await testDb.user.count({ where: { role: 'admin' } })).toBe(1);
  });
});
