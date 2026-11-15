import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { organisationForAdmin } from '@/lib/data/admin';
import { NotFoundError } from '@/lib/data/tenant';
import { formatDay } from '@/lib/format/dates';
import { OwnerInvitationBox } from '@/components/admin/OwnerInvitationBox';
import { AgreementRecords } from '@/components/admin/AgreementRecords';
import { CorrectNameForm } from '@/components/admin/CorrectNameForm';
import { CorrectLegalNameForm } from '@/components/admin/CorrectLegalNameForm';
import { AdminRefusal } from '@/components/admin/AdminRefusal';
import { PageHeader } from '@/components/ui/PageHeader';
import { ADMIN_COPY } from '@/lib/admin/copy';
import { pageTitle } from '@/lib/ui/title';
import '@/components/admin/AdminForms.css';

type Params = Promise<{ id: string }>;

/**
 * The gate, then the read, once per request: the page and its title both pass through this (React `cache()`). The gate
 * comes first and a refused person is never read for: `refused` is all a non-administrator gets. An unknown id is
 * `missing`, told apart from nothing else; any other failure of the read is thrown, to the page and the title alike.
 */
const load = cache(async (id: string) => {
  const identity = await requireIdentity();
  if (identity.platformRole !== 'admin') return { kind: 'refused' as const };
  try {
    return { kind: 'found' as const, detail: await organisationForAdmin(id) };
  } catch (e) {
    if (e instanceof NotFoundError) return { kind: 'missing' as const };
    throw e;
  }
});

/**
 * The tab title (ruling L5-13, spec 7.5): "Organisation · {name} · " and the product name, for the administrator on an
 * organisation that exists; the static "Organisation · " and the product name for anyone else and for an unknown id, so
 * the title says nothing the page would not.
 */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const loaded = await load((await params).id);
  return { title: pageTitle(ADMIN_COPY.titles.organisation, loaded.kind === 'found' ? loaded.detail.row.name : null) };
}

/**
 * S-24 detail mode (FR-ORG-02, FR-ORG-05, FR-ORG-06, FR-ORG-10; W-10 note 2): only the name, legal name, creation
 * date, member count, owner invitation state and, as history, the earlier agreement records, read on the
 * identity lane by `organisationForAdmin`,
 * which reaches no record table (FR-ORG-03). An unknown id is S-31 (404). A non-administrator gets only the
 * refusal line (owner default B21).
 */
export default async function OrganisationPage({ params }: { params: Params }) {
  const loaded = await load((await params).id);
  if (loaded.kind === 'refused') return <AdminRefusal />;
  if (loaded.kind === 'missing') notFound();
  const { row, agreements, ownerInvitations } = loaded.detail;
  const O = ADMIN_COPY.organisation;
  return (
    <div className="page-content">
      <PageHeader title={row.name} />
      {/* Each state is its own label on its own line (R1 S1, S2), as in the Organisations list's cells. */}
      <p>
        {O.summary(formatDay(row.createdAt, 'Africa/Kampala'), row.memberCount)}
        {row.archived ? <span className="admin-flag">{O.archived}</span> : null}
        {row.hasActiveOwner ? null : <strong className="admin-flag">{ADMIN_COPY.organisations.noActiveOwner}</strong>}
      </p>
      <p className="admin-facts">{row.legalName === null ? <strong>{ADMIN_COPY.organisations.legalNameMissing}</strong> : O.legalName(row.legalName)}</p>
      <CorrectNameForm orgId={row.orgId} name={row.name} />
      <CorrectLegalNameForm orgId={row.orgId} legalName={row.legalName} />
      <OwnerInvitationBox orgId={row.orgId} hasActiveOwner={row.hasActiveOwner} invitations={ownerInvitations} archived={row.archived} />
      <AgreementRecords agreements={agreements} />
    </div>
  );
}
