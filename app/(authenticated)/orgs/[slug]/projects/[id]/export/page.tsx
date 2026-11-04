import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { ForbiddenError, withOrg } from '@/lib/data/tenant';
import { estimateTeamExport } from '@/lib/data/export';
import { TeamExportPanel, refusedFrom } from '@/components/export/TeamExportPanel';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';

export const metadata: Metadata = { title: 'Team export - MAK-AI RAI Platform' };

/**
 * S-20 for one project (`/orgs/[slug]/projects/[id]/export`; FR-EXP-01, M-37). Owners and admins only
 * (`team:export`). The project is read by id inside `withOrg`, so a project of another organisation is not
 * found before anything of it is read or sized (NFR-SEC-02, obligation E14). An archived project can still
 * be exported, under its banner (UX-31).
 */
export default async function ProjectExportPage({ params, searchParams }: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, id } = await params;
  const identity = await requireIdentity();
  let ctx;
  try {
    ctx = await requireOrgContextFor(identity.userId, slug, 'team:export');
  } catch (e) {
    if (e instanceof ForbiddenError) notFound();
    throw e;
  }
  const project = await withOrg(ctx, (tx) => tx.project.findUnique({ where: { id }, select: { id: true, name: true, archivedAt: true } }));
  if (project === null) notFound();
  const aboutBytes = await estimateTeamExport(ctx, project.id);
  return (
    <div className="page-content">
      <h1>Team export</h1>
      <ArchivedBanner archived={project.archivedAt !== null} />
      <p>This project&apos;s records, with their history, its evidence files and its issued documents.</p>
      <TeamExportPanel href={`/api/v1/orgs/${slug}/export?projectId=${encodeURIComponent(project.id)}`} scopeName={project.name}
        aboutBytes={aboutBytes} refused={refusedFrom(await searchParams)} />
    </div>
  );
}
