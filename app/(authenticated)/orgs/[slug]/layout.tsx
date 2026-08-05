import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { NotFoundError, type OrgContext } from '@/lib/data/tenant';
import { identityDb } from '@/lib/data/identity';

/**
 * Membership resolution for every `/orgs/[slug]/*` page (constraint 3 of the
 * Task 6 brief; see also proxy.ts, which deliberately does NOT do this).
 *
 * `requireIdentity()` first, not `requireOrgContext`'s own
 * `requireIdentityForApi()` path: this is a page, not a route handler, so an
 * unauthenticated caller must get the 30x page redirect
 * (`lib/auth/identity.ts`'s documented page/API split), not a thrown
 * `UnauthenticatedError` bubbling into a generic 500. Calling
 * `requireOrgContextFor` (the userId-explicit core) instead of
 * `requireOrgContext(slug, action)` avoids re-deriving identity a second
 * time and avoids that mismatched error shape entirely.
 *
 * `'org:read'` is the action: every `OrgRole` grants it (lib/authz/policy.ts),
 * so this call can only ever reject for "unknown slug" or "not a member" —
 * both `NotFoundError` (ADR-0001: never 403 a non-member, never distinguish
 * "doesn't exist" from "exists but you're not in it" — both leak org
 * existence). `ForbiddenError` is a sibling this call cannot legitimately
 * produce; it is NOT caught here — an unexpected throw must surface as a
 * loud 500, not get silently laundered into a misleading 404 (AGENTS.md §2:
 * investigate a failure, don't paper over it with a broad catch).
 *
 * The resolved `OrgContext` itself is discarded after the gate passes: Task
 * 6's scope is routing, not data access (see the task's "WHERE THIS FITS"
 * note) — each page/route independently calls `requireOrgContext` again when
 * it actually reads or writes tenant data, which is Task 7's job.
 */
export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const identity = await requireIdentity();

  let ctx: OrgContext;
  try {
    ctx = await requireOrgContextFor(identity.userId, slug, 'org:read');
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }

  // Step 5b: `lastActiveOrgId` is READ by the `/` dispatcher
  // (lib/org-dispatch.ts) but was written nowhere in the plan, leaving the
  // "redirect to your remembered organization" branch permanently
  // unreachable. Written HERE, after `requireOrgContextFor` has already
  // proven membership above — never before, and never from client input
  // (D-069: this column is unconstrained and FK-less, so it must never be
  // trusted as an input to an authorization decision, only ever produced
  // as one AFTER the org it names has already been authorised this same
  // request). `ctx.orgId` — the database-verified id, not the `slug`
  // string — is what gets recorded.
  //
  // Fire-and-forget, not awaited into the response: this is a hint for a
  // future redirect target and nothing else (D-069) — the render must not
  // block on it, and a failure here must not turn a successful page load
  // into an error. Swallowed rather than propagated for that one reason:
  // nothing downstream depends on this write succeeding, and the NEXT
  // request re-authorises the org from scratch regardless (see the module
  // doc above). It is NOT swallowed silently, though — logged so a
  // persistent failure (e.g. a DB outage making every write fail) is
  // observable rather than invisible, which is the gap
  // `silent-failure-hunter` found in the first draft of this catch. Not
  // `logSecurityEvent`: this isn't a security-relevant event, just an
  // operational one (a UX-hint write that didn't land).
  void identityDb.user
    .update({ where: { id: identity.userId }, data: { lastActiveOrgId: ctx.orgId } })
    .catch((e: unknown) => {
      console.error('lastActiveOrgId write failed', {
        userId: identity.userId,
        orgId: ctx.orgId,
        error: e instanceof Error ? e.message : String(e),
      });
    });

  return <>{children}</>;
}
