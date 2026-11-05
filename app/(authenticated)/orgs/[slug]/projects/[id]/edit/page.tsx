import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { ForbiddenError, withOrg } from '@/lib/data/tenant';
import { EditProjectView } from '@/components/project/EditProjectView';
import type { ProjectFormValues } from '../../new/NewProjectForm';

const day = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

/**
 * S-09 in edit mode. A mutating page in its own right, so it is gated on `project:update` here and not only by the hidden
 * link (D-127); a role without it gets the same 404 as the new-project page. A project not visible under row-level
 * security is a 404 as well (NFR-SEC-02).
 */
export default async function EditProjectPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const identity = await requireIdentity();
  let ctx;
  try {
    ctx = await requireOrgContextFor(identity.userId, slug, 'project:update');
  } catch (e) {
    if (e instanceof ForbiddenError) notFound();
    throw e;
  }
  const project = await withOrg(ctx, (tx) => tx.project.findUnique({ where: { id }, include: { metadata: true } }));
  if (project === null) notFound();
  const m = project.metadata;
  const initial: ProjectFormValues = {
    name: project.name, description: project.description ?? '',
    aiSystemType: m?.aiSystemType ?? null, aiSystemTypeOther: m?.aiSystemTypeOther ?? null, institution: m?.institution ?? null,
    department: m?.department ?? null, country: m?.country ?? null, developmentStage: m?.developmentStage ?? null,
    deploymentSector: m?.deploymentSector ?? null, targetPopulation: m?.targetPopulation ?? null,
    processesPersonalData: m?.processesPersonalData ?? null, datasetSize: m?.datasetSize ?? null, datasetType: m?.datasetType ?? null,
    datasetDescription: m?.datasetDescription ?? null, teamSize: m?.teamSize ?? null, fundingSource: m?.fundingSource ?? null,
    regulatoryContext: m?.regulatoryContext ?? null, projectStart: day(m?.projectStart ?? null), projectEnd: day(m?.projectEnd ?? null),
  };
  return <EditProjectView data={{ orgSlug: slug, projectId: id, archived: project.archivedAt !== null, initial }} />;
}
