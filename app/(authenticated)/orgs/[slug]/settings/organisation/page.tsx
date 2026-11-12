import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { can } from '@/lib/authz/policy';
import { withOrg } from '@/lib/data/tenant';
import { listOrganisationEvents } from '@/lib/data/orgEvents';
import { OrganisationEventsList } from '@/components/org/OrganisationEventsList';
import { TeamExportLink } from '@/components/org/TeamExportLink';

const EVENTS_PAGE_SIZE = 50;

/**
 * S-30, Organisation details (FR-ORG-09). Every member reads the name and the institution's legal name; the action
 * rows (who invited, changed or removed whom) are shown to owners and admins only (SRS line 577), and so is the
 * export link. The two slots belong to ORG (events) and EXP (export); this page wires them and
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
  // `before` is an event id (a UUID); anything else is a first page, so the reader never meets a malformed value.
  const rawBefore = (await searchParams).before;
  const before = rawBefore !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawBefore) ? rawBefore : undefined;
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'org:read');

  const org = await withOrg(ctx, (tx) => tx.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true, legalName: true } }));
  // Who sees the action rows is FR-ORG-09's own rule (owners and admins), not whoever holds team:export.
  const seesEvents = ctx.role === 'owner' || ctx.role === 'admin';
  const page = seesEvents ? await listOrganisationEvents(ctx, { before, limit: EVENTS_PAGE_SIZE }) : null;

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Organisation details</h1>
          <p className="text-muted">{org.name}</p>
          <p className="text-muted">{`Legal name: ${org.legalName ?? 'Not recorded'}`}</p>
        </div>
      </div>
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
