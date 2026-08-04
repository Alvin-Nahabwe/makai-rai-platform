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
 */
async function main() {
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
  } else {
    console.log(`ℹ️  Admin user already exists: ${adminEmail}`);
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
 */
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
