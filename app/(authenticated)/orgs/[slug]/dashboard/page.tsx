import { cache } from 'react';
import type { Metadata } from 'next';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { loadDashboard } from '@/lib/data/projects';
import { eatDate } from '@/lib/followup/overdue';
import { HOME_COPY } from '@/lib/home/copy';
import { orNotFound } from '@/lib/auth/titleGate';
import { pageTitle } from '@/lib/ui/title';
import { DashboardView } from '@/components/project/DashboardView';

type Params = Promise<{ slug: string }>;
type Search = Promise<{ welcome?: string | string[] }>;

/** `?welcome=1` as the one primitive both callers pass, so they share the cached load. */
const welcomeOf = async (searchParams: Search): Promise<string | null> => ((await searchParams).welcome === '1' ? '1' : null);

/**
 * The gates and the loader, once per request: the page and its title both read through this (React `cache()`), so the
 * title names the organisation only after the same `project:read` check the page passes.
 */
const load = cache(async (slug: string, welcome: string | null) => {
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'project:read');
  return loadDashboard(ctx, identity, { orgSlug: slug, welcome: welcome === '1', today: eatDate(new Date()) });
});

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: Search }): Promise<Metadata> {
  const { slug } = await params;
  const data = await orNotFound(load(slug, await welcomeOf(searchParams)));
  return { title: pageTitle(HOME_COPY.titles.home, data.orgName) };
}

/**
 * S-08, team-wide, not "my projects": every active project of the organisation, with RLS (via `withOrg`) the only filter
 * (ADR-0001). "My mitigations" always takes the signed-in person's own id from the session, never a query value
 * (obligation P7). `searchParams` is a Promise in Next 16 (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md).
 */
export default async function DashboardPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { slug } = await params;
  const data = await load(slug, await welcomeOf(searchParams));
  return <DashboardView data={data} />;
}
