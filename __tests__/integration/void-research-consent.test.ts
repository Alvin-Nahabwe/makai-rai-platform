import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Pool } from 'pg';
import type { OrgRole } from '@prisma/client';
import { testDb, resetDb } from '../helpers/db';
import { buildOrg } from '../helpers/recordFixture';
import { currentAcceptances } from '../helpers/legalStub';
import { createInvitation } from '../../lib/data/members';
import type { OrgContext } from '../../lib/data/tenant';

/**
 * Task 15 (G2-13 (b), G2-14 (b); RL section 2.3). The per-user research tick box
 * is withdrawn: no approved research protocol exists (vision 5.6; owner
 * decision D.4), so nothing may accept or store a research consent.
 *
 *   P1  nothing accepts or stores a research consent
 *   P2  stored values are kept but marked void, and CHECK constraints keep
 *       them that way
 *   P3  terms and privacy rows are untouched
 *   P4  an old client posting `researchConsent: true` still signs up
 *
 * SESSION MOCKING for the export route is the same seam export-evidence.test.ts
 * uses: `requireIdentityForApi` calls the `auth()` export of `lib/auth.ts`.
 */

let currentSession: { user: { id: string }; sessionEpoch: number; sessionIssuedAt: number } | null = null;

vi.mock('../../lib/auth', () => ({
  auth: () => Promise.resolve(currentSession),
}));

const MIGRATION = join(
  __dirname, '..', '..', 'prisma', 'migrations', '20261014000100_void_research_consent', 'migration.sql',
);

// A value that satisfies validatePassword; named so it is not a literal beside `password:`.
const LONG_ENOUGH = 'a-sufficiently-long-phrase';

const VOID_REASON =
  'Per-user research tick box withdrawn at M0: no approved research protocol existed (vision §5.6; owner decision D.4).';

function ctx(orgId: string, role: OrgRole): OrgContext {
  return { orgId, role } as OrgContext;
}

async function makeUser(email: string) {
  return testDb.user.create({ data: { email, name: email, passwordHash: 'x' } });
}

async function consentTypesOf(userId: string): Promise<string[]> {
  const rows = await testDb.consentRecord.findMany({ where: { userId }, select: { consentType: true } });
  return rows.map((r) => r.consentType).sort();
}

async function seedInvitation(slug: string, email: string) {
  const org = await testDb.organization.create({ data: { name: slug, slug } });
  const inviter = await makeUser(`${slug}-inviter@x.org`);
  await testDb.membership.create({ data: { orgId: org.id, userId: inviter.id, role: 'owner' } });
  return createInvitation({ ctx: ctx(org.id, 'owner'), email, role: 'viewer', invitedById: inviter.id });
}

