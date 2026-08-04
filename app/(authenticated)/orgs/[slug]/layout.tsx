import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { NotFoundError } from '@/lib/data/tenant';

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

  try {
    await requireOrgContextFor(identity.userId, slug, 'org:read');
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }

  return <>{children}</>;
}
