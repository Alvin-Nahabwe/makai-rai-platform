import { hash } from 'bcryptjs';
import { testDb } from '../../__tests__/helpers/db';
import { buildPlatformAdmin, type FixtureAccount } from '../../__tests__/helpers/recordFixture';
import { stubAcceptanceRows } from '../../__tests__/helpers/legalStub';

/**
 * The e2e setup's one platform administrator (units/ORG.md Task 8b; R11-17). The database keeps a single account with
 * the platform role (NFR-SEC-19, trigger users_platform_admin_single), so the setup never makes a second one:
 *
 *  - with no administrator it builds one through K0a's builder, and refuses to go on when that account's password is
 *    not the one it was given (a change to the fixture constant must be loud);
 *  - with one (the slot's seeded account, or the one an earlier setup run made) it reuses it: the fixture's password
 *    (bcrypt cost 12, as the fixture builder's), active, no forced change, no lockout, and any of the stub acceptance
 *    rows it lacks (the same kind, version and text hash). `consent_records` is append-only, so it only inserts.
 *
 * It never deletes, demotes or creates a second administrator. Nothing under app/, lib/ or components/ imports it
 * (NFR-PRIV-05): only the e2e setup and its integration test do.
 */
export async function getOrCreatePlatformAdmin(password: string): Promise<FixtureAccount> {
  const existing = await testDb.user.findMany({ where: { role: 'admin' }, select: { id: true, email: true, name: true } });
  if (existing.length > 1) throw new Error(`getOrCreatePlatformAdmin: ${existing.length} accounts hold the platform role; the database allows one`);
  if (existing.length === 0) {
    const built = await buildPlatformAdmin();
    if (built.password !== password) {
      throw new Error('fixture password drifted: buildPlatformAdmin() made an account whose password is not the one the setup signs in with');
    }
    return built;
  }
  const [admin] = existing;
  await testDb.user.update({
    where: { id: admin.id },
    data: { passwordHash: await hash(password, 12), isActive: true, mustChangePassword: false, failedLoginAttempts: 0, lockedUntil: null },
  });
  // Matched on the text's hash as well as its version: a slot database the vitest suite also uses can hold rows of the
  // same version made against the stub registry's texts, which the e2e server's acceptance gate does not count.
  const held = await testDb.consentRecord.findMany({ where: { userId: admin.id, granted: true }, select: { consentType: true, version: true, textHash: true } });
  const missing = stubAcceptanceRows(admin.id).filter((r) => !held.some((h) => h.consentType === r.consentType && h.version === r.version && h.textHash === r.textHash));
  if (missing.length > 0) await testDb.consentRecord.createMany({ data: missing });
  return { userId: admin.id, email: admin.email, name: admin.name, password };
}
