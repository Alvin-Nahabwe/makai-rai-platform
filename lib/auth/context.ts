import { orgBySlug, membershipsForUser } from '../data/preauth';
import { can, type Action } from '../authz/policy';
import { createOrgContext, type OrgContext, NotFoundError, ForbiddenError } from '../data/tenant';
import { requireIdentityForApi } from './identity';

/**
 * `requireOrgContext` is not *a* security control in this system — it IS the
 * authorization decision (see the task brief / ADR-0001). It proves, from the
 * database, on every call:
 *
 *   1. a valid session names a userId               — requireIdentityForApi()
 *   2. that user is active and sessionEpoch matches  — requireIdentityForApi()
 *   3. an Organization with this slug exists AND is not soft-deleted
 *   4. a Membership joins THIS user to THAT org with status = 'active'
 *   5. can(membership.role, action), role read fresh from the membership row
 *      — never from the token, never from client input
 *   6. the returned orgId is the organization.id read in step 3 — never a
 *      value the client supplied
 *
 * None of these may be satisfied from a cache that outlives the request:
 * `orgBySlug`/`membershipsForUser` (lib/data/preauth.ts) hit the database on
 * every call, and this function is written the same way — no memoization,
 * nothing carried across requests.
 *
 * `lastActiveOrgId` never appears here, deliberately (D-069): it is an
 * unconstrained, FK-less column that can name an org the user was removed
 * from, suspended in, or never joined, so it is not a legitimate input to an
 * authorization decision. It may select which slug to try first; nothing
 * more.
 */

/**
 * The userId-explicit, pure form. Callable in tests without a session,
 * cookies or NextAuth in the loop — the same shape `resolveIdentity` chose in
 * lib/auth/identity.ts, for the same reason (testability without a request).
 *
 * BOTH lookups below run unconditionally, even when `orgBySlug` returns
 * `null`. This is not an optimisation left on the table — it is the fix for
 * D-101's second, still-open residual: if the "unknown slug" branch skipped
 * the membership lookup, it would do measurably less database work than the
 * "not a member" branch, and the two 404s — indistinguishable in status code
 * and message — would still be distinguishable by response time, which
 * recovers exactly the organization-existence signal the 404 policy exists
 * to withhold. `Promise.all` runs them concurrently so neither depends on the
 * other's result.
 */
export async function requireOrgContextFor(
  userId: string,
  slug: string,
  action: Action,
): Promise<OrgContext> {
  const [org, memberships] = await Promise.all([orgBySlug(slug), membershipsForUser(userId)]);
  const membership = org ? memberships.find((m) => m.orgId === org.id) : undefined;

  // Unknown slug and "slug exists but you are not a member" throw the SAME
  // error, with no distinguishing detail in its type or message. Conflating
  // them here — rather than letting a caller reconstruct which case it was —
  // is what makes it structurally impossible for a later handler to leak the
  // distinction back to the client (ADR-0001: never 403 for a non-member).
  if (!org || !membership) throw new NotFoundError();

  // Role comes from the membership row just read, never from a token or from
  // client-supplied input — satisfies fact 5.
  if (!can(membership.role, action)) throw new ForbiddenError(action, membership.role);

  // orgId is `org.id`, read from the database in the lookup above — never a
  // value derived from the caller's `slug` string or any other client input.
  // Satisfies fact 6.
  return createOrgContext(org.id, membership.role);
}

/**
 * The production entry point named in the interface contract. Resolves the
 * caller's userId from the authenticated session via `requireIdentityForApi`
 * (lib/auth/identity.ts) — which itself re-checks `isActive` and
 * `sessionEpoch` against the database, never trusting the token alone — then
 * delegates to `requireOrgContextFor`. `requireIdentityForApi`'s
 * `UnauthenticatedError` propagates unchanged: an unauthenticated caller gets
 * 401, not a 404 that would misreport "you have no session" as "no such
 * organization".
 */
export async function requireOrgContext(slug: string, action: Action): Promise<OrgContext> {
  const identity = await requireIdentityForApi();
  return requireOrgContextFor(identity.userId, slug, action);
}
