import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { readSessionDeadlines } from '@/lib/auth/idleDeadline';
import { idleLimitSeconds } from '@/lib/auth/idle';
import { identityDb } from '@/lib/data/identity';
import { membershipsForUser } from '@/lib/data/preauth';
import { resolveOrgDispatch } from '@/lib/org-dispatch';
import IdleWarning from '@/components/layout/IdleWarning';
import { MAIN_CONTENT_ID } from '@/components/layout/SkipLink';

/**
 * The active org is a URL segment now, not ambient session state (Task 6).
 * This page is the ONE place that turns "who is this user" into "which org
 * dashboard do they land on" — everywhere else, the org is already in the
 * URL. See lib/org-dispatch.ts for the D-069-aware decision logic: the
 * `lastActiveOrgId` hint only wins a redirect when it also names a current,
 * active membership; the chosen destination then passes back through
 * `requireOrgContext` at the `/orgs/[slug]` layout like any other request,
 * so this page grants nothing by itself.
 *
 * The MAK-AI administrator holds no membership (FR-ORG-03) and lands on S-23 before the membership
 * dispatch (UX-01 gate 4, SRS line 1540). An account in no organisation sees S-07's empty state (SRS
 * line 311): organisations are created by the administrator only (FR-ORG-04), so it offers no way to make
 * one. `/` is outside the (authenticated) layout, so when it renders it shows the idle warning itself
 * (UX-43); when the session deadlines cannot be read it shows none, and the layout's fixed log line stays
 * the one source of `idle_deadline_unreadable`.
 */
export default async function LandingPage() {
  const identity = await requireIdentity();
  if (identity.platformRole === 'admin') redirect('/admin/organisations');

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

  const deadlines = await readSessionDeadlines(await headers());
  const hasOrgs = dispatch.orgs.length > 0;

  return (
    <>
      {deadlines ? (
        <IdleWarning idleSeconds={idleLimitSeconds()} secondsLeft={deadlines.secondsLeft} absoluteSecondsLeft={deadlines.absoluteSecondsLeft} />
      ) : null}
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="page-content">
        <div className="auth-card" style={{ maxWidth: 460, margin: '3rem auto' }}>
          {hasOrgs ? (
            <>
              <h1>Choose an organisation</h1>
              <nav aria-label="Your organisations" className="sidebar-nav">
                {dispatch.orgs.map((org) => (
                  <Link key={org.slug} href={`/orgs/${org.slug}/dashboard`} className="chooser-link">
                    {org.name}
                  </Link>
                ))}
              </nav>
            </>
          ) : (
            <>
              <h1>Welcome</h1>
              <p className="text-muted">You are not in an organisation yet: ask its owner for an invitation.</p>
            </>
          )}
        </div>
      </main>
    </>
  );
}
