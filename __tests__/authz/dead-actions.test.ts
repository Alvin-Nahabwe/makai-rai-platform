import { describe, expect, it } from 'vitest';
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
    const called = new Set(sourceFiles(['app', 'lib']).flatMap((f) => [...read(f).matchAll(GATE_CALL)].map((x) => x[2])));
    expect(called.size).toBeGreaterThan(5);   // the reading finds gate calls at all (org:read is only called, never declared)
    expect([...granted].filter((a) => !declared.has(a) && !called.has(a) && !checkedAheadOfProducer(a)).sort()).toEqual([]);
    for (const a of DEAD) expect({ a, granted: granted.has(a) }).toEqual({ a, granted: false });
    expect(grepLiteral(DEAD, ['app', 'lib', 'components', 'proxy.ts'])).toEqual([]);   // no source file names a dead action
    expect(REMOVED_METHODS['app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts']).toEqual(['DELETE']);
  });

  it('FR-AUTHZ-02: the allowance for member:role covers that one action and only while MEM has not changed the members PATCH', () => {
    const others = (Object.values(GRANTS).flat() as Action[]).filter((a) => a !== 'member:role');
    expect(others.filter(checkedAheadOfProducer)).toEqual([]);
    expect(checkedAheadOfProducer('member:role')).toBe(ROUTE_ACTIONS[MEMBERS_PATCH]?.PATCH === 'member:grant_owner');
  });

  it('FR-AUTHZ-02: orgContextsForUser filters on record:read', () => {
    expect(read('lib/auth/context.ts')).toMatch(/can\(m\.role, 'record:read'\)/);
  });
});
