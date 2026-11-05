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
  // v0.6.0: GET consults record:read (FR-AUTHZ-01); DELETE is not a method of this route any more, it is
  // REMOVED_METHODS below and answers 404 (FR-AUTHZ-02).
  'app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts': { GET: 'record:read' },
  'app/api/v1/orgs/[slug]/members/route.ts': { GET: 'member:read', POST: 'member:invite' },
  'app/api/v1/orgs/[slug]/members/[userId]/route.ts': {
    PATCH: 'member:role',
    DELETE: 'member:remove',
  },
  'app/api/v1/orgs/[slug]/members/leave/route.ts': { POST: 'member:leave' },

  // v0.6.0 routes (contract "Routes", org-scoped rows 1 to 22, 28 and 29). Each file is a gated stub from
  // unit/k0b and is in PENDING_ROUTES until its producer implements it.
  'app/api/v1/orgs/[slug]/projects/[id]/decisions/route.ts': { POST: 'decision:write' },
  'app/api/v1/orgs/[slug]/projects/[id]/questions/[questionId]/withdrawal/route.ts': { POST: 'decision:withdraw' },
  'app/api/v1/orgs/[slug]/projects/[id]/evidence/route.ts': { POST: 'evidence:create' },
  'app/api/v1/orgs/[slug]/projects/[id]/findings/route.ts': { POST: 'finding:raise' },
  'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/mitigations/route.ts': { POST: 'mitigation:write' },
  'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/mitigations/[mitigationId]/route.ts': { POST: 'mitigation:write' },
  'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/accepted-risks/route.ts': { POST: 'risk:accept' },
  'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/reopen/route.ts': { POST: 'finding:reopen' },
  'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/withdrawal/route.ts': { POST: 'finding:withdraw' },
  'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/close-by-decision/route.ts': { POST: 'mitigation:write' },
  'app/api/v1/orgs/[slug]/projects/[id]/reviews/route.ts': { POST: 'review:open' },
  'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/seals/route.ts': { POST: 'review:seal' },
  'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/seals/[sealId]/check/route.ts': { GET: 'record:read' },
  'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents/preview/route.ts': { POST: 'document:generate' },
  'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents/route.ts': { POST: 'document:generate' },
  'app/api/v1/orgs/[slug]/documents/[documentId]/pdf/route.ts': { GET: 'record:read' },
  'app/api/v1/orgs/[slug]/documents/[documentId]/text/route.ts': { GET: 'record:read' },
  'app/api/v1/orgs/[slug]/documents/[documentId]/withdrawal/route.ts': { POST: 'document:withdraw' },
  'app/api/v1/orgs/[slug]/export/route.ts': { GET: 'team:export' },
  'app/api/v1/orgs/[slug]/projects/[id]/archive/route.ts': { POST: 'project:archive' },
  'app/api/v1/orgs/[slug]/projects/[id]/unarchive/route.ts': { POST: 'project:archive' },
  'app/api/v1/orgs/[slug]/invitations/[invitationId]/resend/route.ts': { POST: 'member:invite' },
  'app/api/v1/orgs/[slug]/invitations/[invitationId]/revoke/route.ts': { POST: 'member:invite' },
};

/**
 * Methods a route file keeps as an explicit handler that answers 404, because Next 16 answers 405 for a
 * method a route file does not export (node_modules/next/dist/server/route-modules/app-route/helpers/auto-implement-methods.js:16-28)
 * and FR-AUTHZ-02 wants 404. Every exported method of a route file is in `ROUTE_ACTIONS`, here, or the
 * file is in `NON_ACTION_ROUTES` (__tests__/authz/v060-route-lists.test.ts).
 */
export const REMOVED_METHODS: Readonly<Record<string, readonly Method[]>> = {
  'app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts': ['DELETE'],
};

/**
 * Route files whose handlers are still stubs that throw `NotImplementedError`. A test fails when a listed
 * file does not contain `NotImplementedError(` or an unlisted file under `app/api` does. Each producer
 * deletes its file from the list in the commit that implements it; the release lint
 * (__tests__/lint/no-contract-stubs.test.ts, with RELEASE_CANDIDATE=1) fails while the list is not empty.
 */
