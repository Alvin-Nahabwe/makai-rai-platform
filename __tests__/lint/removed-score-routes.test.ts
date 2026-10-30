import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import * as routeActions from '@/lib/authz/routeActions';
import { RATE_LIMITS } from '@/lib/rate-limit';

/**
 * RM (score removal), FR-RM-03: the six route files that created, saved,
 * completed or rendered scored assessments (and the unused remediation table)
 * are deleted, not emptied. Next 16 answers 405, not 404, for a method a
 * surviving route file does not export, so "the file is gone" is the only
 * state that answers 404 for every method.
 */

const REMOVED = [
  'assessments/route.ts',
  'assessments/[id]/route.ts',
  'assessments/[id]/complete/route.ts',
  'assessments/[id]/remediation/route.ts',
  'assessments/[id]/evidence/route.ts',
  'reports/[id]/pdf/route.ts',
].map((p) => `app/api/v1/orgs/[slug]/${p}`);

const { ROUTE_ACTIONS } = routeActions;

/** Every .ts/.tsx/.js/.mjs file under `roots`, as a repo-relative path. */
function sourceFiles(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(full);
    }
  };
  // A missing root throws (ENOENT) rather than being skipped, so a renamed
  // directory cannot turn the scan into a pass over nothing.
  for (const r of roots) walk(r);
  return out.sort();
}

/** Source with comments removed, so a sentence about a write is not a write. */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

describe('FR-RM-03: the scored routes are gone', () => {
  it('FR-RM-03 NFR-MNT-01: the route table loses exactly the six scored keys', () => {
    for (const f of REMOVED) {
      expect(existsSync(f), f).toBe(false);
      expect(ROUTE_ACTIONS).not.toHaveProperty([f]);
    }
    expect(Object.keys(ROUTE_ACTIONS).filter((k) => /\/(assessments|reports)\//.test(k))).toEqual([]);
  });

  it('FR-RM-03 NFR-MNT-04: no UNKEYED_WRITES entry is left for a removed route', () => {
    const lists = routeActions as { UNKEYED_WRITES?: Record<string, { reason: string }> };
    const left = Object.entries(lists.UNKEYED_WRITES ?? {}).filter(
      ([k, v]) => /\/(assessments|reports)\//.test(k) || v.reason === 'removed by RM',
    );
    // Before unit/k0b merges the list does not exist and this holds trivially.
    expect(left).toEqual([]);
  });

  it('FR-RM-03 NFR-MNT-01: the v0.5.0 matrix names none of the six removed files', () => {
    const src = readFileSync('__tests__/integration/permission-matrix.test.ts', 'utf8');
    // SUCCESS_STATUS rows and, after unit/k0b, V050_ROUTE_FILES entries.
    for (const f of REMOVED) expect(src, f).not.toContain(`'${f}`);
  });

  it('FR-RM-03: no rate-limit key names assessments, and the project evidence key remains', () => {
    expect(Object.keys(RATE_LIMITS).filter((k) => k.includes('assessments'))).toEqual([]);
    // K0b adds the project evidence key together with UNKEYED_WRITES, so the
    // presence of the second is the signal that the first must exist.
    if ('UNKEYED_WRITES' in routeActions) {
      expect(RATE_LIMITS).toHaveProperty(['POST:/api/v1/orgs/*/projects/*/evidence']);
    }
  });

  it('FR-RM-03 NFR-MNT-04: nothing writes assessments or remediation_items', () => {
    const delegateWrite =
      /\.(assessment|remediationItem)\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\(/;
    const rawWrite =
      /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+("?public"?\.)?"?(assessments|remediation_items)\b/i;
    const nestedWrite =
      /\b(assessments|remediationItems)\s*:\s*\{\s*(create|createMany|connectOrCreate|update|updateMany|upsert|delete|deleteMany|set)\b/;
    const hits = sourceFiles(['app', 'lib', 'components']).filter((f) => {
      const src = withoutComments(readFileSync(f, 'utf8'));
      return delegateWrite.test(src) || rawWrite.test(src) || nestedWrite.test(src);
    });
    expect(hits).toEqual([]);
  });

  it('FR-MEM-04 FR-MEM-05 (kept): permission-matrix still exercises leave and the last owner', () => {
    const src = readFileSync('__tests__/integration/permission-matrix.test.ts', 'utf8');
    expect(src).toContain("'app/api/v1/orgs/[slug]/members/leave/route.ts::POST'");
    expect(src).toMatch(/last-owner/);
  });
});
