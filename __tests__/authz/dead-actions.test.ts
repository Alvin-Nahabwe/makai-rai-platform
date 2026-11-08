import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GRANTS, type Action } from '../../lib/authz/policy';
import { ROUTE_ACTIONS, REMOVED_METHODS } from '../../lib/authz/routeActions';

/**
 * FR-AUTHZ-02 and NFR-MNT-04 (SRS lines 647-651, 3326-3330): no declared permission is checked by
 * nothing. Every action in GRANTS is either the action of a ROUTE_ACTIONS entry or the action of a gate
 * call (`assertCan(ctx, '<action>')` or `requireOrgContext*(..., '<action>')`) somewhere in app/ or lib/,
 * read from disk on every run; the eleven actions FR-AUTHZ-02 names are gone from GRANTS and from every
 * source file; and the evidence DELETE is a removed method that answers 404 (K0b's test in
 * evidence-download.test.ts drives it).
 */

/**
 * The behaviour case of Z9 stands in for two things: the memberships a user holds (no database here) and, for one
 * role at a time, a policy that lacks record:read (no real role lacks it, and GRANTS is frozen). Every other
 * answer of can() is the real one, and GRANTS above is the real table.
 */
const fake = vi.hoisted(() => ({
  memberships: [] as Array<{ orgId: string; role: string; org: { id: string; slug: string } }>,
  withoutRecordRead: null as string | null,
}));
vi.mock('../../lib/data/preauth', () => ({ membershipsForUser: async () => fake.memberships, orgBySlug: async () => null }));
vi.mock('../../lib/authz/policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/authz/policy')>();
  return { ...actual, can: (role: string, action: string) =>
    (action === 'record:read' && role === fake.withoutRecordRead ? false : actual.can(role as never, action as never)) };
});

const DEAD = ['org:update', 'org:delete', 'assessment:read', 'assessment:create', 'assessment:update', 'assessment:delete',
  'assessment:respond', 'assessment:complete', 'remediation:update', 'evidence:read', 'evidence:delete'];

/** A gate call naming its action as a string literal: `assertCan(ctx, 'a:b')`, `requireOrgContext(slug, 'a:b')`,
 * `requireOrgContextWithIdentity(slug, 'a:b')`, `requireOrgContextFor(userId, slug, 'a:b')`. */
const GATE_CALL = /(assertCan\(\s*[\w.]+\s*,|requireOrgContext(?:For|WithIdentity)?\(\s*[^,]+,(?:\s*[^,]+,)?)\s*'([a-z_]+:[a-z_]+)'/g;

/**
 * The one action GRANTS holds ahead of its check. K0b added `member:role` (owner, admin) to GRANTS with the
 * v1 actions, but kept the members PATCH entry of ROUTE_ACTIONS on `member:grant_owner`; MEM changes that entry
 * to `member:role` in the commit that rewrites the handler (00-contract.md, revocation table, row "Members
 * PATCH becomes the role change of row 26"). The allowance holds only while that entry still reads
 * `member:grant_owner`, so it ends by itself when MEM's change lands and cannot cover any other action.
 */
const MEMBERS_PATCH = 'app/api/v1/orgs/[slug]/members/[userId]/route.ts';
function checkedAheadOfProducer(action: string): boolean {
  return action === 'member:role' && ROUTE_ACTIONS[MEMBERS_PATCH]?.PATCH === 'member:grant_owner';
}

/** Every .ts and .tsx file under the roots (a root may be a file), read from disk. */
function sourceFiles(roots: string[]): string[] {
  const walk = (p: string): string[] => {
    if (statSync(p).isDirectory()) return readdirSync(p).flatMap((name) => walk(join(p, name)));
    return /\.tsx?$/.test(p) ? [p] : [];
  };
  return roots.flatMap(walk);
}

const read = (f: string) => readFileSync(f, 'utf8');
/** The file without its comments, so a comment that quotes a gate call does not count as one. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** `file:line` for each occurrence of one of `literals` as a quoted string ('x' or "x") in a file under the roots. */
function grepLiteral(literals: string[], roots: string[]): string[] {
  const hits: string[] = [];
  for (const f of sourceFiles(roots)) {
    read(f).split('\n').forEach((line, i) => {
      if (literals.some((l) => line.includes(`'${l}'`) || line.includes(`"${l}"`))) hits.push(`${f}:${i + 1}`);
    });
  }
  return hits;
}

describe('dead actions (FR-AUTHZ-02, NFR-MNT-04)', () => {
  it('FR-AUTHZ-02 NFR-MNT-04: every action in GRANTS is checked somewhere and no dead action remains', () => {
    const granted = new Set<string>(Object.values(GRANTS).flat());
    const declared = new Set<string>(Object.values(ROUTE_ACTIONS).flatMap((m) => Object.values(m)));
    const called = new Set(sourceFiles(['app', 'lib']).flatMap((f) => [...code(f).matchAll(GATE_CALL)].map((x) => x[2])));
    expect(called.size).toBeGreaterThan(5);   // the reading finds gate calls at all (org:read is only called, never declared)
    expect([...granted].filter((a) => !declared.has(a) && !called.has(a) && !checkedAheadOfProducer(a)).sort()).toEqual([]);
    for (const a of DEAD) expect({ a, granted: granted.has(a) }).toEqual({ a, granted: false });
    expect(grepLiteral(DEAD, ['app', 'lib', 'components', 'proxy.ts'])).toEqual([]);   // no source file names a dead action
    expect(REMOVED_METHODS['app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts']).toEqual(['DELETE']);
  });

  it('FR-AUTHZ-02: the allowance for member:role covers no other action', () => {
    const others = (Object.values(GRANTS).flat() as Action[]).filter((a) => a !== 'member:role');
    expect(others.filter(checkedAheadOfProducer)).toEqual([]);
  });

  it('FR-AUTHZ-02: orgContextsForUser filters on record:read', () => {
    expect(code('lib/auth/context.ts')).toMatch(/can\(m\.role, 'record:read'\)/);   // code, not a comment that quotes it
  });

  it('FR-AUTHZ-02: orgContextsForUser offers an organisation only where the member\'s role holds record:read', async () => {
    const { orgContextsForUser } = await import('../../lib/auth/context');
    fake.memberships = [
      { orgId: 'org-a', role: 'viewer', org: { id: 'org-a', slug: 'a' } },
      { orgId: 'org-b', role: 'owner', org: { id: 'org-b', slug: 'b' } },
    ];
    fake.withoutRecordRead = null;
    expect((await orgContextsForUser('u-1')).map((c) => c.orgId)).toEqual(['org-a', 'org-b']);
    fake.withoutRecordRead = 'viewer';   // a member of A whose role lacks record:read
    expect((await orgContextsForUser('u-1')).map((c) => c.orgId)).toEqual(['org-b']);
    fake.withoutRecordRead = null;
  });
});
