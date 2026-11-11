import { requireIdentity } from '@/lib/auth/identity';
import { listOrganisationsForAdmin } from '@/lib/data/admin';
import { formatDay } from '@/lib/format/dates';
import { ListLink } from '@/components/ui/ListLink';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import { LIST_PAGE_SIZE, pageOf } from '@/lib/ui/showMore';
import type { InvitationState } from '@/types/record';

export const metadata = { title: 'Organisations' };

/** The four invitation states as W-10 names them (SRS lines 2166-2210). */
const STATE_WORDS: Readonly<Record<InvitationState, string>> = {
  pending: 'Pending', accepted: 'Accepted', expired: 'Expired', revoked: 'Revoked',
};

/**
 * S-23, the MAK-AI administrator's organisations (FR-ORG-03, FR-ORG-06, FR-ORG-07; SRS line 571 and 7.4.2,
 * line 2387). Each row names the organisation, its creation date, its current agreement version, its
 * member count and its first-owner invitation state, and flags in words an organisation with no agreement
 * recorded or no active owner. It reads `lib/data/admin.ts` only, which reaches no record table, so the
 * page cannot show a project, a decision or a count of records (NFR-SEC-04 (b)).
 *
 * A signed-in account without the platform role gets only the refusal line, with status 200: Next 16's
 * `forbidden()` would answer 403 but needs the experimental `authInterrupts` flag (owner default B21).
 * The "Create organisation" links do not prefetch (ListLink): S-24 is the administrator's next page, not
 * one every visit should fetch. The list comes 50 at a time with "Show more" (UX-40).
 */
export default async function OrganisationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await requireIdentity();
  if (identity.platformRole !== 'admin') {
    return (
      <div className="page-content">
        <p>This page is for MAK-AI administrators.</p>
      </div>
    );
  }
  const rows = await listOrganisationsForAdmin();
  const shown = (await searchParams).shown;
  const page = pageOf(rows, (Array.isArray(shown) ? shown[0] : shown) ?? null, LIST_PAGE_SIZE);   // UX-40: 50 at a time

  return (
    <div className="page-content">
      <div className="page-header">
        <h1>Organisations</h1>
        {rows.length > 0 ? <ListLink href="/admin/organisations/new" className="btn btn--primary">Create organisation</ListLink> : null}
      </div>
      {rows.length === 0 ? (
        <>
          <p>No organisations yet. Create one after its agreement is signed.</p>
          <ListLink href="/admin/organisations/new" className="btn btn--primary">Create organisation</ListLink>
        </>
      ) : (
        <div className="admin-table-wrapper card" tabIndex={0} role="region" aria-labelledby="organisations-caption">
          <table className="admin-table">
            <caption id="organisations-caption">Every organisation on the platform, by name</caption>
            <thead>
              <tr>
                <th scope="col">Organisation</th>
                <th scope="col">Created</th>
                <th scope="col">Legal name</th>
                <th scope="col">Members</th>
                <th scope="col">First-owner invitation</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((r) => (
                <tr key={r.orgId}>
                  <td className="admin-table__name">
                    <ListLink href={`/admin/organisations/${encodeURIComponent(r.orgId)}`}>{r.name}</ListLink>
                    {r.archived ? <span> (archived)</span> : null}
                    {r.hasActiveOwner ? null : <><br /><strong>No active owner</strong></>}
                  </td>
                  <td>{formatDay(r.createdAt, 'Africa/Kampala')}</td>
                  <td>{r.legalName === null ? <strong>Not recorded</strong> : r.legalName}</td>
                  <td>{r.memberCount}</td>
                  <td>{r.ownerInvitationState === null ? 'None' : STATE_WORDS[r.ownerInvitationState]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.hasMore ? <ShowMoreLink href={`?shown=${page.nextShown}`} label="Show more" /> : null}
    </div>
  );
}
