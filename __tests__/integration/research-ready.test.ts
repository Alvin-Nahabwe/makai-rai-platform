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
  await expect(testDb.consentRecord.update({ where: { id: row.id }, data: { voidedAt: null } })).rejects.toThrow();
});
