import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { scrubUserOnDeactivation } from '../../lib/data/identity';
import { resetDb, testDb } from '../helpers/db';

/**
 * SRS 9.5 steps 6 and 7 (lines 3690-3691): the scored tables frozen for makrai_app, DELETE
 * revoked on evidence (makrai_app) and consent_records (makrai_identity), every
 * consent_records."ipAddress" cleared, the refusal triggers added to evidence, evidence_blobs
 * and consent_records, TEMPORARY revoked from PUBLIC (call R-46), makrai_app's column grant
 * UPDATE ("status") on invitations with its transition trigger (SRS line 3672, obligation
 * S11), and the expired invitations marked expired.
 */

const STEP6 = 'prisma/migrations/20261030000600_v060_06_freeze/migration.sql';
const STEP7 = 'prisma/migrations/20261030000700_v060_07_data/migration.sql';

let su: Client;
let app: Client;
let org: string;
let user: string;

const q = async (sql: string, params: unknown[] = []) => (await su.query(sql, params)).rows;
const hasPrivilege = async (role: string, t: string, p: string) => (await q(`SELECT has_table_privilege($1, $2::regclass, $3) AS ok`, [role, t, p]))[0].ok as boolean;
const countWhere = async (t: string, where: string) => (await q(`SELECT count(*)::int AS n FROM "${t}" WHERE ${where}`))[0].n as number;
const asOwner = (sql: string) => su.query(sql);

async function asAppIn(orgId: string, sql: string) {
  await app.query('BEGIN');
  try {
    await app.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
    return await app.query(sql);
  } finally {
    await app.query('ROLLBACK');
  }
}

