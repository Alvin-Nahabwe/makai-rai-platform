import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { can } from '@/lib/authz/policy';
import { withOrg } from '@/lib/data/tenant';
import { currentAgreement } from '@/lib/data/agreements';
import { listOrganisationEvents } from '@/lib/data/orgEvents';
import { AgreementSummary } from '@/components/org/AgreementSummary';
import { OrganisationEventsList } from '@/components/org/OrganisationEventsList';
import { TeamExportLink } from '@/components/org/TeamExportLink';

const EVENTS_PAGE_SIZE = 50;

/**
 * S-30, Organisation details (FR-ORG-05, FR-ORG-09). Every member reads the name and the agreement; the action
 * rows (who invited, changed or removed whom) are shown to owners and admins only (SRS line 577), and so is the
 * export link. The three slots belong to ORG (agreement, events) and EXP (export); this page wires them and
 * edits none. `?before=<event id>` pages back through the events.
 */
export default async function OrganisationSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  const { slug } = await params;
  const { before } = await searchParams;
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'org:read');

  const org = await withOrg(ctx, (tx) => tx.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true } }));
  const agreement = await currentAgreement(ctx);
  // Who sees the action rows is FR-ORG-09's own rule (owners and admins), not whoever holds team:export.
  const seesEvents = ctx.role === 'owner' || ctx.role === 'admin';
  const page = seesEvents ? await listOrganisationEvents(ctx, { before, limit: EVENTS_PAGE_SIZE }) : null;

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Organisation details</h1>
          <p className="text-muted">{org.name}</p>
        </div>
      </div>
      <section aria-labelledby="agreement-heading">
        <h2 id="agreement-heading">Agreement</h2>
        <AgreementSummary agreement={agreement} />
      </section>
      <section aria-labelledby="export-heading">
        <h2 id="export-heading">Team export</h2>
        <TeamExportLink orgSlug={slug} canExport={can(ctx.role, 'team:export')} />
      </section>
      {page !== null && (
        <section aria-labelledby="events-heading">
          <h2 id="events-heading">Membership and organisation changes</h2>
          <OrganisationEventsList events={page.events} hasMore={page.hasMore} />
        </section>
      )}
    </div>
  );
}
