import { describe, it, expect } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { can, type Action } from '@/lib/authz/policy';

const ALL_ORG_ROLES: OrgRole[] = ['owner', 'admin', 'assessor', 'reviewer', 'viewer'];

/** The v1 rows of FR-AUTHZ-01's matrix, SRS lines 631-646, one action per entry (written out, not generated). */
const MATRIX: Record<string, OrgRole[]> = {
  'record:read': ['owner', 'admin', 'assessor', 'reviewer', 'viewer'],
  'decision:write': ['owner', 'admin', 'assessor'],
  'decision:withdraw': ['owner', 'admin', 'assessor'],
  'finding:raise': ['owner', 'admin', 'assessor', 'reviewer'],
  'finding:reopen': ['owner', 'admin', 'assessor'],
  'mitigation:write': ['owner', 'admin', 'assessor'],
  'finding:withdraw': ['owner', 'admin', 'assessor', 'reviewer'],
  'risk:accept': ['owner', 'admin'],
  'review:open': ['owner', 'admin', 'assessor'],
  'review:seal': ['owner', 'admin', 'reviewer'],
  'document:generate': ['owner', 'admin', 'reviewer'],
  'document:withdraw': ['owner', 'admin'],
  'team:export': ['owner', 'admin'],
  'project:archive': ['owner', 'admin'],
  'member:role': ['owner', 'admin'],
  'evidence:create': ['owner', 'admin', 'assessor'],
};

describe('v1 GRANTS', () => {
  it('FR-AUTHZ-01 (transcription): v1 GRANTS rows equal the SRS matrix', () => {
    for (const [action, allowed] of Object.entries(MATRIX)) {
      for (const role of ALL_ORG_ROLES) {
        expect({ action, role, allowed: can(role, action as Action) }).toEqual({ action, role, allowed: allowed.includes(role) });
      }
    }
  });

  it('FR-AUTHZ-01: an unknown action is denied to every role, the reviewer records no decision, and the viewer only reads', () => {
    for (const role of ALL_ORG_ROLES) expect(can(role, 'record:erase' as Action), role).toBe(false);
    // the reviewer records no decision (SRS 2.3 call: reviewing stays separate from doing)
    for (const a of ['decision:write', 'decision:withdraw', 'mitigation:write', 'finding:reopen', 'review:open', 'evidence:create'] as Action[])
      expect(can('reviewer', a), a).toBe(false);
    // the viewer reads and nothing else of the v1 rows
    expect(ALL_ORG_ROLES.filter((r) => can(r, 'record:read'))).toEqual(ALL_ORG_ROLES);
    for (const a of Object.keys(MATRIX).filter((k) => k !== 'record:read')) expect(can('viewer', a as Action), a).toBe(false);
  });

  it('FR-AUTHZ-01: project:delete keeps its owner and admin grants, which the matrix does not list (owner question 3)', () => {
    expect(ALL_ORG_ROLES.filter((r) => can(r, 'project:delete'))).toEqual(['owner', 'admin']);
  });
});
