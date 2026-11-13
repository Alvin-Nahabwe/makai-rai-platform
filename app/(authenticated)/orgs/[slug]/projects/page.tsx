import { cache } from 'react';
import type { Metadata } from 'next';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { listProjectRows } from '@/lib/data/projects';
import { can } from '@/lib/authz/policy';
import { ORG_COPY } from '@/lib/org/copy';
import { pageTitle } from '@/lib/ui/title';
import { pageOf, LIST_PAGE_SIZE } from '@/lib/ui/showMore';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import { AllProjectsView } from '@/components/project/AllProjectsView';

type Params = Promise<{ slug: string }>;

/** The gates, once per request: the page and its title both pass through this (React `cache()`). */
const load = cache(async (slug: string) => {
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'project:read');
  return { ctx };
});

/**
 * The organisation's name, for the title only: read after the cached gates have passed, so a caller they refuse gets
 * their answer (the same redirect, `notFound()` or error as the page) and no name. The page itself does not read it.
 */
const orgNameOf = cache(async (slug: string): Promise<string> => {
  const { ctx } = await load(slug);
  const org = await withOrg(ctx, (tx) => tx.organization.findFirstOrThrow({ where: { id: ctx.orgId }, select: { name: true } }));
  return org.name;
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return { title: pageTitle(ORG_COPY.titles.projects, await orgNameOf((await params).slug)) };
}

/**
 * S-32, all projects, active and archived: a long list (UX-37, UX-40), so each list shows 50 and a "Show more" link asks
 * for more with `?shown=`. Every member reads; unarchive is for owners and admins.
 */
export default async function ProjectsPage({
  params, searchParams,
}: {
  params: Params;
  searchParams: Promise<{ shown?: string | string[] }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const { ctx } = await load(slug);
  const { active, archived } = await listProjectRows(ctx);
  const shown = typeof query.shown === 'string' ? query.shown : null;
  const a = pageOf(active, shown, LIST_PAGE_SIZE);
  const b = pageOf(archived, shown, LIST_PAGE_SIZE);
  const more = a.hasMore ? a : b.hasMore ? b : null;
  return (
    <AllProjectsView
      data={{ orgSlug: slug, canCreate: can(ctx.role, 'project:create'), canUnarchive: can(ctx.role, 'project:archive'), active: a.items, archived: b.items }}
    >
      {more !== null ? <ShowMoreLink href={`?shown=${more.nextShown}`} label="Show more" /> : null}
    </AllProjectsView>
  );
}
