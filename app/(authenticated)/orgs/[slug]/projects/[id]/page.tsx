import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { loadProjectOverview } from '@/lib/data/projects';
import { eatDate } from '@/lib/followup/overdue';
import { PROJECT_COPY } from '@/lib/project/copy';
import { pageTitle } from '@/lib/ui/title';
import { ProjectOverview } from '@/components/project/ProjectOverview';

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
  return data;
});

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug, id } = await params;
  return { title: pageTitle(PROJECT_COPY.titles.project, (await load(slug, id)).project.name) };
}

/**
 * S-10, the stage view. No `createdById` check: every member with `project:read` may view every project of the
 * organisation (ADR-0001). The project is read inside `withOrg` first and `notFound()` follows when it is not visible,
 * before any other read, so another organisation's project is a 404 like a missing one (NFR-SEC-02).
 */
export default async function ProjectDetailPage({ params }: PageProps) {
  const { slug, id } = await params;
  return <ProjectOverview data={await load(slug, id)} />;
}
