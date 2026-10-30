import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { testDb } from '../helpers/db';
import { colourlessEnv, stripAnsi } from '../helpers/spawnText';

/**
 * NFR-MNT-01 (C4 CR-2): prisma/schema.prisma describes exactly what prisma/migrations builds, so
 * the generated client's types and `prisma migrate dev` agree with the database.
 *
 * `prisma migrate diff --from-migrations` needs a shadow database; this Prisma takes the
 * equivalent from the migrated test database (`--from-config-datasource`), after checking that
 * the database holds exactly the migrations on disk, each finished. Exit code 0 is no difference,
 * 2 a difference (`--exit-code`). The child runs with NO_COLOR=1 and its output is stripped of
 * ANSI escapes before it is shown (C4 item 12).
 */

describe('schema.prisma matches the migrations (C4 CR-2)', () => {
  it('NFR-MNT-01: the test database holds exactly the migrations on disk', async () => {
    const onDisk = readdirSync('prisma/migrations', { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const applied = (await testDb.$queryRaw<{ name: string }[]>`
      SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1`).map((r) => r.name);
    expect(applied).toEqual(onDisk);
  });

  it('NFR-MNT-01: prisma migrate diff from the migrated database to schema.prisma finds no difference', () => {
    const r = spawnSync('npx', ['prisma', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], {
      env: colourlessEnv(), encoding: 'utf8', timeout: 120_000,
    });
    const out = stripAnsi(`${r.stdout}\n${r.stderr}`).split('\n').filter((l) => /^\s*\[|Error/.test(l)).join('\n');
    expect({ status: r.status, out }).toEqual({ status: 0, out: '' });
  }, 150_000);
});
