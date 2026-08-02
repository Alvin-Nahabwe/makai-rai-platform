import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { assertIsTestDatabase } from './db';

// Any real, reachable database whose name does not end in "_test". The
// Postgres system database `postgres` always exists on this server and is
// never truncated by anything in this suite, so pointing at it here proves
// the guard fires without risking real data — this test must never call
// resetDb() or issue a TRUNCATE.
const nonTestUrl = (process.env.DATABASE_URL ?? '').replace(/\/[^/]+$/, '/postgres');

describe('assertIsTestDatabase', () => {
  const nonTestDb = new PrismaClient({
    adapter: new PrismaPg(new Pool({ connectionString: nonTestUrl })),
  });

  afterAll(async () => {
    await nonTestDb.$disconnect();
  });

  it('throws when the connected database name does not end in "_test"', async () => {
    await expect(assertIsTestDatabase(nonTestDb)).rejects.toThrow(/not a test database|"_test"/);
  });
});
