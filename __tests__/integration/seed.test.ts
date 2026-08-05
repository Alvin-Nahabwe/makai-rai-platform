import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('prisma/seed.ts main() — platform admin bootstrap', () => {
  beforeEach(resetDb);
  afterEach(() => {
    if (ORIGINAL_ADMIN_EMAIL === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = ORIGINAL_ADMIN_EMAIL;
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
