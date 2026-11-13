import { cache } from 'react';
import type { Metadata } from 'next';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { ForbiddenError, withOrg } from '@/lib/data/tenant';
import { estimateTeamExport } from '@/lib/data/export';
import { TeamExportPanel, refusedFrom } from '@/components/export/TeamExportPanel';
import { EXPORT_NOT_ALLOWED } from '@/lib/export/messages';
import { EXPORT_COPY } from '@/lib/export/copy';
import { orNotFound } from '@/lib/auth/titleGate';
import { pageTitle } from '@/lib/ui/title';

type Params = Promise<{ slug: string }>;

/**
 * The gates and the organisation's name, once per request: the page and its title both read through this (React
 * `cache()`). A role without `team:export` is `refused` before the name is read, so its title names no organisation.
 */
const load = cache(async (slug: string) => {
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
  const org = await withOrg(ctx, (tx) => tx.organization.findFirstOrThrow({ where: { id: ctx.orgId }, select: { name: true } }));
  return { refused: false, ctx, org } as const;
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const loaded = await orNotFound(load((await params).slug));
  return { title: pageTitle(EXPORT_COPY.titles.downloadRecords, loaded.refused ? null : loaded.org.name) };
}

/**
 * S-20 for the whole organisation (`/orgs/[slug]/export`; FR-EXP-01, M-37). Owners and admins only
 * (`team:export`); another role sees M-26 (contract Q9, B21). `?refused=` carries the reason a press of the link was refused (route 20 or the proxy; owner question B4).
 */
export default async function OrgExportPage({ params, searchParams }: {
  params: Params;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const loaded = await load(slug);
  if (loaded.refused) return <div className="page-content"><h1>Team export</h1><p>{EXPORT_NOT_ALLOWED}</p></div>;
  const { ctx, org } = loaded;
  const aboutBytes = await estimateTeamExport(ctx, null);
  return (
    <div className="page-content">
      <h1>Team export</h1>
      <p>Everything your organisation recorded, with its history, every evidence file and every issued document.</p>
      <TeamExportPanel href={`/api/v1/orgs/${slug}/export`} scopeName={org.name} aboutBytes={aboutBytes} refused={refusedFrom(await searchParams)} />
    </div>
  );
}
