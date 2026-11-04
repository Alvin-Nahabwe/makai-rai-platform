import { describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { can, GRANTS, type Action } from '../../lib/authz/policy';
import { ALL_ORG_ROLES } from '../../lib/authz/roles';

/**
 * NFR-SEC-03 and FR-AUTHZ-01: the whole permission matrix of SRS lines 629-646, written out by hand from the
 * SRS (a generated expectation that mirrored GRANTS would assert nothing), legacy rows included, against
 * every action GRANTS holds. `project:delete` is not in the SRS table; it keeps its v0.5.0 owner and admin
 * grants (00-contract.md, Policy, owner question 3).
 */

const ALL: OrgRole[] = ['owner', 'admin', 'assessor', 'reviewer', 'viewer'];
const OAA: OrgRole[] = ['owner', 'admin', 'assessor'];
const OA: OrgRole[] = ['owner', 'admin'];

const MATRIX: Record<Action, OrgRole[]> = {
  'org:read': ALL, 'project:read': ALL, 'record:read': ALL, 'member:read': ALL, 'member:leave': ALL,
  'project:create': OAA, 'project:update': OAA, 'project:archive': OA, 'project:delete': OA,
  'decision:write': OAA, 'evidence:create': OAA, 'decision:withdraw': OAA,
  'finding:raise': [...OAA, 'reviewer'], 'finding:reopen': OAA, 'mitigation:write': OAA,
  'finding:withdraw': [...OAA, 'reviewer'], 'risk:accept': OA, 'review:open': OAA,
  'review:seal': [...OA, 'reviewer'], 'document:generate': [...OA, 'reviewer'],
  'document:withdraw': OA, 'team:export': OA,
  'member:invite': OA, 'member:role': OA, 'member:remove': OA,
  'member:grant_owner': ['owner'], 'member:revoke_owner': ['owner'],
};

describe('the permission matrix over can() (FR-AUTHZ-01, NFR-SEC-03)', () => {
  it('NFR-SEC-03 FR-AUTHZ-01: every action in GRANTS for every role equals the SRS matrix', () => {
    expect(ALL_ORG_ROLES).toEqual(ALL);
    expect(new Set(Object.values(GRANTS).flat())).toEqual(new Set(Object.keys(MATRIX)));
    for (const [action, allowed] of Object.entries(MATRIX)) for (const role of ALL_ORG_ROLES)
      expect({ action, role, allowed: can(role, action as Action) }).toEqual({ action, role, allowed: allowed.includes(role) });
  });

  it('NFR-SEC-03: GRANTS cannot be changed at run time, so no importer can widen a role', () => {
    expect(Object.isFrozen(GRANTS)).toBe(true);
    for (const role of ALL_ORG_ROLES) expect({ role, frozen: Object.isFrozen(GRANTS[role]) }).toEqual({ role, frozen: true });
    const before = can('viewer', 'decision:write');
    expect(() => { (GRANTS as Record<OrgRole, Action[]>).viewer = ['decision:write']; }).toThrow(TypeError);
    expect(() => { (GRANTS.viewer as Action[]).push('decision:write'); }).toThrow(TypeError);
    expect(can('viewer', 'decision:write')).toBe(before);
  });
});
