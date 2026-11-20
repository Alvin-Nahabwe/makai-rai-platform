import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { loadProjectOverview } from '@/lib/data/projects';
import { loadContinueTarget } from '@/lib/home/load';
import { eatDate } from '@/lib/followup/overdue';
import { PROJECT_COPY } from '@/lib/project/copy';
import { orNotFound } from '@/lib/auth/titleGate';
import { pageTitle } from '@/lib/ui/title';
import { ProjectPage } from '@/components/project/ProjectPage';
import { loadProjectRoutes } from '@/lib/project/routes';
import RememberProject from '@/components/layout/RememberProject';

interface PageProps {
  params: Promise<{ slug: string; id: string }>;
}

/**
 * The gates and the loader, once per request: the page and its title both read through this (React `cache()`), so a
 * project that is not visible is the same `notFound()` for both and its title names nothing.
 */
const load = cache(async (slug: string, id: string) => {
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'project:read');
  const data = await loadProjectOverview(ctx, { orgSlug: slug, projectId: id, today: eatDate(new Date()) });
  if (data === null) notFound();
  // Only after the project is known visible, under the same `ctx`: each stage's marks and questions with no decision (one
  // tenant-scoped read per stage), and Home's continue target for the signed-in person, so the stage holding it links to the
  // question Home names (I1). The page's one primary action is the working report's (G5), not the continue target.
  const [continueTo, routes] = await Promise.all([
    loadContinueTarget(ctx, identity.userId, { id: data.project.id, archived: data.project.archived }),
    loadProjectRoutes(ctx, { orgSlug: slug, projectId: data.project.id }),
  ]);
  return { data, continueTo, routes, userId: identity.userId };
});

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug, id } = await params;
  return { title: pageTitle(PROJECT_COPY.titles.project, (await orNotFound(load(slug, id))).data.project.name) };
}

/**
 * S-10, the project page. No `createdById` check: every member with `project:read` may view every project of the
 * organisation (ADR-0001). The project is read inside `withOrg` first and `notFound()` follows when it is not visible,
 * before any other read, so another organisation's project is a 404 like a missing one (NFR-SEC-02).
 */
export default async function ProjectDetailPage({ params }: PageProps) {
  const { slug, id } = await params;
  const { data, continueTo, routes, userId } = await load(slug, id);
  return (
    <ProjectPage data={data} routes={routes} continueTo={continueTo}>
      <RememberProject userId={userId} orgSlug={slug} projectId={data.project.id} />
    </ProjectPage>
  );
}
