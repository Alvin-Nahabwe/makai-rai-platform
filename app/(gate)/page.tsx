import { redirect } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { orgRoleLabel } from '@/lib/authz/roleLabel';
import { identityDb } from '@/lib/data/identity';
import { membershipsForUser } from '@/lib/data/preauth';
import { resolveOrgDispatch } from '@/lib/org-dispatch';
import { GateFrame, type GateStop } from '@/components/layout/GateFrame';
import { OrgChooser, type OrgChoice } from '@/components/org/OrgChooser';
import { EmptyState } from '@/components/ui/EmptyState';
import { ORG_COPY, isOrgRole, roleWithArticle } from '@/lib/org/copy';
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
 *
 * The chooser (plan 1B Task 8) lists each organisation as an item plate with the person's role there, read by
 * `orgRoleLabel(identity, slug)` (T8.3) and worded through the fixed role map (`roleWithArticle`). An organisation whose
 * role reads as none (the membership ended, or the organisation was archived, between the two reads) is left out of the
 * list: T8.2, the person's own active memberships only; with none left, the kit's empty state. Any other text is not a
 * role (a broken contract between orgRoleLabel and this page), so it is an error, never a dropped organisation: dropping
 * them all would tell a member they are in no organisation. A database error propagates to the error page.
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

  const labels = await Promise.all(dispatch.orgs.map((org) => orgRoleLabel(identity, org.slug)));
  const choices: OrgChoice[] = [];
  dispatch.orgs.forEach((org, i) => {
    const label = labels[i];
    if (label === null) return;
    if (!isOrgRole(label)) throw new Error('organisation chooser: orgRoleLabel returned a value that is not an organisation role');
    choices.push({ ...org, roleLabel: roleWithArticle(label) });
  });
  const hasOrgs = choices.length > 0;

  return (
    <GateFrame variant="signed-in" userName={identity.name ?? ''} userId={identity.userId} accountReachable route={hasOrgs ? CHOOSER_ROUTE : undefined} wide>
      {hasOrgs ? (
        <>
          <h1>{ORG_COPY.chooser.heading}</h1>
          <OrgChooser orgs={choices} />
        </>
      ) : (
        <>
          <h1>{ORG_COPY.chooser.emptyHeading}</h1>
          <EmptyState title={ORG_COPY.chooser.emptyTitle}>{ORG_COPY.chooser.emptyBody}</EmptyState>
        </>
      )}
    </GateFrame>
  );
}
