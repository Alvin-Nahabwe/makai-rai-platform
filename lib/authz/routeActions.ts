import type { Action } from './policy';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * The single source of truth for "which Action does this route handler
 * consult" — one entry per org-scoped `app/api/v1/orgs/[slug]/**` route,
 * one key per HTTP method it implements.
 *
 * This is the artifact the Task 11 matrix tests read. If a handler consults
 * a DIFFERENT action than the one declared here, observed behaviour
 * diverges from this table and that test's cell fails — so a change to a
 * route's authorization requirement is a change to this file, not just the
 * handler body.
 *
 * `__tests__/integration/port-completeness.test.ts` enumerates every
 * `app/api/**\/route.ts` from disk and requires each one to be accounted
 * for — either here, with at least one method declared, or in
 * `NON_ACTION_ROUTES` below. That is what makes this map exhaustive rather
 * than aspirational: a new route with no entry fails a test, not a review.
 */
export const ROUTE_ACTIONS: Record<string, Partial<Record<Method, Action>>> = {
  'app/api/v1/orgs/[slug]/projects/route.ts': { GET: 'project:read', POST: 'project:create' },
  'app/api/v1/orgs/[slug]/projects/[id]/route.ts': {
    GET: 'project:read',
    PATCH: 'project:update',
    DELETE: 'project:delete',
  },
  'app/api/v1/orgs/[slug]/assessments/route.ts': { GET: 'assessment:read', POST: 'assessment:create' },
  'app/api/v1/orgs/[slug]/assessments/[id]/route.ts': {
    GET: 'assessment:read',
    PATCH: 'assessment:respond',
  },
  'app/api/v1/orgs/[slug]/assessments/[id]/complete/route.ts': { POST: 'assessment:complete' },
  'app/api/v1/orgs/[slug]/assessments/[id]/remediation/route.ts': {
    GET: 'assessment:read',
    PATCH: 'remediation:update',
  },
  'app/api/v1/orgs/[slug]/reports/[id]/pdf/route.ts': { GET: 'assessment:read' },
  'app/api/v1/orgs/[slug]/members/route.ts': { GET: 'member:read', POST: 'member:invite' },
  'app/api/v1/orgs/[slug]/members/[userId]/route.ts': {
    PATCH: 'member:grant_owner',
    DELETE: 'member:remove',
  },
  'app/api/v1/orgs/[slug]/members/leave/route.ts': { POST: 'member:leave' },
};

/**
 * Routes that legitimately gate on identity alone (`requireIdentity` /
 * `requireIdentityForApi`) or on nothing at all, and therefore have no
 * `Action` to declare here:
 *
 *  - NextAuth's own catch-all handler — not application code.
 *  - Registration — runs BEFORE any org exists (`bootstrapOrgWithOwner`,
 *    the owner connection; ADR-0001 §4).
 *  - `POST /api/v1/orgs` — the second org-creation entry point; the
 *    resource being authorized ("may I create a NEW org") has no existing
 *    org context to check an Action against (ADR-0001, D-078: a brand-new
 *    org is not yet "the current one").
 *  - `users/me/*` — self-service on the caller's OWN identity row, gated by
 *    `requireIdentity(Api)` alone (there is no second party to authorize
 *    against — you always may read/export/delete yourself).
 *  - `admin/users/[id]/role` — platform-role (not org-role) administration
 *    over `User`, a non-tenant model; gated by `identity.platformRole`,
 *    which is a different axis than the org `Action` enum entirely.
 *  - `invitations/[token]` and `invitations/[token]/register` — the
 *    invitation-acceptance flow (Task 8). Both run BEFORE the caller has any
 *    membership in the invitation's org: `POST .../invitations/[token]`
 *    (accept) is gated on identity alone via `requireIdentityForApi` — same
 *    shape as `users/me/*` above — and the org it grants access to does not
 *    exist as an authorizable context for this caller until
 *    `acceptInvitation` itself creates the `Membership`. There is no `GET`
 *    on this route: the public preview (org name, invited email, role) is
 *    read server-side by `app/(public)/invitations/[token]/page.tsx` calling
 *    `invitationByToken` directly, not via this API (D-121). `register`
 *    mirrors `app/api/auth/register/route.ts`'s same pre-org-context
 *    reasoning and is also gated on nothing (deriving the invited email
 *    server-side is what makes it safe, not an auth check — see that
 *    route's own module doc).
 *
 * `__tests__/integration/port-completeness.test.ts` requires every
 * `app/api/**\/route.ts` file to appear either here or in `ROUTE_ACTIONS`
 * with at least one method declared — so adding a route to neither list is
 * a failing test, not a silent gap.
 */
export const NON_ACTION_ROUTES: readonly string[] = [
  'app/api/auth/[...nextauth]/route.ts',
  'app/api/auth/register/route.ts',
  'app/api/v1/orgs/route.ts',
  'app/api/users/me/route.ts',
  'app/api/users/me/export/route.ts',
  'app/api/users/me/password/route.ts',
  'app/api/users/me/sessions/route.ts',
  'app/api/admin/users/[id]/role/route.ts',
  'app/api/v1/invitations/[token]/route.ts',
  'app/api/v1/invitations/[token]/register/route.ts',
];
