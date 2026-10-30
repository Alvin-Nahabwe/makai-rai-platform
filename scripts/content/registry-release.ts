import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { computeVersionBundleHash } from '@/lib/content/bundleHash';
import { contentMigrationDir, parseContentMigrationDir, renderRegistryMigration } from '@/lib/content/registryMigration';
import { SEMVER_RE } from '@/lib/content/semver';
import { validateContentVersion } from '@/lib/content/validate';

/**
 * The registry migration of a content version, computed from a repository's files (NFR-MNT-07, SRS line 3344; SRS 9.5
 * step 8). `scripts/content/release-version.ts` writes what this returns, and CI's content test compares every committed
 * content migration with it. It lives under `scripts/` because it calls `computeVersionBundleHash` and reads computed
 * paths, which no route's module graph may hold (contract "Static read paths", finding SEC-01).
 *
 * Its output depends only on the version's files and on the migrations that sort before its own folder, so a
 * committed migration still equals a fresh generation after later migrations land: the stamp rule (a new folder sorts
 * after every migration) applies only while the folder does not exist yet, and only earlier folders' versions are
 * deprecated. The repository root is not written into the file.
 */

const STAMP_RE = /^\d{14}$/;
/**
 * A framework_versions INSERT of a migration: its column list and its first VALUES tuple. `ANY_INSERT_RE` finds every
 * INSERT into the table in any spelling (case, quotes, a schema), so an INSERT the first pattern cannot read, or one
 * that inserts more than one row, is a problem instead of a version left published.
 */
const INSERT_RE = /INSERT INTO "framework_versions"\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/g;
const ANY_INSERT_RE = /insert\s+into\s+(?:"?\w+"?\s*\.\s*)?"?framework_versions"?/gi;

const underscored = (semver: string): string => semver.replace(/[.-]/g, '_');

/** The semvers the INSERTs of one migration file register, read by column name; `null` when an INSERT cannot be read. */
function registeredSemvers(sql: string): string[] | null {
  const out: string[] = [];
  const matches = [...sql.matchAll(INSERT_RE)];
  if (matches.length !== [...sql.matchAll(ANY_INSERT_RE)].length) return null;
  for (const m of matches) {
    // A second row tuple, `), (`, anywhere after VALUES in the statement (a call such as now() is followed by `)` or `,`).
    const end = sql.indexOf(';', m.index);
    const statement = sql.slice(m.index, end === -1 ? undefined : end);
    if (/\)\s*,\s*\(/.test(statement.slice(statement.search(/VALUES/)))) return null;
    const columns = m[1].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const values = m[2].split(',').map((v) => v.trim());
    const at = columns.indexOf('semver');
    const literal = at >= 0 ? /^'([^']*)'$/.exec(values[at] ?? '') : null;
    if (literal === null) return null;
    out.push(literal[1]);
  }
  return out;
}

export function buildRegistryMigration(root: string, semver: string, stamp: string): { dir: string; sql: string; problems: string[] } {
  // Checked before any path is built from it: the semver names a directory and goes into SQL.
  if (!SEMVER_RE.test(semver)) return { dir: '', sql: '', problems: [`semver ${JSON.stringify(semver)} is not a content version`] };
  if (!STAMP_RE.test(stamp)) return { dir: '', sql: '', problems: [`stamp ${JSON.stringify(stamp)} is not 14 digits (YYYYMMDDHHMMSS)`] };
  const dir = contentMigrationDir(stamp, semver);
  const own = dir.slice('prisma/migrations/'.length);
  const problems: string[] = [];
  const contentDir = join(/*turbopackIgnore: true*/ root, 'data', 'content');
  const versionDir = join(/*turbopackIgnore: true*/ contentDir, semver);

  try {
    const index: unknown = JSON.parse(readFileSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ contentDir, 'index.json'), 'utf8'));
    const versions = typeof index === 'object' && index !== null ? (index as { versions?: unknown }).versions : undefined;
    if (!Array.isArray(versions) || !versions.includes(semver)) problems.push(`${semver} is not listed in data/content/index.json versions`);
  } catch (e) {
    problems.push(`data/content/index.json cannot be read as JSON (${(e as Error).message})`);
  }

  // Only a proposal that is not there at all is no proposal; one that is there but cannot be read is the check's problem.
  const proposal = join(/*turbopackIgnore: true*/ root, 'docs', 'content', `question-set-${semver}`, 'proposal.json');
  let proposalFile: string | null = proposal;
  try {
    statSync(/*turbopackIgnore: true*/ proposal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') proposalFile = null;
  }
  problems.push(...validateContentVersion(versionDir, { baselineDir: join(/*turbopackIgnore: true*/ root, 'data'), proposalFile, completeness: true }));

  const migrationsDir = join(/*turbopackIgnore: true*/ root, 'prisma', 'migrations');
  let folders: string[] = [];
  try {
    folders = readdirSync(/*turbopackIgnore: true*/ migrationsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (e) {
    problems.push(`prisma/migrations cannot be listed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
  }
  const others = folders.filter((d) => d !== own);
  for (const d of others) if (parseContentMigrationDir(d)?.underscoredSemver === underscored(semver)) problems.push(`prisma/migrations/${d} already registers ${semver}; remove it or run with its stamp`);
  // The order rule is for a new migration; a folder a crashed run left without its file is not one that has been written.
  if (!existsSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ migrationsDir, own, 'migration.sql'))) {
    const latest = others.at(-1);
    if (latest !== undefined && latest.slice(0, 14) >= stamp) problems.push(`stamp ${stamp} does not sort after every migration (the latest is ${latest})`);
  }

  const deprecate: string[] = [];
  for (const d of others.filter((d) => d < own)) {
    const file = join(/*turbopackIgnore: true*/ migrationsDir, d, 'migration.sql');
    let sql: string;
    try {
      sql = readFileSync(/*turbopackIgnore: true*/ file, 'utf8');
    } catch (e) {
      problems.push(`prisma/migrations/${d}/migration.sql cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
      continue;
    }
    const semvers = registeredSemvers(sql);
    if (semvers === null) problems.push(`prisma/migrations/${d}/migration.sql has a framework_versions INSERT whose semver cannot be read`);
    else {
      for (const v of semvers) {
        if (v === semver) problems.push(`prisma/migrations/${d} already registers ${semver}`);
        else if (!deprecate.includes(v)) deprecate.push(v);
      }
    }
  }

  if (problems.length > 0) return { dir, sql: '', problems };

  // validateContentVersion has checked every record's `at` (an ISO time with a zone), so each parses.
  const records = (JSON.parse(readFileSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ versionDir, 'signoffs.json'), 'utf8')) as { records: Array<{ at: string }> }).records;
  const publishedAt = new Date(Math.max(...records.map((r) => Date.parse(r.at)))).toISOString();
  const sql = renderRegistryMigration({
    semver,
    contentHash: computeVersionBundleHash(versionDir),
    publishedAt,
    deprecate,
    command: `npx tsx scripts/content/release-version.ts ${semver} ${stamp}`,
  });
  return { dir, sql, problems };
}