async function invitation(status: 'pending' | 'revoked', expiresInMs: number): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO invitations (id, "orgId", email, role, "tokenHash", status, "invitedById", "expiresAt")
    VALUES ($1, $2, 'i@fixture.test', 'viewer', $3, $4, $5, (now() AT TIME ZONE 'UTC') + make_interval(secs => $6))`,
    [id, org, randomUUID().replace(/-/g, '').padEnd(64, '0'), status, user, expiresInMs / 1000]);
  return id;
}

beforeAll(async () => {
  await resetDb();
  su = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
  app = new Client({ connectionString: process.env.APP_DATABASE_URL, options: '' });
  await Promise.all([su.connect(), app.connect()]);
  user = (await testDb.user.create({ data: { email: `freeze-${randomUUID()}@fixture.test`, name: 'F', passwordHash: 'x' } })).id;
  org = (await testDb.organization.create({ data: { name: 'freeze', slug: `freeze-${randomUUID().slice(0, 8)}` } })).id;
});
afterAll(async () => { await Promise.all([su.end(), app.end()]); });

describe('v0.6.0 steps 6 and 7', () => {
  it('FR-AUTHZ-03: makrai_app has no INSERT or UPDATE on assessments and remediation_items, no DELETE on evidence', async () => {
    for (const [t, p] of [['assessments', 'INSERT'], ['assessments', 'UPDATE'], ['remediation_items', 'UPDATE'], ['evidence', 'DELETE']])
      expect({ t, p, granted: await hasPrivilege('makrai_app', t, p) }).toEqual({ t, p, granted: false });
    // Reading stays (NFR-REL-07: the v0.5.0 image lists projects and their assessments).
    expect(await hasPrivilege('makrai_app', 'assessments', 'SELECT')).toBe(true);
  });

  it('FR-EXP-04: makrai_identity has no DELETE on consent_records and every ipAddress is null', async () => {
    expect(await hasPrivilege('makrai_identity', 'consent_records', 'DELETE')).toBe(false);
    expect(await countWhere('consent_records', `"ipAddress" IS NOT NULL`)).toBe(0);
    // The step-6 SQL clears a v0.5.0 row's address, and is rerunnable over a migrated database.
    await su.query('BEGIN');
    try {
      await su.query(`INSERT INTO consent_records (id, "userId", "consentType", version, granted, "ipAddress")
        VALUES (gen_random_uuid()::text, $1, 'terms_of_service', '1.0', true, '10.0.0.7')`, [user]);
      expect(await countWhere('consent_records', `"ipAddress" IS NOT NULL`)).toBe(1);
      await su.query(readFileSync(STEP6, 'utf8'));
      expect(await countWhere('consent_records', `"ipAddress" IS NOT NULL`)).toBe(0);
    } finally {
      await su.query('ROLLBACK');
    }
  });

  it('FR-EXP-04 (helper): scrubUserOnDeactivation keeps the acceptance rows', async () => {
    const u = await testDb.user.create({ data: { email: `scrub-${randomUUID()}@fixture.test`, name: 'S', passwordHash: 'x' } });
    for (const consentType of ['terms_of_service', 'privacy_policy', 'cross_border_storage'] as const) {
      await testDb.consentRecord.create({ data: { userId: u.id, consentType, version: '1', granted: true, textHash: 'a'.repeat(64) } });
    }
    await scrubUserOnDeactivation(u.id, 'scrubbed-hash');
    expect(await countWhere('consent_records', `"userId" = '${u.id}'`)).toBe(3);
    expect((await testDb.user.findUniqueOrThrow({ where: { id: u.id } })).isActive).toBe(false);
  });

  it('NFR-INT-01: evidence, evidence_blobs, consent_records refuse UPDATE and DELETE for makrai', async () => {
    for (const t of ['evidence', 'evidence_blobs', 'consent_records']) {
      await expect(asOwner(`DELETE FROM ${t}`)).rejects.toThrow(new RegExp(`${t} is append-only: DELETE refused`));
      const col = t === 'consent_records' ? 'version' : 'orgId';
      await expect(asOwner(`UPDATE ${t} SET "${col}" = "${col}"`)).rejects.toThrow(new RegExp(`${t} is append-only: UPDATE refused`));
      await expect(asOwner(`TRUNCATE ${t} CASCADE`)).rejects.toThrow(new RegExp(`${t} is append-only: TRUNCATE refused`));
    }
  });

  it('NFR-SEC-12: makrai_app cannot create a temporary table', async () => {
    await expect(app.query(`CREATE TEMP TABLE t (x int)`)).rejects.toThrow(/permission denied/);
    const identity = new Client({ connectionString: process.env.IDENTITY_DATABASE_URL, options: '' });
    await identity.connect();
    try {
      await expect(identity.query(`CREATE TEMP TABLE t (x int)`)).rejects.toThrow(/permission denied/);
    } finally {
      await identity.end();
    }
    expect((await q(`SELECT has_database_privilege('makrai_app', current_database(), 'TEMPORARY') AS ok`))[0].ok).toBe(false);
  });

  it('FR-MEM-02: makrai_app can only move a pending invitation to revoked or expired', async () => {
    const revoked = await invitation('revoked', 86400000);
    const pending = await invitation('pending', 86400000);
    await expect(asAppIn(org, `UPDATE invitations SET status = 'pending' WHERE id = '${revoked}'`)).rejects.toThrow(/only move a pending invitation/);
    await expect(asAppIn(org, `UPDATE invitations SET status = 'accepted' WHERE id = '${pending}'`)).rejects.toThrow(/only move a pending invitation/);
    await expect(asAppIn(org, `UPDATE invitations SET status = 'revoked' WHERE id = '${pending}'`)).resolves.toBeDefined();
    await expect(asAppIn(org, `UPDATE invitations SET status = 'expired' WHERE id = '${pending}'`)).resolves.toBeDefined();
    await expect(asAppIn(org, `UPDATE invitations SET role = 'owner' WHERE id = '${pending}'`)).rejects.toThrow(/permission denied/);
    // The identity lane's acceptance transition is unchanged.
    const identity = new Client({ connectionString: process.env.IDENTITY_DATABASE_URL, options: '' });
    await identity.connect();
    try {
      await identity.query('BEGIN');
      await expect(identity.query(`UPDATE invitations SET status = 'accepted' WHERE id = $1`, [pending])).resolves.toBeDefined();
      await identity.query('ROLLBACK');
    } finally {
      await identity.end();
    }
  });

  it('SRS 9.5 step 7 FR-ORG-02: a pending invitation past expiresAt is marked expired', async () => {
    await su.query('BEGIN');
    try {
      const expiredSeed = await invitation('pending', -60000);
      const live = await invitation('pending', 86400000);
      await su.query(readFileSync(STEP7, 'utf8'));
      const status = async (id: string) => (await q(`SELECT status FROM invitations WHERE id = $1`, [id]))[0].status;
      expect(await status(expiredSeed)).toBe('expired');
      expect(await status(live)).toBe('pending');
    } finally {
      await su.query('ROLLBACK');
    }
  });
});
