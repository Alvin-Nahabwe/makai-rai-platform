import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { lookupUserNames } from '@/lib/data/identity';
import MembersManager from './MembersManager';

/**
 * The member-management UI D-118 named as Task 8's deliverable: the
 * `members`/`members/[userId]`/`members/leave` API surface has been live
 * since Task 7/8, but nothing rendered or called it. Team-wide, not
 * "members I invited" — every active membership in the org, matching the
 * GET route's own `where: { status: 'active' }` (no further filter; RLS via
 * `withOrg` is the only scoping).
 *
 * No `user` relation `include` here either, for the identical reason
 * `GET .../members` documents: `makrai_app` has no grant on `users`, so
 * names are fetched separately via `lookupUserNames` (name only, never
 * email — that helper's own module doc explains why) and merged
 * client-side of this function (still server-side overall, just after the
 * two queries).
 */
export default async function MembersSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'member:read');

  const members = await withOrg(ctx, (tx) =>
    tx.membership.findMany({
      where: { status: 'active' },
      orderBy: { createdAt: 'asc' },
    }),
  );
  const names = await lookupUserNames(members.map((m) => m.userId));
  const rows = members.map((m) => ({
    userId: m.userId,
    role: m.role,
    name: names.get(m.userId)?.name ?? 'Unknown',
  }));

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Members</h1>
          <p className="text-muted">Manage who belongs to this organization and at what role.</p>
        </div>
      </div>
      <MembersManager
        slug={slug}
        currentUserId={identity.userId}
        currentRole={ctx.role}
        initialMembers={rows}
      />
    </div>
  );
}
