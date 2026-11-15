import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { identityDb } from '@/lib/data/identity';
import { membershipsForUser } from '@/lib/data/preauth';
import { resolveOrgDispatch } from '@/lib/org-dispatch';
import { GateFrame, type GateStop } from '@/components/layout/GateFrame';
import { ORG_COPY } from '@/lib/org/copy';
import { GATE_COPY } from '@/lib/shell/copy';
import { pageTitle } from '@/lib/ui/title';

export const metadata = { title: pageTitle(ORG_COPY.titles.chooser) };

/** A person with organisations to choose from chooses one, then lands on its Home. The empty state names no step. */
const CHOOSER_ROUTE: readonly GateStop[] = [
  { label: GATE_COPY.stops.chooseOrganisation, state: 'current' },
  { label: GATE_COPY.stops.home, state: 'upcoming' },
];

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
 * one. Since plan 1B Task 1 `/` is in app/(gate): the group layout shows the idle warning (UX-43), and the page renders
 * the gate frame with the chooser in its wide card.
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

  const hasOrgs = dispatch.orgs.length > 0;

  return (
    <GateFrame variant="signed-in" userName={identity.name ?? ''} userId={identity.userId} accountReachable route={hasOrgs ? CHOOSER_ROUTE : undefined} wide>
      {hasOrgs ? (
        <>
          <h1>{ORG_COPY.chooser.heading}</h1>
          <nav aria-label={ORG_COPY.chooser.listLabel} className="sidebar-nav">
            {dispatch.orgs.map((org) => (
              <Link key={org.slug} href={`/orgs/${org.slug}/dashboard`} className="chooser-link">
                {org.name}
              </Link>
            ))}
          </nav>
        </>
      ) : (
        <>
          <h1>{ORG_COPY.chooser.emptyHeading}</h1>
          <p className="text-muted">{ORG_COPY.chooser.emptyBody}</p>
        </>
      )}
    </GateFrame>
  );
}
