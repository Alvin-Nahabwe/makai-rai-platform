import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';
import { identityDb } from '../../lib/data/identity';

/**
 * FR-RES-01: v1 collects no research consent. The database half of that guard.
 *
 * The two CHECK constraints come from migration
 * `20261014000100_void_research_consent`. This file does not read that migration;
 * it asks the live catalogue, so a later migration that drops or weakens either
 * constraint fails here, whichever file it edits.
 *
 *   consent_records_research_void_chk  a research_data_usage row must carry voidedAt
 *   users_research_consent_void_chk    researchConsent = true requires researchConsentVoidedAt
 *
 * Deliberately independent of `void-research-consent.test.ts`, which also tests
 * sign-up paths that later units remove.
 */

beforeEach(resetDb);

const user = () =>
  testDb.user.create({
    data: { email: `res-${randomUUID()}@example.invalid`, name: 'Res Test', passwordHash: 'x' },
  });

it('FR-RES-01: both research void constraints still exist', async () => {
  const rows = await testDb.$queryRaw<Array<{ conname: string; def: string }>>`
  SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
  WHERE conname IN ('consent_records_research_void_chk', 'users_research_consent_void_chk') ORDER BY conname`;
  expect(rows.map((r) => r.conname)).toEqual([
    'consent_records_research_void_chk',
    'users_research_consent_void_chk',
  ]);
  expect(rows[0].def).toMatch(/research_data_usage/);
  expect(rows[0].def).toMatch(/"voidedAt" IS NOT NULL/);
  expect(rows[1].def).toMatch(/"researchConsent"/);
  expect(rows[1].def).toMatch(/"researchConsentVoidedAt" IS NOT NULL/);
});

it('FR-RES-01: no lane can store a live research consent', async () => {
  const u = await user();
  await expect(
    testDb.consentRecord.create({ data: { userId: u.id, consentType: 'research_data_usage', granted: true } }),
  ).rejects.toThrow(/consent_records_research_void_chk/);
  await expect(
    identityDb.consentRecord.create({ data: { userId: u.id, consentType: 'research_data_usage', granted: true } }),
  ).rejects.toThrow(/consent_records_research_void_chk/);
  await expect(
    testDb.user.update({ where: { id: u.id }, data: { researchConsent: true } }),
  ).rejects.toThrow(/users_research_consent_void_chk/);
});

it('FR-RES-01: a void mark cannot be cleared', async () => {
  const u = await user();
  const row = await testDb.consentRecord.create({
    data: { userId: u.id, consentType: 'research_data_usage', granted: true, voidedAt: new Date(), voidReason: 'test' },
  });
  // The refusal asserted is the CHECK's own: its name in the message. A bare
  // `.rejects.toThrow()` would also pass on any other refusal of an UPDATE, such as the
  // append-only trigger v0.6.0 adds to consent_records, and so could not tell a dropped CHECK
  // from a working one. That trigger fires before the CHECK is evaluated, so it is switched off
  // for this one statement (a no-op until the trigger exists). The transaction always ends in
  // a rollback, the CHECK's refusal or the final throw, so the trigger is back on whatever
  // happens and an UPDATE that was wrongly accepted is not kept.
  await expect(
    testDb.$transaction(async (tx) => {
      await tx.$executeRaw`ALTER TABLE "consent_records" DISABLE TRIGGER USER`;
      await tx.consentRecord.update({ where: { id: row.id }, data: { voidedAt: null } });
      throw new Error('the UPDATE that clears a void mark was not refused');
    }),
  ).rejects.toThrow(/consent_records_research_void_chk/);
});