export const PENDING_ROUTES: readonly string[] = [
  'app/api/v1/orgs/[slug]/projects/[id]/findings/route.ts',
  'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents/preview/route.ts',
  'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents/route.ts',
  'app/api/v1/orgs/[slug]/documents/[documentId]/pdf/route.ts',
  'app/api/v1/orgs/[slug]/documents/[documentId]/text/route.ts',
  'app/api/v1/orgs/[slug]/documents/[documentId]/withdrawal/route.ts',
  'app/api/v1/orgs/[slug]/export/route.ts',
  'app/api/v1/orgs/[slug]/projects/[id]/archive/route.ts',
  'app/api/v1/orgs/[slug]/projects/[id]/unarchive/route.ts',
  'app/api/internal/reminders/route.ts',
  'app/api/admin/organisations/route.ts',
  'app/api/admin/organisations/[orgId]/route.ts',
  'app/api/admin/organisations/[orgId]/agreements/route.ts',
  'app/api/admin/organisations/[orgId]/owner-invitations/route.ts',
  'app/api/admin/organisations/[orgId]/owner-invitations/[invitationId]/resend/route.ts',
  'app/api/admin/organisations/[orgId]/owner-invitations/[invitationId]/revoke/route.ts',
];

/**
 * Every non-GET method of `ROUTE_ACTIONS` is in exactly one of `RETRY_KEYED_WRITES` and `UNKEYED_WRITES`
 * (NFR-INT-02; __tests__/authz/v060-route-lists.test.ts). A method here has a body that carries `requestId`,
 * and its producer adds a replay case for it.
 */
export const RETRY_KEYED_WRITES: Readonly<Record<string, readonly Method[]>> = {
  'app/api/v1/orgs/[slug]/projects/[id]/decisions/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/projects/[id]/questions/[questionId]/withdrawal/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/projects/[id]/evidence/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/projects/[id]/findings/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/mitigations/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/mitigations/[mitigationId]/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/accepted-risks/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/reopen/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/withdrawal/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/close-by-decision/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/projects/[id]/reviews/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/seals/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/documents/[documentId]/withdrawal/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/members/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/members/[userId]/route.ts': ['PATCH', 'DELETE'],
  'app/api/v1/orgs/[slug]/members/leave/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/invitations/[invitationId]/resend/route.ts': ['POST'],
  'app/api/v1/orgs/[slug]/invitations/[invitationId]/revoke/route.ts': ['POST'],
};

/**
 * The write methods that carry no request id, each with its reason. The reasons are exactly three:
 *  - 'writes nothing': the document preview creates no row;
 *  - 'removed by RM': the legacy assessment writes, deleted with their routes (finding R2-02);
 *  - 'keyed by MEM or PRJ (owner answer A1)': contract Routes rows 21 to 29. They use the receipt mode of
 *    `idempotentWrite`, and MEM (rows 25 to 29) or PRJ (rows 21 to 24) moves each row to
 *    `RETRY_KEYED_WRITES` in the commit that makes the route take a `requestId` and adds its replay case.
 *    No such reason remains at the release candidate.
 */
export const UNKEYED_WRITES: Readonly<Record<string, { methods: readonly Method[]; reason: string }>> = {
  'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents/preview/route.ts': { methods: ['POST'], reason: 'writes nothing' },

  'app/api/v1/orgs/[slug]/projects/[id]/archive/route.ts': { methods: ['POST'], reason: 'keyed by MEM or PRJ (owner answer A1)' },
  'app/api/v1/orgs/[slug]/projects/[id]/unarchive/route.ts': { methods: ['POST'], reason: 'keyed by MEM or PRJ (owner answer A1)' },
  'app/api/v1/orgs/[slug]/projects/route.ts': { methods: ['POST'], reason: 'keyed by MEM or PRJ (owner answer A1)' },
  'app/api/v1/orgs/[slug]/projects/[id]/route.ts': { methods: ['PATCH', 'DELETE'], reason: 'keyed by MEM or PRJ (owner answer A1)' },
};

