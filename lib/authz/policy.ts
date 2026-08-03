import type { OrgRole } from '@prisma/client';

export type Action =
  | 'project:read' | 'project:create' | 'project:update' | 'project:delete'
  | 'assessment:read' | 'assessment:create' | 'assessment:update' | 'assessment:delete'
  | 'member:read' | 'member:invite' | 'member:remove' | 'member:grant_owner'
  | 'org:update' | 'org:delete';

/**
 * Capability grants per role. Authorization only — this module performs no
 * tenant filtering, because RLS owns that (ADR-0001).
 *
 * `reviewer` intentionally ships with viewer-equivalent capabilities; its
 * distinguishing powers belong to the review/sign-off workflow (register D-002,
 * D-004). Inventing them here would be speculative.
 */
const GRANTS: Record<OrgRole, readonly Action[]> = {
  owner: ['project:read','project:create','project:update','project:delete',
          'assessment:read','assessment:create','assessment:update','assessment:delete',
          'member:read','member:invite','member:remove','member:grant_owner',
          'org:update','org:delete'],
  admin: ['project:read','project:create','project:update','project:delete',
          'assessment:read','assessment:create','assessment:update','assessment:delete',
          'member:read','member:invite','member:remove','org:update'],
  assessor: ['project:read','project:create','project:update',
             'assessment:read','assessment:create','assessment:update','member:read'],
  reviewer: ['project:read','assessment:read','member:read'],
  viewer:   ['project:read','assessment:read','member:read'],
};

/**
 * Answers "may this role perform this action?" — nothing else. `role` is
 * typed as `OrgRole`, but at runtime it arrives from a database column, so a
 * stale/renamed enum value can reach this function despite the type.
 *
 * `Object.hasOwn` guards the lookup rather than `GRANTS[role] ?? []`: `GRANTS`
 * is a plain object literal and therefore inherits from `Object.prototype`,
 * so a role string that collides with an inherited member (`__proto__`,
 * `constructor`, `toString`, `hasOwnProperty`, `valueOf`, `isPrototypeOf`, ...)
 * resolves to that member rather than `undefined` — `?? []` never fires, and
 * `.includes` is then called on a non-array and throws. `Object.hasOwn`
 * checks only the object's own enumerable keys, so every inherited-name
 * collision and every ordinary unrecognised role both take the same denied
 * path. Denying an unrecognised principal is the only safe default for an
 * authorization function.
 */
export function can(role: OrgRole, action: Action): boolean {
  const grants = Object.hasOwn(GRANTS, role) ? GRANTS[role] : [];
  return grants.includes(action);
}
