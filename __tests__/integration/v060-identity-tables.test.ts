import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { testDb, resetDb } from '../helpers/db';

/**
 * SRS 9.5 step 2 (line 3686): the identity-lane tables (`password_reset_tokens`,
 * `known_devices`, `platform_events`, `organization_agreements`), the `consent_records`
 * extension, the new `invitations` columns and `users.reminderEmails`, with the identity
 * rows of 00-contract.md's "Grants" table.
 */

let owner: Client;
let identity: Client;
let app: Client;
let u: string;
let inv: string;
let org: string;

const hex = (c: string) => c.repeat(64);

beforeAll(async () => {
  await resetDb();
  owner = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
  identity = new Client({ connectionString: process.env.IDENTITY_DATABASE_URL, options: '' });
  app = new Client({ connectionString: process.env.APP_DATABASE_URL, options: '' });
  await Promise.all([owner.connect(), identity.connect(), app.connect()]);
  u = (await testDb.user.create({ data: { email: `k0a-a4-${randomUUID()}@fixture.test`, name: 'A4', passwordHash: 'x' } })).id;
  org = (await testDb.organization.create({ data: { name: 'A4 org', slug: `a4-${randomUUID().slice(0, 8)}` } })).id;
  inv = (await testDb.invitation.create({
    data: { orgId: org, email: 'invitee@fixture.test', role: 'viewer', tokenHash: hex('1'), invitedById: u, expiresAt: new Date(Date.now() + 86400000) },
  })).id;
});
afterAll(async () => { await Promise.all([owner.end(), identity.end(), app.end()]); });

const asIdentity = (sql: string, params: unknown[] = []) => identity.query(sql, params);
const asOwner = (sql: string, params: unknown[] = []) => owner.query(sql, params);

async function identityInsertToken(t: { tokenHash: string }): Promise<string> {
  const id = randomUUID();
  await asIdentity(`INSERT INTO password_reset_tokens (id, "userId", "tokenHash", "expiresAt") VALUES ($1, $2, $3, now() + interval '30 minutes')`,
    [id, u, t.tokenHash]);
  return id;
}

