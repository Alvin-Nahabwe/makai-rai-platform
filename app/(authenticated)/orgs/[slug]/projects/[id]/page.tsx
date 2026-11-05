import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { loadProjectOverview } from '@/lib/data/projects';
import { eatDate } from '@/lib/followup/overdue';
import { ProjectOverview } from '@/components/project/ProjectOverview';

interface PageProps {
  params: Promise<{ slug: string; id: string }>;
}

/**
 * S-10, the stage view. No `createdById` check: every member with `project:read` may view every project of the
 * organisation (ADR-0001). The project is read inside `withOrg` first and `notFound()` follows when it is not visible,
 * before any other read, so another organisation's project is a 404 like a missing one (NFR-SEC-02).
 */
export default async function ProjectDetailPage({ params }: PageProps) {
  const { slug, id } = await params;
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'project:read');
  const data = await loadProjectOverview(ctx, { orgSlug: slug, projectId: id, today: eatDate(new Date()) });
  if (data === null) notFound();
  return <ProjectOverview data={data} />;
}
