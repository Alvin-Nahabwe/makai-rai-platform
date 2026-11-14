import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { ForbiddenError, withOrg } from '@/lib/data/tenant';
import { estimateTeamExport } from '@/lib/data/export';
import { TeamExportPanel, refusedFrom } from '@/components/export/TeamExportPanel';
import { EXPORT_NOT_ALLOWED } from '@/lib/export/messages';
import { EXPORT_COPY } from '@/lib/export/copy';
import { orNotFound } from '@/lib/auth/titleGate';
import { pageTitle } from '@/lib/ui/title';
import { PageHeader } from '@/components/ui/PageHeader';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import RememberProject from '@/components/layout/RememberProject';

type Params = Promise<{ slug: string; id: string }>;

/**
 * The gates and the project read, once per request: the page and its title both read through this (React `cache()`).
 * A role without `team:export` is `refused` before the project is read, and a project not visible is `notFound()` for
 * both, so neither title names a project.
 */
const load = cache(async (slug: string, id: string) => {
  const identity = await requireIdentity();
  let ctx;
  try {
    ctx = await requireOrgContextFor(identity.userId, slug, 'team:export');
  } catch (e) {
    // A member whose role lacks team:export sees M-26 in the page, status 200, and nothing of the scope
    // (contract Q9, owner question B21). A non-member never gets here: requireOrgContextFor answers not found.
    if (e instanceof ForbiddenError) return { refused: true } as const;
    throw e;
  }
  const project = await withOrg(ctx, (tx) => tx.project.findUnique({ where: { id }, select: { id: true, name: true, archivedAt: true } }));
  if (project === null) notFound();
  return { refused: false, ctx, project, userId: identity.userId } as const;
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, id } = await params;
  const loaded = await orNotFound(load(slug, id));
  return { title: pageTitle(EXPORT_COPY.titles.downloadRecords, loaded.refused ? null : loaded.project.name) };
}

/**
 * S-20 for one project (`/orgs/[slug]/projects/[id]/export`; FR-EXP-01, M-37). Owners and admins only
 * (`team:export`). The project is read by id inside `withOrg`, so a project of another organisation is not
 * found before anything of it is read or sized (NFR-SEC-02, obligation E14). An archived project can still
 * be exported, under its banner (UX-31).
 */
export default async function ProjectExportPage({ params, searchParams }: {
  params: Params;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, id } = await params;
  const loaded = await load(slug, id);
  if (loaded.refused) return <div className="page-content"><PageHeader title={EXPORT_COPY.titles.downloadRecords} /><p>{EXPORT_NOT_ALLOWED}</p></div>;
  const { ctx, project, userId } = loaded;
  const aboutBytes = await estimateTeamExport(ctx, project.id);
  return (
    <div className="page-content">
      <PageHeader title={EXPORT_COPY.titles.downloadRecords} />
      <ArchivedBanner archived={project.archivedAt !== null} />
      <p>{EXPORT_COPY.intro.project}</p>
      <TeamExportPanel href={`/api/v1/orgs/${slug}/export?projectId=${encodeURIComponent(project.id)}`} scopeName={project.name}
        aboutBytes={aboutBytes} refused={refusedFrom(await searchParams)} />
      <RememberProject userId={userId} orgSlug={slug} projectId={project.id} />
    </div>
  );
}
