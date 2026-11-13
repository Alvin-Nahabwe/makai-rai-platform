import { requireIdentity } from '@/lib/auth/identity';
import { CreateOrganisationForm } from '@/components/admin/CreateOrganisationForm';
import { ADMIN_COPY } from '@/lib/admin/copy';
import { pageTitle } from '@/lib/ui/title';

export const metadata = { title: pageTitle(ADMIN_COPY.titles.newOrganisation) };

/**
 * S-24 create mode (FR-ORG-01, J-01; W-10, SRS lines 2166-2210): the organisation, the institution's legal name and
 * the first owner's invitation in one request (route 41). A non-administrator gets only the refusal line (owner
 * default B21).
 */
export default async function NewOrganisationPage() {
  const identity = await requireIdentity();
  if (identity.platformRole !== 'admin') {
    return (
      <div className="page-content">
        <p>This page is for MAK-AI administrators.</p>
      </div>
    );
  }
  return (
    <div className="page-content">
      <div className="page-header">
        <h1>Create an organisation</h1>
      </div>
      <CreateOrganisationForm />
    </div>
  );
}
