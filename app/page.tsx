import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { identityDb } from '@/lib/data/identity';
import { membershipsForUser } from '@/lib/data/preauth';
import { resolveOrgDispatch } from '@/lib/org-dispatch';

/**
 * The active org is a URL segment now, not ambient session state (Task 6).
 * This page is the ONE place that turns "who is this user" into "which org
 * dashboard do they land on" — everywhere else, the org is already in the
 * URL. See lib/org-dispatch.ts for the D-069-aware decision logic: the
 * `lastActiveOrgId` hint only wins a redirect when it also names a current,
 * active membership; the chosen destination then passes back through
 * `requireOrgContext` at the `/orgs/[slug]` layout like any other request,
 * so this page grants nothing by itself.
 */
export default async function LandingPage() {
  const identity = await requireIdentity();

  const [user, memberships] = await Promise.all([
    identityDb.user.findUnique({
      where: { id: identity.userId },
      select: { lastActiveOrgId: true },
    }),
    membershipsForUser(identity.userId),
  ]);

  const dispatch = resolveOrgDispatch(user?.lastActiveOrgId ?? null, memberships);

  if (dispatch.kind === 'redirect') {
    redirect(`/orgs/${dispatch.slug}/dashboard`);
  }

  const hasOrgs = dispatch.orgs.length > 0;

  return (
    <div className="page-content">
      <div className="auth-card" style={{ maxWidth: 460, margin: '3rem auto' }}>
        {hasOrgs ? (
          <>
            <h1>Choose an organization</h1>
            <nav aria-label="Your organizations" className="sidebar-nav">
              {dispatch.orgs.map((org) => (
                <Link key={org.slug} href={`/orgs/${org.slug}/dashboard`} className="sidebar-link">
                  {org.name}
                </Link>
              ))}
            </nav>
            <p className="auth-footer">
              <Link href="/orgs/new">Create a new organization</Link>
            </p>
          </>
        ) : (
          <>
            <h1>Welcome</h1>
            <p className="text-muted">You don&apos;t belong to any organization yet.</p>
            <Link href="/orgs/new" className="btn-primary">Create an organization</Link>
          </>
        )}
      </div>
    </div>
  );
}