/**
 * Routes that legitimately gate on identity alone (`requireIdentity` /
 * `requireIdentityForApi`) or on nothing at all, and therefore have no
 * `Action` to declare here:
 *
 *  - NextAuth's own catch-all handler — not application code.
 *  - `auth/register` — the open sign-up route, removed (FR-ACC-01): every method answers 404 and
 *    writes nothing. The file stays only because the NextAuth catch-all would otherwise answer the
 *    path with 400.
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
 *  - `health` — liveness for the uptime monitor and the container healthcheck
 *    (INFRA-12). It asks the database `SELECT 1` and nothing about any user or
 *    organisation, and answers a bare `{"status":"ok"}` or `{"status":"unavailable"}`
 *    to callers who carry no credentials.
 *  - v0.6.0 (contract "Routes", rows 30, 33, 34, 37, 40 to 46), gated stubs from unit/k0b:
 *    `acceptances` (row 30: identity alone, `requireIdentityForApi`, usable before the acceptances exist);
 *    `password-reset` and `password-reset/complete` (rows 33, 34: public, a person who cannot sign in);
 *    `users/me/preferences` (row 37: self-service on the caller's own identity row);
 *    `internal/reminders` (row 40: the reminder job's bearer token, no session, nginx refuses the path);
 *    `admin/organisations/**` (rows 41 to 46: the platform role `admin`, a different axis than the org
 *    `Action` enum, as `admin/users/[id]/role`).
 *  - `invitations/[token]` and `invitations/[token]/register` — the
 *    invitation-acceptance flow (contract rows 32 and 31). Both run BEFORE the
 *    caller has any membership in the invitation's org: `POST
 *    .../invitations/[token]` (accept) is gated on identity alone via
 *    `requireIdentityForApi` — same shape as `users/me/*` above — and the org
 *    it grants access to does not exist as an authorizable context for this
 *    caller until the `accept_invitation` database function creates the
 *    `Membership`. There is no `GET` on this route: the public preview (org
 *    name, invited email, role, inviter) is read server-side by
 *    `app/(public)/invitations/[token]/page.tsx` calling `invitationByToken`
 *    directly, not via this API (D-121). `register` is gated on the token
 *    alone: it is the one way an account is created (FR-ACC-01), and
 *    deriving the invited email server-side is what makes it safe, not an
 *    auth check — see that route's own module doc.
 *
 * `__tests__/integration/port-completeness.test.ts` requires every
 * `app/api/**\/route.ts` file to appear either here or in `ROUTE_ACTIONS`
 * with at least one method declared — so adding a route to neither list is
 * a failing test, not a silent gap.
 */
export const NON_ACTION_ROUTES: readonly string[] = [
  'app/api/auth/[...nextauth]/route.ts',
  'app/api/auth/register/route.ts',
  'app/api/health/route.ts',
  'app/api/v1/orgs/route.ts',
  'app/api/users/me/route.ts',
  'app/api/users/me/export/route.ts',
  'app/api/users/me/password/route.ts',
  'app/api/users/me/sessions/route.ts',
  'app/api/admin/users/[id]/role/route.ts',
  'app/api/v1/invitations/[token]/route.ts',
  'app/api/v1/invitations/[token]/register/route.ts',
  'app/api/acceptances/route.ts',
  'app/api/password-reset/route.ts',
  'app/api/password-reset/complete/route.ts',
  'app/api/users/me/preferences/route.ts',
  'app/api/internal/reminders/route.ts',
  'app/api/admin/organisations/route.ts',
  'app/api/admin/organisations/[orgId]/route.ts',
  'app/api/admin/organisations/[orgId]/agreements/route.ts',
  'app/api/admin/organisations/[orgId]/owner-invitations/route.ts',
  'app/api/admin/organisations/[orgId]/owner-invitations/[invitationId]/resend/route.ts',
  'app/api/admin/organisations/[orgId]/owner-invitations/[invitationId]/revoke/route.ts',
];
