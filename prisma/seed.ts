// prisma/seed.ts
import 'dotenv/config';
import { hash } from 'bcryptjs';
import { identityDb } from '../lib/data/identity';
import { bootstrapOrgWithOwner } from '../lib/data/preauth';

/**
 * Seeds through `bootstrapOrgWithOwner` — the same function
 * `app/api/auth/register/route.ts` uses — so the seeded state is one the
 * application can actually produce itself. `projects.orgId` is NOT NULL
 * (D-070): a `User` with no organization and no membership cannot reach
 * any tenant data, so a bare `identityDb.user.create` (the pre-tenancy
 * seed) would create an admin who can log in and immediately hit the org
 * picker with nothing to pick — not a state a real registration ever
 * produces.
 *
 * `bootstrapOrgWithOwner` has no `role` parameter (deliberately — see its
 * doc in lib/data/preauth.ts) and always defaults `User.role` to
 * `assessor` (schema.prisma). The platform-admin promotion is a SEPARATE,
 * explicit `identityDb.user.update` after bootstrap, exactly as an
 * operator would do it through `/admin/users` today were there already an
 * admin to click the button — a script cannot, being the first admin, so
 * this one step is the seed's own privileged action, not something
 * `bootstrapOrgWithOwner` is asked to special-case.
 *
 * T7d (final Plan 1b review, 2026-08-05): if `ADMIN_EMAIL` already exists —
 * because someone registered through the UI first, racing the seed, or a
 * prior seed run created the user but the process died before the role
 * promotion below — the old code printed a success tick and returned
 * WITHOUT checking or setting `role: 'admin'`. An operator running this
 * script to get their first platform admin could be left with NO platform
 * admin at all and no recovery path, because promoting a user requires an
 * existing admin to do it through `/admin/users` — misleading success,
 * plus a lockout. The fix: an existing user is still promoted to
 * `role: 'admin'` if not already, and the log line reports what actually
 * happened (created / promoted / already admin) instead of a blanket
 * checkmark for a branch that may have been a no-op.
 *
 * Exported (not just called at the bottom of this file) so
 * `__tests__/integration/seed.test.ts` can drive it directly, against the
 * same `identityDb` every other integration test uses, without going
 * through `process.exit` — see the `import.meta.url` guard below, which
 * keeps `npx tsx prisma/seed.ts` behaviour unchanged.
 */
export async function main() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@air.ug';
  const adminPassword = process.env.ADMIN_PASSWORD || 'changeme123';
  const adminName = process.env.ADMIN_NAME || 'Platform Admin';
  const adminOrgName = process.env.ADMIN_ORG_NAME || 'MAK-AI Platform';

  const existingAdmin = await identityDb.user.findUnique({ where: { email: adminEmail } });
  if (!existingAdmin) {
    const passwordHash = await hash(adminPassword, 12);
    const { userId } = await bootstrapOrgWithOwner({
      email: adminEmail,
      name: adminName,
      passwordHash,
      orgName: adminOrgName,
      researchConsent: false,
      ipAddress: 'seed-script',
    });

    // Seeded with a shared default password — force a change at first
    // login. `role: 'admin'` is the PLATFORM role (not the org role, which
    // bootstrapOrgWithOwner already set to 'owner' on the org it created).
    await identityDb.user.update({
      where: { id: userId },
      data: { role: 'admin', mustChangePassword: true },
    });

    console.log(`✅ Admin user created: ${adminEmail} (must change password on first login)`);
  } else if (existingAdmin.role !== 'admin') {
    // The user exists (most likely: registered through the UI before the
    // seed ran) but is not yet a platform admin. Promote them — this is
    // the ONLY path to a first platform admin in that situation, since
    // `/admin/users` promotion itself requires an existing admin.
    await identityDb.user.update({
      where: { id: existingAdmin.id },
      data: { role: 'admin' },
    });
    console.log(`✅ Existing user promoted to platform admin: ${adminEmail}`);
  } else {
    console.log(`ℹ️  Admin user already exists and already has role 'admin': ${adminEmail} (no-op)`);
  }

  console.log('✅ Database seeded successfully');
}

/**
 * `process.exit(0)` on success, not a bare `.finally(() => pool.end())`:
 * `lib/data/preauth.ts`'s `ownerClient` — the pool `bootstrapOrgWithOwner`
 * runs on — exports no disconnect hook at all (by design: it is meant for
 * a long-lived server process, not a one-shot script), so this script has
 * no way to close that pool's sockets. Without an explicit exit, Node's
 * event loop stays alive on that open pool and `npx prisma db seed` never
 * returns. `identityDb.$disconnect()` is still attempted first, for the
 * one pool this script CAN close cleanly, but the explicit exit is what
 * actually ends the process either way.
 *
 * Guarded by `import.meta.url === file://<the file node actually ran>` —
 * ESM's equivalent of the classic `require.main === module` check — so
 * importing `main` from a test (which runs through vitest's own entry
 * point, not this file) never triggers the exit-on-completion behaviour.
 * `npx tsx prisma/seed.ts` still runs this file directly, so the guard is
 * true and the script behaves exactly as before.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(async () => {
      await identityDb.$disconnect().catch(() => {});
      process.exit(0);
    })
    .catch(async (e) => {
      console.error('❌ Seed failed:', e);
      await identityDb.$disconnect().catch(() => {});
      process.exit(1);
    });
}
