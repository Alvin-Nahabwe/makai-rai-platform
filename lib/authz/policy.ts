import type { OrgRole } from '@prisma/client';

export type Action =
  | 'org:read'
  | 'project:read' | 'project:create' | 'project:update' | 'project:delete'
  | 'evidence:create'
  | 'member:read' | 'member:invite' | 'member:remove' | 'member:leave'
  | 'member:grant_owner' | 'member:revoke_owner'
  // v0.6.0 (FR-AUTHZ-01, SRS lines 631-646).
  | 'record:read'
  | 'decision:write' | 'decision:withdraw'
  | 'finding:raise' | 'finding:reopen' | 'finding:withdraw'
  | 'mitigation:write' | 'risk:accept'
  | 'review:open' | 'review:seal'
  | 'document:generate' | 'document:withdraw'
  | 'team:export' | 'project:archive' | 'member:role';

/**
 * Capability grants per role: FR-AUTHZ-01's matrix, SRS lines 629-646, for every action, the legacy rows
 * included. Authorization only: this module performs no tenant filtering, because RLS owns that (ADR-0001).
 *
 * The reviewer raises and withdraws findings, seals and generates documents, and records no decision.
 * `project:delete` is not in the matrix; it keeps the owner and admin grants it had in v0.5.0 (00-contract.md,
 * Policy, owner question 3). FR-AUTHZ-02 deleted the actions nothing checked once RM removed the score routes:
 * `org:update`, `org:delete`, the six `assessment:*` actions, `remediation:update`, `evidence:read` (replaced by
 * `record:read`) and `evidence:delete` (evidence is append-only). `__tests__/authz/dead-actions.test.ts` holds
 * every action here to a route entry or a gate call, and `__tests__/authz/matrix-v060.test.ts` holds every row
 * to the SRS matrix.
 *
 * Exported for those tests only; production code asks `can()`.
 */
export const GRANTS: Record<OrgRole, readonly Action[]> = {
  owner: ['org:read',
          'project:read','project:create','project:update','project:delete',
          'evidence:create',
          'member:read','member:invite','member:remove','member:leave',
          'member:grant_owner','member:revoke_owner',
          'record:read','decision:write','decision:withdraw','finding:raise','finding:reopen','finding:withdraw',
          'mitigation:write','risk:accept','review:open','review:seal','document:generate','document:withdraw',
          'team:export','project:archive','member:role'],
  admin: ['org:read',
          'project:read','project:create','project:update','project:delete',
          'evidence:create',
          'member:read','member:invite','member:remove','member:leave',
          'record:read','decision:write','decision:withdraw','finding:raise','finding:reopen','finding:withdraw',
          'mitigation:write','risk:accept','review:open','review:seal','document:generate','document:withdraw',
          'team:export','project:archive','member:role'],
  assessor: ['org:read',
             'project:read','project:create','project:update',
             'evidence:create',
             'member:read','member:leave',
             'record:read','decision:write','decision:withdraw','finding:raise','finding:reopen','finding:withdraw',
             'mitigation:write','review:open'],
  reviewer: ['org:read','project:read','member:read','member:leave',
             'record:read','finding:raise','finding:withdraw','review:seal','document:generate'],
  viewer:   ['org:read','project:read','member:read','member:leave',
             'record:read'],
};

/**
 * Answers "may this role perform this action?" — nothing else. `role` is
 * typed as `OrgRole`, but at runtime it arrives from a database column, so a
 * stale/renamed enum value can reach this function despite the type. This
 * looks like a redundant check to a future reader who trusts the parameter
 * type — it is not. The runtime guards below exist precisely because
 * `OrgRole` cannot be trusted at this boundary, and half-trusting the same
 * type (accepting it may not be a valid role, while assuming it is at least
 * a string) is incoherent. Two failures were found by adversarial review,
 * both from the same root cause — bracket/`Object.hasOwn` property access
 * coerces its key via `ToPropertyKey`/`ToString` before comparing it against
 * `GRANTS`'s own keys:
 *
 * 1. `GRANTS[role] ?? []` alone: `GRANTS` is a plain object literal and
 *    inherits from `Object.prototype`, so a role string that collides with
 *    an inherited member (`__proto__`, `constructor`, `toString`,
 *    `hasOwnProperty`, `valueOf`, `isPrototypeOf`, ...) resolves to that
 *    member instead of `undefined`; `?? []` never fires and `.includes`
 *    throws on a non-array.
 * 2. Even with `Object.hasOwn` guarding the lookup: an object whose
 *    `toString()` returns a real role name (e.g. `{ toString: () => 'owner'
 *    }`) coerces to that role's own key and is WRONGLY GRANTED — worse than
 *    throwing, because it authorizes rather than denies. An object with no
 *    prototype (`Object.create(null)`) has no `toString` to coerce with and
 *    throws instead. Neither is reachable today (role always arrives as a
 *    Postgres-enum string; JSON cannot encode a function-valued `toString`),
 *    but the fix closes the whole class — reject any non-string before any
 *    coercion can happen — rather than adding another enumerated case.
 *
 * Denying an unrecognised or malformed principal is the only safe default
 * for an authorization function.
 */
export function can(role: OrgRole, action: Action): boolean {
  if (typeof role !== 'string') return false;
  const grants = Object.hasOwn(GRANTS, role) ? GRANTS[role] : [];
  return grants.includes(action);
}
