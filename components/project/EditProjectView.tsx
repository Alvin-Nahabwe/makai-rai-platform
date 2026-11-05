import type { ReactElement } from 'react';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import NewProjectForm, { type ProjectFormValues } from '@/app/(authenticated)/orgs/[slug]/projects/new/NewProjectForm';

/** S-09 in edit mode (FR-PRJ-01): the form for a live project; for an archived one only the banner, and no form (UX-31). */
export function EditProjectView({ data }: { data: { orgSlug: string; projectId: string; archived: boolean; initial: ProjectFormValues } }): ReactElement {
  if (data.archived) {
    return (
      <div className="page-content">
        <h1>Edit project</h1>
        <ArchivedBanner archived />
      </div>
    );
  }
  return <NewProjectForm mode="edit" projectId={data.projectId} initial={data.initial} />;
}
