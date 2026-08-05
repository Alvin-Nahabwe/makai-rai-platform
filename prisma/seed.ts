// prisma/seed.ts
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { hash } from 'bcryptjs';
import { identityDb } from '../lib/data/identity';
import { bootstrapOrgWithOwner } from '../lib/data/preauth';

/**
 * Human-partner decision (2026-08-05): `.env.example` and this script used
 * to ship a real, working default admin credential
 * (`ADMIN_PASSWORD="change-me-on-first-login"`) — public in every clone of
 * this repository. The `mustChangePassword` gate that was meant to contain
 * that was found dead earlier this phase (a JWT claim `proxy.ts` read had
 * been removed elsewhere on the branch, so the check silently evaluated to
 * `undefined`); it is fixed now, but a defence that depends on a redirect
 * firing is the wrong shape for a credential that ships in source. The fix
 * is to stop shipping one, not to shore up the gate that catches it after
 * the fact.
 *
 * Both literals below have shipped as a working admin password in this
 * repository at one time or another — `change-me-on-first-login` in
 * `.env.example` (removed by this same change), `changeme123` as this
 * file's own in-code fallback before this change. Refusing both, not just
 * the currently-documented one, closes the credential these words name AND
 * the class of "a fallback default nobody read the warning on."
 */
const KNOWN_BAD_ADMIN_PASSWORDS = new Set(['change-me-on-first-login', 'changeme123']);

/**
 * `pr-review-toolkit:silent-failure-hunter` trigger (AGENTS.md §2): a seed
 * script that warns about a bad password and proceeds anyway is a seed
 * whose warning nobody reads — the whole point of this change is that the
 * previous defence (a redirect that was supposed to force a password
 * change) silently failed to fire. This throws instead, which the caller
 * (either the `import.meta.url` exit guard below, or a test driving
 * `main()` directly) surfaces as a hard failure, not a console line among
 * many.
 */
function resolveAdminPassword(): { password: string; generated: boolean } {
  const raw = process.env.ADMIN_PASSWORD;
  if (!raw) {
    // `randomBytes(24)` = 192 bits of entropy, base64url-encoded (32
    // characters, no padding, URL/shell-safe) — well above the 24-byte
    // floor this decision specifies.
    return { password: randomBytes(24).toString('base64url'), generated: true };
  }
  if (KNOWN_BAD_ADMIN_PASSWORDS.has(raw)) {
    throw new Error(
      `ADMIN_PASSWORD is set to a known-bad default ("${raw}") that has shipped in this repository's ` +
        'source at one time or another. Refusing to seed the platform admin with it — every clone that ' +
        'copies this value would carry a working credential for the highest-privilege account. Set ' +
        'ADMIN_PASSWORD to a real secret, or leave it unset and this script will generate and print one.',
    );
  }
  return { password: raw, generated: false };
}

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
  const adminName = process.env.ADMIN_NAME || 'Platform Admin';
  const adminOrgName = process.env.ADMIN_ORG_NAME || 'MAK-AI Platform';

  const existingAdmin = await identityDb.user.findUnique({ where: { email: adminEmail } });
  if (!existingAdmin) {
    // Resolved (and, for a bad literal, refused) only here — the only
    // branch that actually consumes a password. The promote/no-op
    // branches below never touch one, so there is nothing to validate or
    // generate for them.
    const { password: adminPassword, generated } = resolveAdminPassword();
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

    if (generated) {
      // Printed exactly once — this run's process output is the only
      // place this value is ever recorded. There is no way to retrieve it
      // again short of resetting the admin's password.
      console.log('');
      console.log('⚠️  ADMIN_PASSWORD was not set — generated a random password for the platform admin.');
      console.log(`⚠️  ${adminEmail} / ${adminPassword}`);
      console.log('⚠️  This will not be shown again — store it now (e.g. in a password manager).');
      console.log('');
    }

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