async function columns(table: string) {
  return (await asOwner(`SELECT column_name AS name, is_nullable = 'YES' AS nullable, column_default AS default
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table])).rows;
}

async function checkDef(table: string, name: string): Promise<string> {
  const r = await asOwner(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`, [table, name]);
  return r.rows[0]?.def ?? '';
}

async function tablePrivileges(role: string, table: string): Promise<string[]> {
  const r = await asOwner(`SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
    WHERE has_table_privilege($1, $2::regclass, p) ORDER BY 1`, [role, table]);
  return r.rows.map((x) => x.p);
}

async function columnPrivileges(role: string, table: string, privilege: string): Promise<string[]> {
  const r = await asOwner(`SELECT a.attname::text AS c FROM pg_attribute a
    WHERE a.attrelid = $2::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND has_column_privilege($1, $2::regclass, a.attname, $3)
      AND NOT has_table_privilege($1, $2::regclass, $3) ORDER BY 1`, [role, table, privilege]);
  return r.rows.map((x) => x.c);
}

describe('v0.6.0 step 2: identity-lane tables and columns', () => {
  it('FR-ACC-06: reset tokens store a unique hash; usedAt and voidedAt cannot be cleared', async () => {
    const t = await identityInsertToken({ tokenHash: 'h1' });
    await expect(identityInsertToken({ tokenHash: 'h1' })).rejects.toThrow(/unique/i);
    await asIdentity(`UPDATE password_reset_tokens SET "usedAt" = now() WHERE id = '${t}'`);
    await expect(asIdentity(`UPDATE password_reset_tokens SET "usedAt" = NULL WHERE id = '${t}'`)).rejects.toThrow(/set once/);
    await asIdentity(`UPDATE password_reset_tokens SET "voidedAt" = now() WHERE id = '${t}'`);
    await expect(asIdentity(`UPDATE password_reset_tokens SET "voidedAt" = now() + interval '1 day' WHERE id = '${t}'`)).rejects.toThrow(/set once/);
    // The owner role is bound too (the trigger is ENABLE ALWAYS).
    await expect(asOwner(`UPDATE password_reset_tokens SET "usedAt" = NULL WHERE id = '${t}'`)).rejects.toThrow(/set once/);
  });

  it('FR-ACC-06 (grants): the identity lane may read, insert, and update only usedAt and voidedAt; the app lane nothing', async () => {
    expect(await tablePrivileges('makrai_identity', 'password_reset_tokens')).toEqual(['INSERT', 'SELECT']);
    expect(await columnPrivileges('makrai_identity', 'password_reset_tokens', 'UPDATE')).toEqual(['usedAt', 'voidedAt']);
    expect(await columnPrivileges('makrai_definer', 'password_reset_tokens', 'UPDATE')).toEqual(['voidedAt']);
    expect(await tablePrivileges('makrai_app', 'password_reset_tokens')).toEqual([]);
    await expect(asIdentity(`UPDATE password_reset_tokens SET "tokenHash" = 'x'`)).rejects.toThrow(/permission denied/);
  });

  it('FR-ACC-05: known_devices holds a per-browser failure count for an account, on the identity lane only', async () => {
    expect((await columns('known_devices')).map((c) => c.name).sort()).toEqual(['failedCount', 'id', 'lastSeenAt', 'lockedUntil', 'userId']);
    expect(await tablePrivileges('makrai_identity', 'known_devices')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(await tablePrivileges('makrai_app', 'known_devices')).toEqual([]);
    const id = randomUUID();
    await asIdentity(`INSERT INTO known_devices (id, "userId") VALUES ($1, $2)`, [id, u]);
    await asIdentity(`UPDATE known_devices SET "failedCount" = "failedCount" + 1 WHERE id = $1`, [id]);
    expect((await asIdentity(`SELECT "failedCount" FROM known_devices WHERE id = $1`, [id])).rows[0].failedCount).toBe(1);
  });

  it('FR-ACC-03: consent_records accepts cross_border_storage and a text hash; ipAddress is nullable', async () => {
    await expect(asIdentity(`INSERT INTO consent_records (id,"userId","consentType",version,granted,"textHash")
      VALUES (gen_random_uuid()::text,'${u}','cross_border_storage','1',true,'${'a'.repeat(64)}')`)).resolves.toBeDefined();
    expect(await columns('consent_records')).toEqual(expect.arrayContaining([
      { name: 'textHash', nullable: true, default: null }, { name: 'ipAddress', nullable: true, default: null }]));
  });

  it('FR-FUP-06: users gain reminderEmails, on by default', async () => {
    expect(await columns('users')).toEqual(expect.arrayContaining([{ name: 'reminderEmails', nullable: false, default: 'true' }]));
    expect((await testDb.user.findUniqueOrThrow({ where: { id: u } })).reminderEmails).toBe(true);
  });

  it('FR-ORG-09: platform_events refuses UPDATE and DELETE for makrai', async () => {
    // A row to refuse on: UPDATE and DELETE are refused row by row (SRS 5.3 item 1).
    await asOwner(`INSERT INTO platform_events (id, "actorId", action, "targetUserId") VALUES (gen_random_uuid()::text, '${u}', 'account_deactivated', '${u}')`);
    await expect(asOwner(`DELETE FROM platform_events`)).rejects.toThrow(/append-only/);
    await expect(asOwner(`UPDATE platform_events SET action = 'account_reactivated'`)).rejects.toThrow(/append-only/);
    await expect(asOwner(`TRUNCATE platform_events`)).rejects.toThrow(/append-only/);
    expect(await tablePrivileges('makrai_identity', 'platform_events')).toEqual([]);
    expect(await tablePrivileges('makrai_app', 'platform_events')).toEqual([]);
    // SELECT for personal_platform_rows, the person's own platform rows in their export (NFR-PRIV-08, ADR-0009).
    expect(await tablePrivileges('makrai_definer', 'platform_events')).toEqual(['INSERT', 'SELECT']);
  });

  it('FR-ORG-09 (helper): platform_events takes its time from the database and checks its action', async () => {
    const [row] = (await asOwner(`INSERT INTO platform_events (id, "actorId", action, "targetUserId", at)
      VALUES (gen_random_uuid()::text, $1, 'account_deactivated', $1, '2000-01-01') RETURNING at, clock_timestamp() AS now`, [u])).rows;
    expect(Math.abs(row.at.getTime() - row.now.getTime())).toBeLessThan(5000);
    await expect(asOwner(`INSERT INTO platform_events (id, "actorId", action, "targetUserId") VALUES (gen_random_uuid()::text, $1, 'other', $1)`, [u]))
      .rejects.toThrow(/platform_events_action_check/);
  });

  it('FR-ORG-01 FR-ORG-05 NFR-SEC-01: organization_agreements is forced, app SELECT under org_isolation, identity SELECT, definer INSERT, append-only', async () => {
    const [rls] = (await asOwner(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'organization_agreements'::regclass`)).rows;
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await tablePrivileges('makrai_app', 'organization_agreements')).toEqual(['SELECT']);
    expect(await tablePrivileges('makrai_identity', 'organization_agreements')).toEqual(['SELECT']);
    // INSERT only: the personal export reads agreements on the identity lane, not through the definer (C4 EXP re-review N-1).
    expect(await tablePrivileges('makrai_definer', 'organization_agreements')).toEqual(['INSERT']);
    await asOwner(`INSERT INTO organization_agreements (id, "orgId", "agreementVersion", "textHash", "acceptedOn", "controllerLegalName", "dpContactEmail", "recordedById")
      VALUES (gen_random_uuid()::text, $1, '1', $2, '2026-10-30', 'Controller Ltd', 'dpo@fixture.test', $3)`, [org, hex('b'), u]);
    // The identity lane reads every organisation's agreements (S-23, S-24); the app lane only its own.
    expect((await asIdentity(`SELECT count(*)::int n FROM organization_agreements WHERE "orgId" = $1`, [org])).rows[0].n).toBe(1);
    expect((await app.query(`SELECT count(*)::int n FROM organization_agreements`)).rows[0].n).toBe(0);
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.current_org_id', $1, true)`, [org]);
    expect((await app.query(`SELECT count(*)::int n FROM organization_agreements`)).rows[0].n).toBe(1);
    await app.query('ROLLBACK');
    await expect(asOwner(`UPDATE organization_agreements SET "agreementVersion" = '2'`)).rejects.toThrow(/append-only/);
  });

  it('FR-ACC-10 FR-ORG-02: invitations gain kind (default member, checked), linkShownAt, requestReference', async () => {
    expect(await columns('invitations')).toEqual(expect.arrayContaining([
      { name: 'kind', nullable: false, default: "'member'::text" },
      { name: 'linkShownAt', nullable: true, default: null },
      { name: 'requestReference', nullable: true, default: null }]));
    expect(await checkDef('invitations', 'invitations_kind_check')).toMatch(/'member'.*'first_owner'/);
    await expect(asOwner(`UPDATE invitations SET kind = 'other' WHERE id = '${inv}'`)).rejects.toThrow(/invitations_kind_check/);
  });
});
