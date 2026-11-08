import { requireIdentity } from '@/lib/auth/identity';
import { legalTextHistory } from '@/lib/legal/registry';
import { eatDate } from '@/lib/followup/overdue';
import { CreateOrganisationForm } from '@/components/admin/CreateOrganisationForm';

export const metadata = { title: 'Create an organisation' };

/**
 * S-24 create mode (FR-ORG-01, J-01; W-10, SRS lines 2166-2210): the organisation, its agreement record and the
 * first owner's invitation in one request (route 41). The agreement versions offered are the ones the registry
 * publishes for `organisation-agreement`, each with its own text hash; the form refuses an accepted date after
 * today in East Africa Time. A non-administrator gets only the refusal line (owner default B21).
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
  const versions = legalTextHistory('organisation-agreement').map((t) => ({ version: t.version, publishedOn: t.publishedOn, sha256: t.sha256 }));
  return (
    <div className="page-content">
      <div className="page-header">
        <h1>Create an organisation</h1>
      </div>
      <p>Only do this after the organisation and MAK-AI have signed the organisation agreement.</p>
      <CreateOrganisationForm versions={versions} today={eatDate(new Date())} />
    </div>
  );
}
