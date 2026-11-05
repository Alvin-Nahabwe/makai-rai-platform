import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `personal_platform_rows` (migration 20261105000000) trusts its user-id argument, as the other definer functions
 * trust their actor (ADR-0009, Definer functions): any identity-lane caller can read the platform rows of any
 * account it names. So it has one path in, pinned here (C4 EXP re-review M-1): the SQL function is named only by
 * `personalPlatformRows` (lib/data/definer.ts); that is called only by `personalExport` (lib/data/export.ts), with
 * the id it was given; and `personalExport` is called only by route 38, with the signed-in session's own id. A
 * second caller, above all one that takes an id from a request, fails here.
 */

const ROOTS = ['app', 'lib', 'components', 'scripts', 'prisma/seed.ts', 'proxy.ts', 'middleware.ts'].filter((p) => existsSync(p));
const CODE = /\.(ts|tsx|js|mjs|cjs)$/;

function filesUnder(paths: string[]): string[] {
  return paths.flatMap((p) => (statSync(p).isDirectory()
    ? filesUnder(readdirSync(p).filter((n) => n !== 'node_modules').map((n) => join(p, n)))
    : CODE.test(p) ? [p] : []));
}

/** `path:line` of each line that matches, comment-only lines left out. */
function grep(pattern: RegExp): string[] {
  return filesUnder(ROOTS).flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((text, i) => {
    const t = text.trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || !pattern.test(text) ? [] : [`${file}:${i + 1}`];
  }));
}
const filesOf = (hits: string[]) => [...new Set(hits.map((h) => h.replace(/:\d+$/, '')))].sort();

describe('personal_platform_rows has one caller (ADR-0009, NFR-PRIV-08)', () => {
  it('reads real files, so the pins are not vacuous', () => {
    expect(filesUnder(ROOTS).length).toBeGreaterThan(100);
  });

  it('NFR-PRIV-08 (C4 EXP re-review M-1): only lib/data/definer.ts names the SQL function', () => {
    expect(filesOf(grep(/personal_platform_rows\s*\(/))).toEqual(['lib/data/definer.ts']);
  });

  it('NFR-PRIV-08 (M-1): personalPlatformRows is defined in definer.ts and called once, by personalExport, with its own userId', () => {
    expect(filesOf(grep(/\bpersonalPlatformRows\b/))).toEqual(['lib/data/definer.ts', 'lib/data/export.ts']);
    const exportTs = readFileSync('lib/data/export.ts', 'utf8');
    expect(exportTs.match(/\bpersonalPlatformRows\(/g)).toHaveLength(1);
    expect(exportTs).toMatch(/\bpersonalPlatformRows\(userId\)/);
    // The call sits inside personalExport(userId), the next exported function after it being estimateTeamExport.
    const body = exportTs.slice(exportTs.indexOf('export async function personalExport(userId: string)'), exportTs.indexOf('export async function estimateTeamExport'));
    expect(body).toMatch(/\bpersonalPlatformRows\(userId\)/);
  });

  it('NFR-PRIV-08 (M-1): personalExport is called only by route 38, with the session\'s own id', () => {
    const calls = grep(/\bpersonalExport\(/).filter((h) => !h.startsWith('lib/data/export.ts:'));
    expect(filesOf(calls)).toEqual(['app/api/users/me/export/route.ts']);
    const route = readFileSync('app/api/users/me/export/route.ts', 'utf8');
    expect(route.match(/\bpersonalExport\(/g)).toHaveLength(1);
    expect(route).toMatch(/const identity = await requireIdentityForApi\(/);
    expect(route).toMatch(/\bpersonalExport\(identity\.userId\)/);
    // export.ts itself defines it and never calls it.
    expect(readFileSync('lib/data/export.ts', 'utf8').match(/\bpersonalExport\(/g)).toHaveLength(1);
  });
});
