/**
 * The one command that writes a content version's registry migration (NFR-MNT-07, SRS line 3344), run after the last
 * content edit and the owner's last sign-off:
 *
 *   npx tsx scripts/content/release-version.ts <semver> <stamp> [--root <repository>]
 *
 * for 5.0.0: `npx tsx scripts/content/release-version.ts 5.0.0 20261031230000`. It checks the version complete and
 * signed (`validateContentVersion` with completeness) and the stamp, then writes
 * `prisma/migrations/<stamp>_content_<semver with _>/migration.sql`, which deprecates every earlier published version
 * and inserts the `fv_<semver>` row with the computed bundle hash, and prints the file and the hash. On any problem it
 * prints each one and exits 1 having written nothing. Running it again on the same content leaves the same file; a
 * file already there that differs from this generation is never overwritten, because the content or its sign-offs
 * changed after the migration was written, and a merged migration may already have run. `--root` (default: the
 * current directory) is for tests.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildRegistryMigration } from './registry-release';

const USAGE = [
  'usage: npx tsx scripts/content/release-version.ts <semver> <stamp> [--root <repository>]',
  'Run it after the last content edit and the last sign-off. It never overwrites a migration.sql that differs from',
  'what it would write now: after a sign-off edit, delete the unmerged migration folder or make a new content version.',
].join('\n');

function main(argv: readonly string[]): number {
  const positional: string[] = [];
  let root: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      const value = argv[++i];
      // An empty value (an unset shell variable) would resolve to the current directory and write there.
      if (value === undefined || value === '') {
        console.error(`--root needs a directory\n${USAGE}`);
        return 1;
      }
      if (root !== null) {
        console.error(`--root given twice\n${USAGE}`);
        return 1;
      }
      root = resolve(value);
    } else if (argv[i].startsWith('-')) {
      console.error(`unknown option ${argv[i]}\n${USAGE}`);
      return 1;
    } else positional.push(argv[i]);
  }
  if (positional.length !== 2) {
    console.error(USAGE);
    return 1;
  }
  const [semver, stamp] = positional;
  root ??= process.cwd();

  const r = buildRegistryMigration(root, semver, stamp);
  if (r.problems.length > 0) {
    for (const p of r.problems) console.error(p);
    console.error(`${r.problems.length} problem(s); nothing written.`);
    return 1;
  }
  const file = join(root, r.dir, 'migration.sql');
  if (existsSync(file) && readFileSync(file, 'utf8') !== r.sql) {
    console.error(`${r.dir}/migration.sql already exists and differs from this generation: the content or its sign-offs changed after it was written.`);
    console.error('If that folder is not merged yet, delete it and run the command again; if it is, the change needs a new content version.');
    console.error('Nothing written.');
    return 1;
  }
  // Written beside the file and renamed over it, so a failed write never leaves a truncated migration.sql.
  mkdirSync(join(root, r.dir), { recursive: true });
  const partial = `${file}.partial`;
  try {
    writeFileSync(partial, r.sql);
    renameSync(partial, file);
  } finally {
    rmSync(partial, { force: true });
  }
  console.log(`wrote ${r.dir}/migration.sql`);
  // The hash is printed from the SQL just written, so what is shown is what the migration carries.
  console.log(`contentHash ${/'([0-9a-f]{64})'/.exec(r.sql)?.[1]}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
