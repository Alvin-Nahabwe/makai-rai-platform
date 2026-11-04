import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { NON_ACTION_ROUTES } from '../../lib/authz/routeActions';
import { requireOrgContextFor } from '../../lib/auth/context';
import { NotFoundError } from '../../lib/data/tenant';
import { testDb, resetDb } from '../helpers/db';
import { buildOrg } from '../helpers/recordFixture';

/**
 * FR-ORG-04 (SRS line 553): organisations exist only through the MAK-AI administrator, so the
 * signed-in user's creation route, its page, its per-user cap and the seed's organisation name are
 * gone. The grep walks the file system, not `git grep`, so a file deleted but not yet committed
 * cannot hide or reappear.
 */

/** Paths a literal may still appear in, each with its reason. */
const EXEMPT: ReadonlyArray<{ prefix: string; reason: string }> = [
  // Applied migrations are immutable (their checksum is compared with the database's,
  // schema-matches-migrations.test.ts); a comment in an old migration names the removed function.
  { prefix: 'prisma/migrations/', reason: 'applied migrations are never edited' },
  // lib/rate-limit.ts belongs to K0b and ACC-b (units/ORG.md Task 1); its comment naming the old
  // setting goes as a register row, not an ORG edit.
  { prefix: 'lib/rate-limit.ts', reason: 'stale comment in a file ORG does not own; register row' },
];

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return [root];
  return readdirSync(root, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(root, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' || d.name === '.next' ? [] : filesUnder(p);
    return [p];
  });
}

function grepLiteral(needles: readonly string[], roots: readonly string[]): string[] {
  const hits: string[] = [];
  const scanned = roots.flatMap(filesUnder).filter((f) => !EXEMPT.some((e) => f.startsWith(e.prefix)));
  expect(scanned.length, 'the scan read no file, so it would pass vacuously').toBeGreaterThan(100);
  for (const file of scanned) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const needle of needles) if (line.includes(needle)) hits.push(`${file}:${i + 1}: ${needle}`);
    });
  }
  return hits;
}

describe('user-created organisations are gone', () => {
  it('FR-ORG-04: POST /api/v1/orgs answers 404 and creates nothing', () => {
    expect(existsSync('app/api/v1/orgs/route.ts')).toBe(false);
    expect(existsSync('app/(authenticated)/orgs/new/page.tsx')).toBe(false);
    expect(existsSync('app/(authenticated)/orgs/new/layout.tsx')).toBe(false);
    expect(NON_ACTION_ROUTES).not.toContain('app/api/v1/orgs/route.ts');
  });

  it('FR-ORG-04: no user-created organisation path or setting remains', () => {
    expect(grepLiteral(['createOrgForUser', 'ORG_LIMIT_PER_USER', 'OrgLimitError', 'Create a new organization', '/orgs/new', 'ADMIN_ORG_NAME'],
      ['app', 'lib', 'components', 'docker', 'prisma', '.env.example', '.github'])).toEqual([]);
  });

  it('FR-ORG-04 FR-RM-01: the no-score crawl keeps no exception for the deleted /orgs/new page', () => {
    const src = readFileSync('e2e/no-score-crawl.spec.ts', 'utf8');
    expect(src).not.toContain('KNOWN_DEAD_LINKS');
    expect(src).not.toContain('orgs/new');                 // neither the pattern nor the comment that explained it
  });

  it('FR-ORG-04 FR-PUB-01: the claims crawl keeps no exception for the deleted /orgs/new page', () => {
    const src = readFileSync('e2e/claims-crawl.spec.ts', 'utf8');
    expect(src).not.toContain('KNOWN_DEAD_LINKS');
    expect(src).not.toContain('orgs/new');
  });
});

describe('an archived organisation', () => {
  beforeEach(resetDb);

  it('FR-ORG-04: an archived organisation (A-6 shape after step 0) gives its assessor S-31', async () => {
    const fx = await buildOrg();
    await expect(requireOrgContextFor(fx.members.assessor.userId, fx.org.slug, 'org:read')).resolves.toMatchObject({ orgId: fx.org.id });
    await testDb.organization.update({ where: { id: fx.org.id }, data: { deletedAt: new Date() } });
    await expect(requireOrgContextFor(fx.members.assessor.userId, fx.org.slug, 'org:read')).rejects.toBeInstanceOf(NotFoundError);
  });
});
