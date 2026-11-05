import { beforeEach, expect, it } from 'vitest';
import { compare } from 'bcryptjs';
import { testDb, resetDb } from '../helpers/db';
import { buildOrg, buildPlatformAdmin } from '../helpers/recordFixture';
import { stubAcceptanceRows } from '../helpers/legalStub';
import { getOrCreatePlatformAdmin } from '../../e2e/fixtures/platformAdmin';

/**
 * `getOrCreatePlatformAdmin` (e2e/fixtures/platformAdmin.ts, units/ORG.md Task 8b): the e2e setup's one platform
 * administrator. It reuses the database's administrator when there is one (the seeded account, or the one an earlier
 * setup run made), so a second setup run on one database works under the one-administrator trigger (NFR-SEC-19).
 */

beforeEach(async () => { await resetDb(); });
const admins = () => testDb.user.findMany({ where: { role: 'admin' } });

it('NFR-SEC-19: with no administrator it builds one with no membership, and returns the fixture password', async () => {
  const { password } = (await buildOrg()).members.owner;
  const a = await getOrCreatePlatformAdmin(password);
  expect((await admins()).map((u) => u.id)).toEqual([a.userId]);
  expect(await testDb.membership.count({ where: { userId: a.userId } })).toBe(0);
  expect(a.password).toBe(password);
});

it('NFR-SEC-19: with an administrator it reuses that account, resets its password, state and acceptances, and makes no second one', async () => {
  const { password } = (await buildOrg()).members.owner;
  const existing = await buildPlatformAdmin({ acceptances: 'none' });
  await testDb.user.update({ where: { id: existing.userId }, data: { passwordHash: 'not-a-hash', isActive: false, mustChangePassword: true, failedLoginAttempts: 7, lockedUntil: new Date(Date.now() + 3600_000) } });
  const a = await getOrCreatePlatformAdmin(password);
  expect(a.userId).toBe(existing.userId);
  expect((await admins()).length).toBe(1);
  const row = await testDb.user.findUniqueOrThrow({ where: { id: a.userId } });
  expect(await compare(password, row.passwordHash)).toBe(true);
  expect([row.isActive, row.mustChangePassword, row.failedLoginAttempts, row.lockedUntil]).toEqual([true, false, 0, null]);
  expect(await testDb.consentRecord.count({ where: { userId: a.userId, granted: true } })).toBe(stubAcceptanceRows(a.userId).length);
});

it('NFR-SEC-19: a second and third call change nothing more (one administrator, one set of acceptances)', async () => {
  const { password } = (await buildOrg()).members.owner;
  const first = await getOrCreatePlatformAdmin(password);
  const again = await getOrCreatePlatformAdmin(password);
  await getOrCreatePlatformAdmin(password);
  expect(again.userId).toBe(first.userId);
  expect((await admins()).length).toBe(1);
  expect(await testDb.consentRecord.count({ where: { userId: first.userId } })).toBe(stubAcceptanceRows(first.userId).length);
});

it('NFR-SEC-19: when it must build one and the fixture password is not the one it was given, it throws', async () => {
  await expect(getOrCreatePlatformAdmin('another password')).rejects.toThrow(/fixture password drifted/);
});

it('NFR-SEC-19 FR-ACC-04: an acceptance row of the same version but another text (a stub registry\'s) does not count, so the setup adds the right one', async () => {
  const { password } = (await buildOrg()).members.owner;
  const existing = await buildPlatformAdmin({ acceptances: 'none' });
  await testDb.consentRecord.createMany({ data: stubAcceptanceRows(existing.userId).map((r) => ({ ...r, textHash: 'f'.repeat(64) })) });
  await getOrCreatePlatformAdmin(password);
  for (const want of stubAcceptanceRows(existing.userId))
    expect(await testDb.consentRecord.count({ where: { userId: existing.userId, consentType: want.consentType, version: want.version, textHash: want.textHash } }), want.consentType).toBe(1);
});