async function postInvitationRegister(raw: string, body: Record<string, unknown>): Promise<Response> {
  const { POST } = await import('../../app/api/v1/invitations/[token]/register/route');
  const request = new NextRequest(`https://makrai.org/api/v1/invitations/${raw}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.15' },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ token: raw }) });
}

describe('CHECK constraints keep stored research consent void (P2)', () => {
  beforeEach(resetDb);

  it('rejects an unvoided research consent row', async () => {
    const user = await makeUser('check-consent@x.org');
    await expect(
      testDb.consentRecord.create({
        data: { userId: user.id, consentType: 'research_data_usage', granted: true },
      }),
    ).rejects.toThrow(/consent_records_research_void_chk/);
  });

  it('accepts a research consent row that carries a void mark', async () => {
    const user = await makeUser('check-consent-ok@x.org');
    await testDb.consentRecord.create({
      data: {
        userId: user.id, consentType: 'research_data_usage', granted: true,
        voidedAt: new Date(), voidReason: 'withdrawn',
      },
    });
    expect(await consentTypesOf(user.id)).toEqual(['research_data_usage']);
  });

  it('does not require a void mark on terms and privacy rows (P3)', async () => {
    const user = await makeUser('check-consent-terms@x.org');
    await testDb.consentRecord.createMany({
      data: [
        { userId: user.id, consentType: 'terms_of_service', granted: true },
        { userId: user.id, consentType: 'privacy_policy', granted: true },
      ],
    });
    expect(await consentTypesOf(user.id)).toEqual(['privacy_policy', 'terms_of_service']);
  });

  it('rejects researchConsent=true without a void mark', async () => {
    await expect(
      testDb.user.create({
        data: { email: 'check-user@x.org', name: 'u', passwordHash: 'x', researchConsent: true },
      }),
    ).rejects.toThrow(/users_research_consent_void_chk/);
  });

  it('accepts researchConsent=true once it carries a void mark, and researchConsent=false without one', async () => {
    await testDb.user.create({
      data: {
        email: 'check-user-voided@x.org', name: 'u', passwordHash: 'x',
        researchConsent: true, researchConsentVoidedAt: new Date(),
      },
    });
    await testDb.user.create({
      data: { email: 'check-user-false@x.org', name: 'u', passwordHash: 'x', researchConsent: false },
    });
    expect(await testDb.user.count({ where: { email: { startsWith: 'check-user-' } } })).toBe(2);
  });
});

describe('the migration voids what is already stored (P2, P3)', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  afterAll(async () => { await pool.end(); });
  beforeEach(resetDb);

  /**
   * Replays the committed migration.sql, verbatim, against rows in the PRE-migration
   * shape. The new columns and both CHECKs are dropped inside a transaction (Postgres
   * DDL is transactional), legacy rows are inserted, the whole file runs, and the
   * transaction is rolled back so no other test sees any of it.
   *
   * Running the real file, not a copy of its UPDATEs, is what proves the order: the CHECK
   * statements at the end fail unless the UPDATEs before them voided every row.
   */
  it('marks legacy research rows void, keeps them, and leaves terms and privacy rows alone', async () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // v0.6.0 makes consent_records append-only; the replay runs inside this rolled-back transaction, which restores the triggers.
      await client.query('ALTER TABLE "consent_records" DISABLE TRIGGER USER');
      await client.query(`ALTER TABLE "consent_records" DROP COLUMN "voidedAt", DROP COLUMN "voidReason"`);
      await client.query(`ALTER TABLE "users" DROP COLUMN "researchConsentVoidedAt"`);

      await client.query(
        `INSERT INTO "users" ("id","email","name","passwordHash","researchConsent","updatedAt") VALUES
           ('legacy-in','legacy-in@x.org','in','x',true,now()),
           ('legacy-out','legacy-out@x.org','out','x',false,now())`,
      );
      await client.query(
        `INSERT INTO "consent_records" ("id","userId","consentType","granted") VALUES
           ('c-in-terms','legacy-in','terms_of_service',true),
           ('c-in-privacy','legacy-in','privacy_policy',true),
           ('c-in-research','legacy-in','research_data_usage',true),
           ('c-out-terms','legacy-out','terms_of_service',true),
           ('c-out-privacy','legacy-out','privacy_policy',true)`,
      );

      await client.query(sql);

      const rows = (await client.query(
        `SELECT "id","consentType","granted","voidedAt","voidReason" FROM "consent_records" ORDER BY "id"`,
      )).rows;
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

      expect(byId['c-in-research'].granted).toBe(true);
      expect(byId['c-in-research'].voidedAt).toBeInstanceOf(Date);
      expect(byId['c-in-research'].voidReason).toBe(VOID_REASON);
      for (const id of ['c-in-terms', 'c-in-privacy', 'c-out-terms', 'c-out-privacy']) {
        expect(byId[id].granted, id).toBe(true);
        expect(byId[id].voidedAt, id).toBeNull();
        expect(byId[id].voidReason, id).toBeNull();
      }

      const users = (await client.query(
        `SELECT "id","researchConsent","researchConsentVoidedAt" FROM "users" ORDER BY "id"`,
      )).rows;
      const userById = Object.fromEntries(users.map((u) => [u.id, u]));
      expect(userById['legacy-in'].researchConsent).toBe(true); // kept, not erased
      expect(userById['legacy-in'].researchConsentVoidedAt).toBeInstanceOf(Date);
      expect(userById['legacy-out'].researchConsentVoidedAt).toBeInstanceOf(Date);

      const constraints = (await client.query(
        `SELECT conname FROM pg_constraint WHERE conname IN
           ('consent_records_research_void_chk','users_research_consent_void_chk') ORDER BY conname`,
      )).rows.map((r) => r.conname);
      expect(constraints).toEqual(['consent_records_research_void_chk', 'users_research_consent_void_chk']);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('sign-up stores only terms and privacy rows (P1, P4)', () => {
  beforeEach(resetDb);

  it('signs up through an invitation with only terms and privacy rows', async () => {
    const invitation = await seedInvitation('void-inv-1', 'void-inv-1-invitee@x.org');

    const res = await postInvitationRegister(invitation.rawToken, {
      name: 'New Person', password: LONG_ENOUGH, acceptances: currentAcceptances(),
    });

    expect(res.status).toBe(201);
    const { id: userId } = await testDb.user.findUniqueOrThrow({ where: { email: 'void-inv-1-invitee@x.org' } });
    // The three acceptances of FR-ACC-03, and no research row.
    expect(await consentTypesOf(userId)).toEqual(['cross_border_storage', 'privacy_policy', 'terms_of_service']);
    const user = await testDb.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.researchConsent).toBe(false);
    expect(user.termsAccepted).toBe(true);
  });

  it('ignores researchConsent sent by an old client', async () => {
    const invitation = await seedInvitation('void-inv-2', 'void-inv-2-invitee@x.org');

    const res = await postInvitationRegister(invitation.rawToken, {
      name: 'Old Client', password: LONG_ENOUGH, acceptances: currentAcceptances(), researchConsent: true,
    });

    expect(res.status).toBe(201);
    const { id: userId } = await testDb.user.findUniqueOrThrow({ where: { email: 'void-inv-2-invitee@x.org' } });
    expect(await consentTypesOf(userId)).toEqual(['cross_border_storage', 'privacy_policy', 'terms_of_service']);
    expect(await testDb.consentRecord.count({ where: { consentType: 'research_data_usage' } })).toBe(0);
    const user = await testDb.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.researchConsent).toBe(false);
  });
});

describe('GET /api/users/me/export after the tick box is withdrawn', () => {
  beforeEach(resetDb);

  it('drops researchConsent and reports the void mark on each consent record', async () => {
    // An owner whose terms and privacy rows are pre-v1 ("1.0", no hash), as v0.5.0's sign-up wrote them.
    const userId = (await buildOrg({ acceptances: 'pre-v1' })).members.owner.userId;
    const voidedAt = new Date('2026-10-08T12:00:00.000Z');
    await testDb.consentRecord.create({
      data: {
        userId, consentType: 'research_data_usage', granted: true, voidedAt, voidReason: VOID_REASON,
      },
    });
    currentSession = { user: { id: userId }, sessionEpoch: 0, sessionIssuedAt: Math.floor(Date.now() / 1000) };

    const { GET } = await import('../../app/api/users/me/export/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).not.toHaveProperty('researchConsent');
    const byType = Object.fromEntries(
      (body.consentRecords as { consentType: string }[]).map((r) => [r.consentType, r]),
    );
    expect(Object.keys(byType).sort()).toEqual(['privacy_policy', 'research_data_usage', 'terms_of_service']);
    expect(byType.research_data_usage).toMatchObject({
      granted: true, voidedAt: voidedAt.toISOString(), voidReason: VOID_REASON,
    });
    expect(byType.terms_of_service).toMatchObject({ voidedAt: null, voidReason: null });
    expect(byType.privacy_policy).toMatchObject({ voidedAt: null, voidReason: null });
  });
});
