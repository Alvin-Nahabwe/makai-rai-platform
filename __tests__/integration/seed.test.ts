import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compare } from 'bcryptjs';
import { testDb, resetDb } from '../helpers/db';
import { identityDb } from '../../lib/data/identity';
import { main as seedMain } from '../../prisma/seed';

/**
 * T7d (final Plan 1b whole-branch review, 2026-08-05): `prisma/seed.ts`
 * printed "Admin user already exists ✅" and returned as soon as
 * `ADMIN_EMAIL` matched an existing row — WITHOUT checking or setting
 * `role: 'admin'`. If that row got there by registering through the UI
 * first (its role defaults to `assessor`, schema.prisma), the operator
 * ends the run believing they have a platform admin when they do not, with
 * no recovery path: promoting a user to admin requires an existing admin
 * to click the button in `/admin/users`.
 *
 * Drives the REAL exported `main()` from `prisma/seed.ts` against the real
 * `identityDb` — not a re-implementation of its logic.
 */

const ORIGINAL_ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ORIGINAL_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

describe('prisma/seed.ts main() — platform admin bootstrap', () => {
  beforeEach(resetDb);
  afterEach(() => {
    if (ORIGINAL_ADMIN_EMAIL === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = ORIGINAL_ADMIN_EMAIL;
    if (ORIGINAL_ADMIN_PASSWORD === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = ORIGINAL_ADMIN_PASSWORD;
  });

  it('promotes a pre-existing non-admin user with the target email to admin', async () => {
    const email = 'seed-test-promote@fixture.test';
    process.env.ADMIN_EMAIL = email;

    // Simulates "someone registered through the UI first" — a real row,
    // created the same way registration creates one (role defaults to
    // 'assessor'), NOT an admin.
    const preExisting = await testDb.user.create({
      data: { email, name: 'Pre-existing user', passwordHash: 'x', role: 'assessor' },
    });
    expect(preExisting.role).toBe('assessor');

    await seedMain();

    const afterSeed = await identityDb.user.findUniqueOrThrow({ where: { email } });
    expect(afterSeed.id).toBe(preExisting.id); // same row, not a duplicate
    expect(afterSeed.role).toBe('admin');
  });

  it('is a no-op (does not error, does not duplicate) when the user is already admin', async () => {
    const email = 'seed-test-already-admin@fixture.test';
    process.env.ADMIN_EMAIL = email;

    const preExisting = await testDb.user.create({
      data: { email, name: 'Already admin', passwordHash: 'x', role: 'admin' },
    });

    await expect(seedMain()).resolves.not.toThrow();

    const afterSeed = await identityDb.user.findUniqueOrThrow({ where: { email } });
    expect(afterSeed.id).toBe(preExisting.id);
    expect(afterSeed.role).toBe('admin');
    const count = await testDb.user.count({ where: { email } });
    expect(count).toBe(1);
  });
});

/**
 * Human-partner decision (2026-08-05): stop shipping a working default
 * admin credential. Drives the real `main()` (not a re-implementation of
 * `resolveAdminPassword`) so these tests exercise exactly what an operator
 * running `npx prisma db seed` would hit.
 */
describe('prisma/seed.ts main() — admin password resolution', () => {
  beforeEach(resetDb);
  afterEach(() => {
    if (ORIGINAL_ADMIN_EMAIL === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = ORIGINAL_ADMIN_EMAIL;
    if (ORIGINAL_ADMIN_PASSWORD === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = ORIGINAL_ADMIN_PASSWORD;
  });

  it.each(['change-me-on-first-login', 'changeme123'])(
    'refuses to run when ADMIN_PASSWORD is the known-bad literal %j, and creates no user',
    async (badPassword) => {
      const email = `seed-test-refuse-${badPassword}@fixture.test`;
      process.env.ADMIN_EMAIL = email;
      process.env.ADMIN_PASSWORD = badPassword;

      await expect(seedMain()).rejects.toThrow(/known-bad/);

      const afterAttempt = await identityDb.user.findUnique({ where: { email } });
      expect(afterAttempt).toBeNull();
    },
  );

  it('generates and prints a random password exactly once when ADMIN_PASSWORD is unset, and the printed value is what got hashed', async () => {
    const email = 'seed-test-generated@fixture.test';
    process.env.ADMIN_EMAIL = email;
    delete process.env.ADMIN_PASSWORD;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let loggedLines: string[];
    try {
      await expect(seedMain()).resolves.toBeUndefined();
    } finally {
      // Capture calls BEFORE restoring — `mockRestore()` also clears
      // `.mock.calls`, so reading it after restore silently sees `[]`
      // (caught live: this test failed with an empty array on the first
      // run, for exactly this reason, before this line moved above the
      // restore).
      loggedLines = logSpy.mock.calls.map((args) => String(args[0]));
      logSpy.mockRestore();
    }

    // Exactly one line of the form "<email> / <password>" was printed —
    // "printed once" is a claim about the log output, not just about the
    // value existing somewhere in memory.
    const credentialLines = loggedLines.filter((line) => line.includes(`${email} / `));
    expect(credentialLines).toHaveLength(1);

    const printedPassword = credentialLines[0].split(' / ')[1].trim();
    // randomBytes(24) base64url-encoded: 32 URL-safe characters, no padding.
    expect(printedPassword).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const afterSeed = await identityDb.user.findUniqueOrThrow({ where: { email } });
    expect(afterSeed.role).toBe('admin');
    expect(afterSeed.mustChangePassword).toBe(true);
    // The strongest possible non-vacuous check: the value actually printed
    // is the value actually hashed and stored, not a decoy computed twice.
    await expect(compare(printedPassword, afterSeed.passwordHash)).resolves.toBe(true);
  });
});
