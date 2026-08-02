import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

export const testDb = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL })),
});

/**
 * Guard against resetDb() (or anything else that TRUNCATEs) running against a
 * non-test database. Uses `SELECT current_database()` rather than parsing the
 * connection string, since the string can be assembled several ways and can
 * lie about which database the client actually landed on; the server's own
 * report is authoritative regardless of how the client was configured.
 *
 * Exported (and taking a client rather than closing over `testDb`) so it can
 * be exercised directly against a client pointed at a real, non-test database
 * without ever reaching the TRUNCATE in resetDb().
 */
export async function assertIsTestDatabase(
  client: Pick<PrismaClient, '$queryRaw'>,
): Promise<string> {
  const [{ current_database: dbName }] = await client.$queryRaw<
    { current_database: string }[]
  >`SELECT current_database()`;
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to reset database "${dbName}": its name does not end in "_test". ` +
        `resetDb() truncates every table in the connected database — this guard ` +
        `exists to prevent it from doing that to a real (dev/prod) database when ` +
        `DATABASE_URL points somewhere unexpected.`,
    );
  }
  return dbName;
}

/** Truncate every table except Prisma's migration ledger. */
export async function resetDb(): Promise<void> {
  await assertIsTestDatabase(testDb);
  const rows = await testDb.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await testDb.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
