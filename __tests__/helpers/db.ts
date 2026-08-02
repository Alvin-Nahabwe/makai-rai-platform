import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

export const testDb = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL })),
});

/**
 * TRUNCATEs every public table. Guarded by the database's OWN name rather than
 * by the URL string: importing this helper outside the vitest runner would
 * otherwise inherit .env's DATABASE_URL and wipe the dev database.
 */
export async function resetDb(): Promise<void> {
  const [{ current_database: db }] =
    await testDb.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
  if (db !== 'makrai_test') {
    throw new Error(`Refusing to reset database "${db}" — resetDb() only runs against makrai_test`);
  }
  const tables = await testDb.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await testDb.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
