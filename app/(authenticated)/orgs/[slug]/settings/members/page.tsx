import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { can } from '@/lib/authz/policy';
import { listInvitations, listMembers } from '@/lib/data/members';
import { LIST_PAGE_SIZE, pageOf } from '@/lib/ui/showMore';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import MembersManager from './MembersManager';

/**
 * S-22, Members (FR-MEM-01 to FR-MEM-05; UX-37, UX-40). Members are a long list: the first 50 show, and
 * "Show more" is a plain link to the same page with a larger `shown` (no prefetching link). Only roles that hold
 * `member:invite` are given the pending invitations, whose addresses other members must not see (obligation M10).
 */
export default async function MembersSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ shown?: string }>;
}) {
  const { slug } = await params;
  const shown = (await searchParams).shown ?? null;
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'member:read');

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
