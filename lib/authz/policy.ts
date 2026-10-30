import type { OrgRole } from '@prisma/client';

export type Action =
  | 'org:read' | 'org:update' | 'org:delete'
  | 'project:read' | 'project:create' | 'project:update' | 'project:delete'
  | 'assessment:read' | 'assessment:create' | 'assessment:update' | 'assessment:delete'
  | 'assessment:respond' | 'assessment:complete'
  | 'remediation:update'
  | 'evidence:read' | 'evidence:create' | 'evidence:delete'
  | 'member:read' | 'member:invite' | 'member:remove' | 'member:leave'
  | 'member:grant_owner' | 'member:revoke_owner'
  // v0.6.0 (FR-AUTHZ-01, SRS lines 631-646). AUTHZ deletes the dead legacy actions above after RM.
  | 'record:read'
  | 'decision:write' | 'decision:withdraw'
  | 'finding:raise' | 'finding:reopen' | 'finding:withdraw'
  | 'mitigation:write' | 'risk:accept'
  | 'review:open' | 'review:seal'
  | 'document:generate' | 'document:withdraw'
  | 'team:export' | 'project:archive' | 'member:role';

/**
 * Capability grants per role. Authorization only — this module performs no
 * tenant filtering, because RLS owns that (ADR-0001).
 *
 * `reviewer` shipped with viewer-equivalent capabilities in v0.5.0 (register
 * D-002, D-004). From v0.6.0 it also raises and withdraws findings, seals and
 * generates documents, and records no decision: FR-AUTHZ-01's matrix, SRS
 * lines 631-646, is the source of the v1 rows below.
 *
 * `evidence:read` mirrors `assessment:read` — evidence is part of what a
 * reader reads. `evidence:create` and `evidence:delete` mirror
 * `assessment:respond` — uploading and removing evidence are part of
 * answering, and deletion is confined to in-progress assessments (O-24), so
 * it is not the destructive power it would otherwise be.
 */
const GRANTS: Record<OrgRole, readonly Action[]> = {
  owner: ['org:read','org:update','org:delete',
          'project:read','project:create','project:update','project:delete',
          'assessment:read','assessment:create','assessment:update','assessment:delete',
          'assessment:respond','assessment:complete',
          'remediation:update',
          'evidence:read','evidence:create','evidence:delete',
          'member:read','member:invite','member:remove','member:leave',
          'member:grant_owner','member:revoke_owner',
          'record:read','decision:write','decision:withdraw','finding:raise','finding:reopen','finding:withdraw',
          'mitigation:write','risk:accept','review:open','review:seal','document:generate','document:withdraw',
          'team:export','project:archive','member:role'],
  admin: ['org:read','org:update',
          'project:read','project:create','project:update','project:delete',
          'assessment:read','assessment:create','assessment:update','assessment:delete',
          'assessment:respond','assessment:complete',
          'remediation:update',
          'evidence:read','evidence:create','evidence:delete',
          'member:read','member:invite','member:remove','member:leave',
          'record:read','decision:write','decision:withdraw','finding:raise','finding:reopen','finding:withdraw',
          'mitigation:write','risk:accept','review:open','review:seal','document:generate','document:withdraw',
          'team:export','project:archive','member:role'],
  assessor: ['org:read',
             'project:read','project:create','project:update',
             'assessment:read','assessment:create','assessment:update',
             'assessment:respond','assessment:complete',
             'remediation:update',
             'evidence:read','evidence:create','evidence:delete',
             'member:read','member:leave',
             'record:read','decision:write','decision:withdraw','finding:raise','finding:reopen','finding:withdraw',
             'mitigation:write','review:open'],
  reviewer: ['org:read','project:read','assessment:read','evidence:read','member:read','member:leave',
             'record:read','finding:raise','finding:withdraw','review:seal','document:generate'],
  viewer:   ['org:read','project:read','assessment:read','evidence:read','member:read','member:leave',
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
