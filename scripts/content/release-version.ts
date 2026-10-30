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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { computeVersionBundleHash } from '@/lib/content/bundleHash';
import { buildRegistryMigration } from './registry-release';

const USAGE = 'usage: npx tsx scripts/content/release-version.ts <semver> <stamp> [--root <repository>]';

function main(argv: readonly string[]): number {
  const positional: string[] = [];
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && i + 1 < argv.length) root = resolve(argv[++i]);
    else if (argv[i].startsWith('-')) {
      console.error(`unknown option ${argv[i]}\n${USAGE}`);
      return 1;
    } else positional.push(argv[i]);
  }
  if (positional.length !== 2) {
    console.error(USAGE);
    return 1;
  }
  const [semver, stamp] = positional;

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
  mkdirSync(join(root, r.dir), { recursive: true });
  writeFileSync(file, r.sql);
  console.log(`wrote ${r.dir}/migration.sql`);
  console.log(`contentHash ${computeVersionBundleHash(join(root, 'data', 'content', semver))}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
