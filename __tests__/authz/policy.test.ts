import { describe, expect, it } from 'vitest';
import { can, type Action } from '../../lib/authz/policy';
import type { OrgRole } from '@prisma/client';

const ROLES: OrgRole[] = ['owner', 'admin', 'assessor', 'reviewer', 'viewer'];

// The full intended matrix, written out. A generated expectation that mirrors
// the implementation would assert nothing.
const MATRIX: Record<Action, OrgRole[]> = {
  'project:read':      ['owner', 'admin', 'assessor', 'reviewer', 'viewer'],
  'project:create':    ['owner', 'admin', 'assessor'],
  'project:update':    ['owner', 'admin', 'assessor'],
  'project:delete':    ['owner', 'admin'],
  'assessment:read':   ['owner', 'admin', 'assessor', 'reviewer', 'viewer'],
  'assessment:create': ['owner', 'admin', 'assessor'],
  'assessment:update': ['owner', 'admin', 'assessor'],
  'assessment:delete': ['owner', 'admin'],
  'member:read':       ['owner', 'admin', 'assessor', 'reviewer', 'viewer'],
  'member:invite':     ['owner', 'admin'],
  'member:remove':     ['owner', 'admin'],
  'member:grant_owner':['owner'],
  'org:update':        ['owner', 'admin'],
  'org:delete':        ['owner'],
};

describe('can(role, action)', () => {
  for (const [action, allowed] of Object.entries(MATRIX) as [Action, OrgRole[]][]) {
    for (const role of ROLES) {
      const expected = allowed.includes(role);
      it(`${role} ${expected ? 'may' : 'may NOT'} ${action}`, () => {
        expect(can(role, action)).toBe(expected);
      });
    }
  }

  it('never lets a non-owner grant ownership', () => {
    for (const role of ROLES.filter((r) => r !== 'owner')) {
      expect(can(role, 'member:grant_owner')).toBe(false);
    }
  });

  it('gives viewer no mutating capability at all', () => {
    const mutations = (Object.keys(MATRIX) as Action[]).filter((a) => !a.endsWith(':read'));
    for (const a of mutations) expect(can('viewer', a)).toBe(false);
  });

  it('fails closed on an unrecognised role at runtime rather than throwing', () => {
    // OrgRole constrains TypeScript, but roles arrive from Postgres at runtime
    // (a stale/renamed enum value, a bad row). GRANTS[role] would be undefined
    // for such a value, and undefined.includes(...) throws — denying, not
    // throwing, is the only safe behaviour for an authorization function.
    const unknownRole = 'superadmin' as unknown as OrgRole;
    expect(() => can(unknownRole, 'project:read')).not.toThrow();
    expect(can(unknownRole, 'project:read')).toBe(false);
  });
});
