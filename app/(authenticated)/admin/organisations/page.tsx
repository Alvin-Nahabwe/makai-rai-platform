import { requireIdentity } from '@/lib/auth/identity';
import { listOrganisationsForAdmin } from '@/lib/data/admin';
import { formatDay } from '@/lib/format/dates';
import { ButtonLink } from '@/components/ui/Button';
import { ListLink } from '@/components/ui/ListLink';
import { PageHeader } from '@/components/ui/PageHeader';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import { Table } from '@/components/ui/Table';
import { AdminRefusal } from '@/components/admin/AdminRefusal';
import { LIST_PAGE_SIZE, pageOf } from '@/lib/ui/showMore';
import { ADMIN_COPY } from '@/lib/admin/copy';
import { INVITATION_STATE_WORDS } from '@/lib/admin/forms/copy';
import { pageTitle } from '@/lib/ui/title';
import '@/components/admin/AdminForms.css';

export const metadata = { title: pageTitle(ADMIN_COPY.titles.organisations) };

const O = ADMIN_COPY.organisations;

/**
 * S-23, the MAK-AI administrator's organisations (FR-ORG-03, FR-ORG-06, FR-ORG-07; SRS line 571 and 7.4.2,
 * line 2387). Each row names the organisation, its creation date, its institution's legal name, its
 * member count and its owner invitation state, and flags in words an organisation with no legal name
 * recorded or no active Owner. It reads `lib/data/admin.ts` only, which reaches no record table, so the
 * page cannot show a project, a decision or a count of records (NFR-SEC-04 (b)).
 *
 * A signed-in account without the platform role gets only the refusal line, with status 200: Next 16's
 * `forbidden()` would answer 403 but needs the experimental `authInterrupts` flag (owner default B21).
 * The "Create organisation" links do not prefetch (ButtonLink): S-24 is the administrator's next page, not
 * one every visit should fetch. The list comes 50 at a time with "Show more" (UX-40). The table is the kit's (plan 1A
 * Task 19, ruling L5-2); with no organisation there is no table, only the sentence and the link.
 */
export default async function OrganisationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await requireIdentity();
  if (identity.platformRole !== 'admin') return <AdminRefusal />;
  const rows = await listOrganisationsForAdmin();
  const shown = (await searchParams).shown;
  const page = pageOf(rows, (Array.isArray(shown) ? shown[0] : shown) ?? null, LIST_PAGE_SIZE);   // UX-40: 50 at a time
  const columns = [
    { key: 'organisation', label: O.columns.organisation }, { key: 'created', label: O.columns.created },
    { key: 'legalName', label: O.columns.legalName }, { key: 'members', label: O.columns.members },
    { key: 'invitation', label: O.columns.invitation },
  ] as const;
  const create = <ButtonLink variant="primary" href="/admin/organisations/new">{O.create}</ButtonLink>;

  return (
    <div className="page-content">
      <PageHeader title={ADMIN_COPY.titles.organisations} actions={rows.length > 0 ? create : null} />
      {rows.length === 0 ? (
        <>
          <p>{O.empty}</p>
          {create}
        </>
      ) : (
        <Table caption={O.caption} columns={columns} rowHeaderKey="organisation" rows={page.items.map((r) => ({
          key: r.orgId,
          cells: {
            organisation: (
              <>
                <span className="admin-org__name"><ListLink href={`/admin/organisations/${encodeURIComponent(r.orgId)}`}>{r.name}</ListLink></span>
                {r.archived ? <span>{O.archived}</span> : null}
                {r.hasActiveOwner ? null : <strong className="admin-flag">{O.noActiveOwner}</strong>}
              </>
            ),
            created: formatDay(r.createdAt, 'Africa/Kampala'),
            legalName: r.legalName === null ? <strong>{O.legalNameMissing}</strong> : r.legalName,
            members: r.memberCount,
            invitation: r.ownerInvitationState === null ? O.noInvitation : INVITATION_STATE_WORDS[r.ownerInvitationState],
          },
        }))} />
      )}
      {page.hasMore ? <ShowMoreLink href={`?shown=${page.nextShown}`} label={O.showMore} /> : null}
    </div>
  );
}
