import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDb, resetDb } from '../helpers/db';
import { main } from '../../prisma/seed';

/**
 * FR-ORG-04 and NFR-SEC-19 (SRS lines 553, 3003): the seed makes the one platform administrator, with no
 * organisation and no membership (prisma/seed.ts, unit/k0b), and the database refuses a second one through
 * the users_one_platform_admin trigger of the step-8 migration, so the seed's promote branch cannot make one.
 */

const ORIGINAL = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD };
const STRONG = 'a-strong-fixture-admin-password-7c1d';

afterEach(() => {
  for (const [key, value] of [['ADMIN_EMAIL', ORIGINAL.email], ['ADMIN_PASSWORD', ORIGINAL.password]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe('the seed and the one platform administrator', () => {
  it('NFR-SEC-19 FR-ORG-04: the seed makes one administrator with no membership and refuses a second', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await resetDb();
    process.env.ADMIN_EMAIL = 'admin@fixture.test'; process.env.ADMIN_PASSWORD = STRONG;
    await main();
    const admin = await testDb.user.findUniqueOrThrow({ where: { email: 'admin@fixture.test' } });
    expect(admin.role).toBe('admin');
    expect(await testDb.membership.count({ where: { userId: admin.id } })).toBe(0);
    expect(await testDb.organization.count()).toBe(0);
    await testDb.user.create({ data: { email: 'second@fixture.test', name: 'S', passwordHash: 'x' } });
    process.env.ADMIN_EMAIL = 'second@fixture.test';
    await expect(main()).rejects.toThrow(/one platform administrator/i);
    expect(await testDb.user.count({ where: { role: 'admin' } })).toBe(1);
    expect((await testDb.user.findUniqueOrThrow({ where: { email: 'second@fixture.test' } })).role).toBe('assessor');
  });
});
