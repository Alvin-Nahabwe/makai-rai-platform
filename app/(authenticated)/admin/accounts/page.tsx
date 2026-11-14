import { randomUUID } from 'node:crypto';
import { requireIdentity } from '@/lib/auth/identity';
import { accountsForAdmin } from '@/lib/data/admin';
import { formatDay } from '@/lib/format/dates';
import { LIST_PAGE_SIZE, pageOf } from '@/lib/ui/showMore';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { Table } from '@/components/ui/Table';
import { FieldLabel } from '@/components/ui/TextInput';
import { AdminRefusal } from '@/components/admin/AdminRefusal';
import { ADMIN_COPY } from '@/lib/admin/copy';
import { pageTitle } from '@/lib/ui/title';
import '@/components/admin/AdminForms.css';

export const metadata = { title: pageTitle(ADMIN_COPY.titles.accounts) };

const A = ADMIN_COPY.accounts;
const REFUSALS: Readonly<Record<string, string>> = A.refusals;

/** The longest request reference route 47 accepts. */
const MAX_REQUEST_REFERENCE = 200;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * S-25, the MAK-AI administrator's accounts (FR-ORG-07, NFR-SEC-19; SRS line 1639 fixes the address). One
 * row per account with its account type and state; Deactivate or Reactivate for every account but the
 * administrator's own, posted as a form to route 47. Before deactivating the only active Owner of an
 * organisation the row names the organisation and asks for the reference of the organisation's written
 * request, which the field requires and route 47 and the definer function require again. Route 47 never
 * grants the platform role, so there is no control for it. A refusal comes back as `?error=<code>` and is
 * shown as one alert; an unknown code shows nothing. The list comes 50 at a time with "Show more" (UX-40).
 *
 * The table is the kit's (plan 1A Task 19, ruling L5-2). The action cell keeps its native form, with a native input
 * and button in the kit's classes: the input is described by the warning sentence outside it, and the button carries
 * an accessible name with the account's name, which the kit's TextInput and Button cannot take (ruling T19-j).
 * No kit stylesheet is imported here (ruling X-6): the field's rules arrive with `FieldLabel`'s module and the
 * button's with the kit Button the signed-in layout loads (`components/layout/IdleWarning.tsx`).
 *
 * A signed-in account without the platform role gets only the refusal line, with status 200 (owner default
 * B21, as S-23).
 */
export default async function AccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await requireIdentity();
  if (identity.platformRole !== 'admin') return <AdminRefusal />;
  const query = await searchParams;
  const error = one(query.error);
  const refusal = error !== undefined && Object.hasOwn(REFUSALS, error) ? REFUSALS[error] : null;
  const missingReferenceFor = error === 'request_reference_required' ? one(query.user) : undefined;
  const page = pageOf(await accountsForAdmin(), one(query.shown) ?? null, LIST_PAGE_SIZE);   // UX-40: 50 at a time
  const columns = [
    { key: 'name', label: A.columns.name }, { key: 'email', label: A.columns.email }, { key: 'type', label: A.columns.type },
    { key: 'status', label: A.columns.status }, { key: 'created', label: A.columns.created }, { key: 'actions', label: A.columns.actions },
  ] as const;

  const rows = page.items.map((a) => {
    const isSelf = a.userId === identity.userId;
    const needsReference = a.isActive && a.onlyActiveOwnerOf.length > 0;
    const warningId = `only-owner-${a.userId}`;
    const fieldId = `reference-${a.userId}`;
    const invalid = missingReferenceFor === a.userId;
    const verb = a.isActive ? A.deactivate : A.reactivate;
    return {
      key: a.userId,
      cells: {
        name: <>{a.name}{isSelf ? <span className="admin-account__you">{A.you}</span> : null}</>,
        email: <span className="admin-account__email">{a.email}</span>,
        type: a.platformRole === 'admin' ? A.typeAdmin : A.typeMember,
        status: a.isActive ? A.active : A.deactivated,
        created: formatDay(a.createdAt, 'Africa/Kampala'),
        actions: isSelf ? null : (
          // The form starts with its action (no class before it): the layout is on the wrapper inside.
          <form action={`/api/admin/users/${encodeURIComponent(a.userId)}/role`} method="POST">
            <div className="admin-account__form">
              <input type="hidden" name="active" value={String(!a.isActive)} />
              <input type="hidden" name="requestId" value={randomUUID()} />
              {needsReference ? (
                <>
                  <p id={warningId} className="admin-account__warning">{A.onlyOwner(a.name, A.listOf(a.onlyActiveOwnerOf))}</p>
                  <div className="ui-field">
                    <FieldLabel htmlFor={fieldId} label={A.referenceLabel} required />
                    <input id={fieldId} name="requestReference" type="text" required maxLength={MAX_REQUEST_REFERENCE}
                      className={invalid ? 'ui-input ui-input--invalid' : 'ui-input'}
                      autoComplete="off" aria-describedby={invalid ? `${warningId} accounts-refusal` : warningId}
                      aria-invalid={invalid ? true : undefined} />
                  </div>
                </>
              ) : null}
              <button type="submit" aria-label={A.actionName(verb, a.name)}
                className={`ui-button ${a.isActive ? 'ui-button--destructive' : 'ui-button--secondary'} ui-button--compact`}>{verb}</button>
            </div>
          </form>
        ),
      },
    };
  });

  return (
    <div className="page-content">
      <PageHeader title={ADMIN_COPY.titles.accounts} />
      {refusal !== null ? <StatusRegion id="accounts-refusal" politeness="assertive" tone="error" message={refusal} /> : null}
      <Table caption={A.caption} columns={columns} rows={rows} rowHeaderKey="name" />
      {page.hasMore ? <ShowMoreLink href={`?shown=${page.nextShown}`} label={A.showMore} /> : null}
    </div>
  );
}
