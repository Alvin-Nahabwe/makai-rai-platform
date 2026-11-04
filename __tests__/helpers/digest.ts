import { APPEND_ONLY_TABLES } from '../../lib/data/appendOnly';
import { testDb } from './db';

/**
 * An md5 of every row of every public table that may be updated (projects, memberships, users and the rest:
 * every table but the append-only ones, `_prisma_migrations` and `framework_versions`), keyed by table. The
 * access tests compare it before and after a refused call: a write that renames or re-roles a row changes no
 * row count (`rowCounts`, __tests__/helpers/routeDriver.ts), only this. The list of tables is read from
 * pg_tables on every call, so a new table is covered when its migration lands.
 */
export async function mutableDigest(): Promise<Record<string, string>> {
  const tables = (await testDb.$queryRaw<{ t: string }[]>`SELECT tablename::text AS t FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'framework_versions') ORDER BY 1`)
    .map((r) => r.t).filter((t) => !APPEND_ONLY_TABLES.includes(t));
  const sql = `SELECT ${tables.map((t) => `(SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x::text), '')) FROM "${t}" x) AS "${t}"`).join(', ')}`;
  return (await testDb.$queryRawUnsafe<Record<string, string>[]>(sql))[0];
}
