import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { organisationForAdmin } from '@/lib/data/admin';
import { NotFoundError } from '@/lib/data/tenant';
import { legalTextHistory } from '@/lib/legal/registry';
import { eatDate } from '@/lib/followup/overdue';
import { formatDay } from '@/lib/format/dates';
import { OwnerInvitationBox } from '@/components/admin/OwnerInvitationBox';
import { AgreementRecords } from '@/components/admin/AgreementRecords';
import { CorrectNameForm } from '@/components/admin/CorrectNameForm';

export const metadata = { title: 'Organisation' };

/**
 * S-24 detail mode (FR-ORG-02, FR-ORG-05, FR-ORG-06, FR-ORG-10; W-10 note 2): only the name, creation date, member
 * count, agreement records and first-owner invitation state, read on the identity lane by `organisationForAdmin`,
 * which reaches no record table (FR-ORG-03). An unknown id is S-31 (404). A non-administrator gets only the
 * refusal line (owner default B21).
 */
export default async function OrganisationPage({ params }: { params: Promise<{ id: string }> }) {
  const identity = await requireIdentity();
  if (identity.platformRole !== 'admin') {
    return (
      <div className="page-content">
        <p>This page is for MAK-AI administrators.</p>
      </div>
    );
  }
  const { id } = await params;
  let detail;
  try {
    detail = await organisationForAdmin(id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const { row, agreements, ownerInvitations } = detail;
  const versions = legalTextHistory('organisation-agreement').map((t) => ({ version: t.version, publishedOn: t.publishedOn, sha256: t.sha256 }));
  return (
    <div className="page-content">
      <div className="page-header">
        <h1>{row.name}</h1>
      </div>
      <p>
        {`Created ${formatDay(row.createdAt, 'Africa/Kampala')} · ${row.memberCount} ${row.memberCount === 1 ? 'member' : 'members'}`}
        {row.archived ? ' · archived' : ''}
        {row.hasActiveOwner ? null : <strong> · No active owner</strong>}
      </p>
      <CorrectNameForm orgId={row.orgId} name={row.name} />
      <OwnerInvitationBox orgId={row.orgId} hasActiveOwner={row.hasActiveOwner} invitations={ownerInvitations} archived={row.archived} />
      <AgreementRecords orgId={row.orgId} agreements={agreements} versions={versions} today={eatDate(new Date())} />
    </div>
  );
}
