import { randomUUID } from 'node:crypto';
import { requireIdentity } from '@/lib/auth/identity';
import { accountsForAdmin } from '@/lib/data/admin';
import { formatDay } from '@/lib/format/dates';
import { LIST_PAGE_SIZE, pageOf } from '@/lib/ui/showMore';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';

import { ADMIN_COPY } from '@/lib/admin/copy';
import { pageTitle } from '@/lib/ui/title';

export const metadata = { title: pageTitle(ADMIN_COPY.titles.accounts) };

/** Route 47's refusal codes (app/api/admin/users/[id]/role/route.ts), each with the sentence S-25 shows. */
const REFUSALS: Readonly<Record<string, string>> = {
  self: 'You cannot change your own role or deactivate your own account.',
  request_reference_required: 'Enter the reference of the controller\'s written request to deactivate the only active owner.',
  has_membership: 'This account belongs to an organisation, so it cannot be a MAK-AI administrator.',
  invalid_request: 'That change could not be made. Reload the page and try again.',
  single_admin: 'The platform keeps one MAK-AI administrator. This account stays an assessor.',
};

/** The column headings: one source for each <th> and for the label its cells show in the stacked narrow layout. */
const ACCOUNT_COLUMNS = ['Name', 'Email', 'Platform role', 'Status', 'Created', 'Actions'] as const;

/** The longest request reference route 47 accepts. */
const MAX_REQUEST_REFERENCE = 200;

/** "A", "A and B", "A, B and C". */
function listOf(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * S-25, the MAK-AI administrator's accounts (FR-ORG-07, NFR-SEC-19; SRS line 1639 fixes the address). One
 * row per account with its platform role and state; Deactivate or Reactivate for every account but the
 * administrator's own, posted as a form to route 47. Before deactivating the only active owner of an
 * organisation the row names the organisation and asks for the reference of the controller's written
 * request, which the field requires and route 47 and the definer function require again. Route 47 never
 * grants the platform role, so there is no control for it. A refusal comes back as `?error=<code>` and is
 * shown as one alert; an unknown code shows nothing. The list comes 50 at a time with "Show more" (UX-40).
 *
 * A signed-in account without the platform role gets only the refusal line, with status 200 (owner default
 * B21, as S-23).
 */
export default async function AccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await requireIdentity();
  if (identity.platformRole !== 'admin') {
    return (
      <div className="page-content">
        <p>This page is for MAK-AI administrators.</p>
      </div>
    );
  }
  const query = await searchParams;
  const error = one(query.error);
  const refusal = error !== undefined && Object.hasOwn(REFUSALS, error) ? REFUSALS[error] : null;
  const missingReferenceFor = error === 'request_reference_required' ? one(query.user) : undefined;
  const page = pageOf(await accountsForAdmin(), one(query.shown) ?? null, LIST_PAGE_SIZE);   // UX-40: 50 at a time

  return (
    <div className="page-content">
      <div className="page-header">
        <h1>Accounts</h1>
      </div>
      {refusal !== null ? <div className="form-error" role="alert" id="accounts-refusal">{refusal}</div> : null}
      <div className="admin-table-wrapper card" tabIndex={0} role="region" aria-labelledby="accounts-caption">
        <table className="admin-table admin-table--stack-wide" role="table">
          <caption id="accounts-caption">Every account on the platform, oldest first</caption>
          <thead role="rowgroup">
            <tr role="row">
              {ACCOUNT_COLUMNS.map((c) => <th key={c} scope="col" role="columnheader">{c}</th>)}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {page.items.map((a) => {
              const isSelf = a.userId === identity.userId;
              const needsReference = a.isActive && a.onlyActiveOwnerOf.length > 0;
              const warningId = `only-owner-${a.userId}`;
              const fieldId = `reference-${a.userId}`;
              const invalid = missingReferenceFor === a.userId;
              const verb = a.isActive ? 'Deactivate' : 'Reactivate';
              return (
                <tr role="row" key={a.userId}>
                  <td role="cell" className="admin-table__name" data-label={ACCOUNT_COLUMNS[0]}>
                    {a.name}
                    {isSelf ? <span className="text-muted"> (you)</span> : null}
                  </td>
                  <td role="cell" className="admin-table__email" data-label={ACCOUNT_COLUMNS[1]}>{a.email}</td>
                  <td role="cell" data-label={ACCOUNT_COLUMNS[2]}>{a.platformRole === 'admin' ? 'MAK-AI administrator' : 'Assessor'}</td>
                  <td role="cell" data-label={ACCOUNT_COLUMNS[3]}>{a.isActive ? 'Active' : 'Deactivated'}</td>
                  <td role="cell" data-label={ACCOUNT_COLUMNS[4]}>{formatDay(a.createdAt, 'Africa/Kampala')}</td>
                  <td role="cell" className="admin-table__actions">
                    {isSelf ? null : (
                      <form action={`/api/admin/users/${encodeURIComponent(a.userId)}/role`} method="POST">
                        <input type="hidden" name="active" value={String(!a.isActive)} />
                        <input type="hidden" name="requestId" value={randomUUID()} />
                        {needsReference ? (
                          <>
                            <p id={warningId}>
                              {`${a.name} is the only active owner of ${listOf(a.onlyActiveOwnerOf)}. Deactivating needs the reference of the controller's written request.`}
                            </p>
                            <div className="form-group">
                              <label htmlFor={fieldId}>Reference of the controller&apos;s written request</label>
                              <input id={fieldId} name="requestReference" type="text" required maxLength={MAX_REQUEST_REFERENCE}
                                autoComplete="off" aria-describedby={invalid ? `${warningId} accounts-refusal` : warningId}
                                aria-invalid={invalid ? true : undefined} />
                            </div>
                          </>
                        ) : null}
                        <button type="submit" aria-label={`${verb} ${a.name}`}
                          className={`btn btn--small ${a.isActive ? 'btn--danger-outline' : 'btn--outline'}`}>{verb}</button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {page.hasMore ? <ShowMoreLink href={`?shown=${page.nextShown}`} label="Show more" /> : null}
    </div>
  );
}
