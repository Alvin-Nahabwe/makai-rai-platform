import { cache } from 'react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { listProjectRows } from '@/lib/data/projects';
import { can } from '@/lib/authz/policy';
import { ORG_COPY } from '@/lib/org/copy';
import { orNotFound } from '@/lib/auth/titleGate';
import { pageTitle } from '@/lib/ui/title';
import { pageOf, LIST_PAGE_SIZE } from '@/lib/ui/showMore';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import { AllProjectsView } from '@/components/project/AllProjectsView';
import { isUuid } from '@/lib/shell/nav';

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
  return { title: pageTitle(ORG_COPY.titles.projects, await orNotFound(orgNameOf((await params).slug))) };
}

/**
 * S-32, all projects, active and archived: a long list (UX-37, UX-40), so each list shows 50 and a "Show more" link asks
 * for more with `?shown=`. Every member reads; unarchive is for owners and admins.
 *
 * `?for=findings` is the rail's Findings link (plan 1A Task 12, L2-65). It goes to the findings of the project in `last`
 * when that is one of the rows this organisation's own read just returned (S1), else of the organisation's only project;
 * otherwise the page asks the person to choose, and every project links to its findings. A `last` that matches no row,
 * whatever it is, takes exactly the path of no `last` (S2), and the address is built from the row's id and the route's
 * slug, never from the query's text (S3).
 */
export default async function ProjectsPage({
  params, searchParams,
}: {
  params: Params;
  searchParams: Promise<{ shown?: string | string[]; for?: string | string[]; last?: string | string[] }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const { ctx } = await load(slug);
  const { active, archived } = await listProjectRows(ctx);
  const forFindings = query.for === 'findings';
  if (forFindings) {
    const all = [...active, ...archived];
    const last = isUuid(query.last) ? query.last : null;
    const target = (last === null ? undefined : all.find((p) => p.id === last)) ?? (all.length === 1 ? all[0] : undefined);
    if (target !== undefined) redirect(`/orgs/${slug}/projects/${target.id}/findings`);
  }
  const shown = typeof query.shown === 'string' ? query.shown : null;
  const a = pageOf(active, shown, LIST_PAGE_SIZE);
  const b = pageOf(archived, shown, LIST_PAGE_SIZE);
  const more = a.hasMore ? a : b.hasMore ? b : null;
  return (
    <AllProjectsView
      data={{ orgSlug: slug, canCreate: can(ctx.role, 'project:create'), canUnarchive: can(ctx.role, 'project:archive'), active: a.items, archived: b.items, forFindings }}
    >
      {more !== null ? <ShowMoreLink href={`?${forFindings ? 'for=findings&' : ''}shown=${more.nextShown}`} label="Show more" /> : null}
    </AllProjectsView>
  );
}
