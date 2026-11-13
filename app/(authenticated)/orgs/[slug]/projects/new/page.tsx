import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { ForbiddenError, withOrg } from '@/lib/data/tenant';
import { ORG_COPY } from '@/lib/org/copy';
import { pageTitle } from '@/lib/ui/title';
import ProjectForm from '@/components/project/ProjectForm';

type Params = Promise<{ slug: string }>;

/**
 * The gate, once per request: the page and its title both pass through this (React `cache()`), so a refused caller gets
 * the same `notFound()` from either.
 */
const load = cache(async (slug: string) => {
  const identity = await requireIdentity();

  let ctx;
  try {
    ctx = await requireOrgContextFor(identity.userId, slug, 'project:create');
  } catch (e) {
    if (e instanceof ForbiddenError) notFound();
    throw e;
  }

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
  return { title: pageTitle(ORG_COPY.titles.newProject, await orgNameOf((await params).slug)) };
}

/**
 * S-09 in create mode. D-127: this page is a mutating control in its own right, reachable by direct navigation whether
 * or not the link that points here is hidden, so the route is gated on `project:create` here too. `ForbiddenError`
 * becomes `notFound()`: the caller is already a proven member (the layout checked `org:read`), and one fail-closed shape
 * serves every refusal.
 */
export default async function NewProjectPage({ params }: { params: Params }) {
  const { slug } = await params;
  await load(slug);
  return <ProjectForm mode="create" />;
}
