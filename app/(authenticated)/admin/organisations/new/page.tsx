import { requireIdentity } from '@/lib/auth/identity';
import { CreateOrganisationForm } from '@/components/admin/CreateOrganisationForm';
import { AdminRefusal } from '@/components/admin/AdminRefusal';
import { PageHeader } from '@/components/ui/PageHeader';
import { ADMIN_COPY } from '@/lib/admin/copy';
import { pageTitle } from '@/lib/ui/title';

export const metadata = { title: pageTitle(ADMIN_COPY.titles.newOrganisation) };

/**
 * S-24 create mode (FR-ORG-01, J-01; W-10, SRS lines 2166-2210): the organisation, the institution's legal name and
 * the first Owner's invitation in one request (route 41). A non-administrator gets only the refusal line (owner
 * default B21).
 */
export default async function NewOrganisationPage() {
  const identity = await requireIdentity();
  if (identity.platformRole !== 'admin') return <AdminRefusal />;
  return (
    <div className="page-content">
      <PageHeader title={ADMIN_COPY.titles.newOrganisation} />
      <CreateOrganisationForm />
    </div>
  );
}
