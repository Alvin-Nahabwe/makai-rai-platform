import type { Metadata } from 'next';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { ForbiddenError, withOrg } from '@/lib/data/tenant';
import { estimateTeamExport } from '@/lib/data/export';
import { TeamExportPanel, refusedFrom } from '@/components/export/TeamExportPanel';
import { EXPORT_NOT_ALLOWED } from '@/lib/export/messages';

export const metadata: Metadata = { title: 'Team export - MAK-AI RAI Platform' };

/**
 * S-20 for the whole organisation (`/orgs/[slug]/export`; FR-EXP-01, M-37). Owners and admins only
 * (`team:export`); another role sees M-26 (contract Q9, B21). `?refused=` carries the reason a press of the link was refused (route 20 or the proxy; owner question B4).
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
    // A member whose role lacks team:export sees M-26 in the page, status 200, and nothing of the scope
    // (contract Q9, owner question B21). A non-member never gets here: requireOrgContextFor answers not found.
    if (e instanceof ForbiddenError) return <div className="page-content"><h1>Team export</h1><p>{EXPORT_NOT_ALLOWED}</p></div>;
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
