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

  // GRANTS is a plain object literal, so it inherits from Object.prototype.
  // A role string that collides with an inherited member ('__proto__',
  // 'constructor', 'toString', ...) resolves to that member instead of
  // undefined, so a lookup that only guards against `undefined` (`?? []`)
  // never fires and `.includes` is called on a non-array, which throws.
  // Denial must hold for these names exactly as it does for an ordinary
  // unrecognised string. (D-072 / review finding on this task.)
  const PROTOTYPE_COLLIDING_ROLES = [
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    'valueOf',
    'isPrototypeOf',
  ] as const;

  for (const bad of PROTOTYPE_COLLIDING_ROLES) {
    it(`fails closed rather than throwing for the prototype-colliding role "${bad}"`, () => {
      const role = bad as unknown as OrgRole;
      expect(() => can(role, 'project:read')).not.toThrow();
      expect(can(role, 'project:read')).toBe(false);
    });
  }

  // Object.hasOwn(GRANTS, role) coerces `role` via ToPropertyKey/ToString
  // before comparing against GRANTS's own keys. An object whose toString()
  // returns a real role name therefore resolves to that role's own key and
  // was WRONGLY GRANTED — worse than the throwing this task started from,
  // because it authorizes rather than denies. A role with no toString at all
  // (an Object.create(null) value) fails the reverse way: ToString has
  // nothing to call and throws. Neither is reachable today (role always
  // arrives as a Postgres-enum string; JSON cannot encode a function-valued
  // toString), but the runtime guard exists because OrgRole cannot be
  // trusted at the type level, and "it is at least a string" is the same
  // kind of trust — closing the class means not assuming the value is a
  // string at all, not enumerating the ways a non-string can misbehave.
  it('denies rather than grants when role is an object whose toString() resolves to a real role', () => {
    const disguisedOwner = { toString: () => 'owner' } as unknown as OrgRole;
    expect(() => can(disguisedOwner, 'org:delete')).not.toThrow();
    expect(can(disguisedOwner, 'org:delete')).toBe(false);
  });

  it('denies rather than throwing when role has no prototype (and so no toString)', () => {
    const noProtoRole = Object.create(null) as unknown as OrgRole;
    expect(() => can(noProtoRole, 'project:read')).not.toThrow();
    expect(can(noProtoRole, 'project:read')).toBe(false);
  });
});
