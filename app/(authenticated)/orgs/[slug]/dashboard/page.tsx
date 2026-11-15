import { cache } from 'react';
import type { Metadata } from 'next';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { loadHome } from '@/lib/home/load';
import { eatDate } from '@/lib/followup/overdue';
import { HOME_COPY } from '@/lib/home/copy';
import { orNotFound } from '@/lib/auth/titleGate';
import { pageTitle } from '@/lib/ui/title';
import { HomeView } from '@/components/home/HomeView';

type Params = Promise<{ slug: string }>;
type Search = Promise<{ welcome?: string | string[] }>;

/** `?welcome=1` as the one primitive both callers pass, so they share the cached load. */
const welcomeOf = async (searchParams: Search): Promise<string | null> => ((await searchParams).welcome === '1' ? '1' : null);

/**
 * The gates and the loader, once per request: the page and its title both read through this (React `cache()`), so the
 * title names the organisation only after the same `project:read` check the page passes. Gates first: the identity from
 * the session, then this organisation's context for `project:read`, then Home's data for that person (T9.2: the id is
 * the session's, never a query value). No error is caught: a failed read is the error page, never an empty Home (T9.7).
 * "Today" for overdue stays `eatDate(new Date())` (D5).
 */
const load = cache(async (slug: string, welcome: string | null) => {
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'project:read');
  const now = new Date();
  // The users table holds a name for every account; Identity types it as nullable, so the name falls back to the
  // email as the question page's viewer does (lib/question/panel.ts), rather than greeting nobody.
  const name = identity.name ?? identity.email;
  return loadHome(ctx, { userId: identity.userId, name }, { orgSlug: slug, welcome: welcome === '1', today: eatDate(now), now });
});

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: Search }): Promise<Metadata> {
  const { slug } = await params;
  const data = await orNotFound(load(slug, await welcomeOf(searchParams)));
  return { title: pageTitle(HOME_COPY.titles.home, data.base.orgName) };
}

/**
 * Home (spec 9.1, plan 1B Task 10), per organisation and per role. `searchParams` is a Promise in Next 16
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md).
 */
export default async function HomePage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { slug } = await params;
  return <HomeView data={await load(slug, await welcomeOf(searchParams))} />;
}
