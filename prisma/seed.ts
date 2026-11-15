// prisma/seed.ts
import 'dotenv/config';
import { hash } from 'bcryptjs';
import { identityDb } from '../lib/data/identity';
import { installConsoleRedaction } from '../lib/redact';

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
 *
 * RL 2.3 / 7.12: the password is never generated and never printed. The
 * migrator container logs to the host journal, so anything this script
 * prints is kept for the log retention period. An unset (or empty)
 * `ADMIN_PASSWORD` used to mean "generate a random one and print it once";
 * that is a secret in a log, and it is refused instead. Neither error below
 * quotes the value it rejects.
 */
function resolveAdminPassword(): string {
  const raw = process.env.ADMIN_PASSWORD;
  if (!raw) {
    throw new Error(
      'ADMIN_PASSWORD is not set. Refusing to seed the platform admin: this script does not generate ' +
        'a password, because anything it prints is kept in the host journal. Set ADMIN_PASSWORD in the ' +
        "server's .env to a real secret and run the seed again.",
    );
  }
  if (KNOWN_BAD_ADMIN_PASSWORDS.has(raw)) {
    throw new Error(
      "ADMIN_PASSWORD is set to a known-bad default that has shipped in this repository's " +
        'source at one time or another. Refusing to seed the platform admin with it — every clone that ' +
        'copies this value would carry a working credential for the highest-privilege account. Set ' +
        'ADMIN_PASSWORD to a real secret.',
    );
  }
  return raw;
}

/**
 * Seeds the platform administrator and nothing else: the account holds no organisation and no
 * membership, because from v0.6.0 a platform administrator never belongs to one (FR-ORG-03: the
 * administrator creates organisations and invites their first owners, and joins none; NFR-SEC-04 (d): the
 * database refuses a membership for an administrator, and the platform role for a member). It accepts the
 * legal texts at its first sign-in like every account (FR-ACC-04), so no consent row is written here
 * either. FR-ORG-04: no first organisation is seeded.
 *
 * `identityDb.user.create` makes the account with `role: 'admin'` and `mustChangePassword: true` in one
 * statement: the platform role is the PLATFORM role (a non-tenant column), and the password is a shared
 * default the person must change at first login.
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
  const adminName = process.env.ADMIN_NAME || 'MAK-AI administrator';

  const existingAdmin = await identityDb.user.findUnique({ where: { email: adminEmail } });
  if (!existingAdmin) {
    // Resolved (and, for a bad literal, refused) only here — the only
    // branch that actually consumes a password. The promote/no-op
    // branches below never touch one, so there is nothing to validate or
    // generate for them.
    const passwordHash = await hash(resolveAdminPassword(), 12);
    await identityDb.user.create({
      data: { email: adminEmail, name: adminName, passwordHash, role: 'admin', mustChangePassword: true },
    });

    // No address and no password in any line below (RL 2.3 / 7.12): this output goes to
    // the host journal under the migrator's tag.
    console.log('✅ Admin user created (must change password on first login)');
  } else if (existingAdmin.role !== 'admin') {
    // The user exists (most likely: registered through the UI before the
    // seed ran) but is not yet a platform admin. Promote them — this is
    // the ONLY path to a first platform admin in that situation, since
    // `/admin/users` promotion itself requires an existing admin.
    await identityDb.user.update({
      where: { id: existingAdmin.id },
      data: { role: 'admin' },
    });
    console.log('✅ Existing user promoted to platform admin');
  } else {
    console.log("ℹ️  Admin user already exists and already has role 'admin' (no-op)");
  }

  console.log('✅ Database seeded successfully');
}

/**
 * `process.exit(0)` on success, not a bare `.finally(() => pool.end())`:
 * the data modules this script imports hold pools meant for a long-lived
 * server process, and some export no disconnect hook at all, so this
 * script has no way to close every socket. Without an explicit exit,
 * Node's event loop can stay alive on an open pool and `npx prisma db seed`
 * never returns. `identityDb.$disconnect()` is still attempted first, for
 * the one pool this script CAN close cleanly, but the explicit exit is what
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
  // The migrator is not the Next server, so nothing else wraps its console. This covers the
  // one line that can carry data it did not write itself: the error below, which may be a
  // database error naming a row.
  installConsoleRedaction();
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
