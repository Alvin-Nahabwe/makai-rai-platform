import { cache } from 'react';
import type { Metadata } from 'next';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { can } from '@/lib/authz/policy';
import { withOrg } from '@/lib/data/tenant';
import { listInvitations, listMembers } from '@/lib/data/members';
import { ORG_COPY } from '@/lib/org/copy';
import { pageTitle } from '@/lib/ui/title';
import { LIST_PAGE_SIZE, pageOf } from '@/lib/ui/showMore';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import MembersManager from './MembersManager';

type Params = Promise<{ slug: string }>;

/** The gates, once per request: the page and its title both pass through this (React `cache()`). */
const load = cache(async (slug: string) => {
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'member:read');
  return { identity, ctx };
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
  return { title: pageTitle(ORG_COPY.titles.members, await orgNameOf((await params).slug)) };
}

/**
 * S-22, Members (FR-MEM-01 to FR-MEM-05; UX-37, UX-40). Members are a long list: the first 50 show, and
 * "Show more" is a plain link to the same page with a larger `shown` (no prefetching link). Only roles that hold
 * `member:invite` are given the pending invitations, whose addresses other members must not see (obligation M10).
 */
export default async function MembersSettingsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<{ shown?: string }>;
}) {
  const { slug } = await params;
  const shown = (await searchParams).shown ?? null;
  const { identity, ctx } = await load(slug);

  const members = pageOf(await listMembers(ctx), shown, LIST_PAGE_SIZE);
  const invitations = can(ctx.role, 'member:invite') ? await listInvitations(ctx, new Date()) : [];

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Members</h1>
          <p className="text-muted">Manage who belongs to this organisation and at what role.</p>
        </div>
      </div>
      <MembersManager slug={slug} currentUserId={identity.userId} currentRole={ctx.role} members={members.items} invitations={invitations} />
      {members.hasMore && <ShowMoreLink href={'?shown=' + members.nextShown} label="Show more" />}
    </div>
  );
}
