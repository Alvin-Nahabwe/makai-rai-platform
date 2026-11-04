import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { ForbiddenError, withOrg } from '@/lib/data/tenant';
import { estimateTeamExport } from '@/lib/data/export';
import { TeamExportPanel, refusedFrom } from '@/components/export/TeamExportPanel';

/**
 * S-20 for the whole organisation (`/orgs/[slug]/export`; FR-EXP-01, M-37). Owners and admins only
 * (`team:export`); another role gets the not-found page, as the other role-gated pages of `/orgs/[slug]`
 * do. `?refused=` carries the reason a press of the link was refused (route 20 or the proxy; owner question B4).
 */
export default async function OrgExportPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const identity = await requireIdentity();
  let ctx;
  try {
    ctx = await requireOrgContextFor(identity.userId, slug, 'team:export');
  } catch (e) {
    if (e instanceof ForbiddenError) notFound();
    throw e;
  }
  const org = await withOrg(ctx, (tx) => tx.organization.findFirstOrThrow({ select: { name: true } }));
  const aboutBytes = await estimateTeamExport(ctx, null);
  return (
    <div className="page-content">
      <h1>Team export</h1>
      <p>Everything your organisation recorded, with its history, every evidence file and every issued document.</p>
      <TeamExportPanel href={`/api/v1/orgs/${slug}/export`} scopeName={org.name} aboutBytes={aboutBytes} refused={refusedFrom(await searchParams)} />
    </div>
  );
}
