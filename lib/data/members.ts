import { withOrg, assertCan, type OrgContext } from './tenant';

export type RemoveMemberResult = 'not_found' | 'last_owner' | 'removed';

/**
 * The core logic behind `DELETE /api/v1/orgs/[slug]/members/[userId]`,
 * extracted to a plain function so it is testable without a NextAuth
 * session/cookie in the loop — mirrors how `lib/data/tenant.ts`'s own
 * primitives are tested directly against a hand-built `OrgContext`
 * (`__tests__/integration/tenant-layer.test.ts`).
 *
 * `member:remove` is granted to BOTH `owner` and `admin`
 * (lib/authz/policy.ts) — `requireOrgContext(slug, 'member:remove')` at the
 * route only proves the caller may remove *some* member, not that they may
 * remove an OWNER specifically. Fix round 1, Important finding 1: an org
 * `admin` could call this on an `owner` and succeed (the only guard was the
 * last-owner count, which an admin removing ONE of two owners sails past),
 * locking that owner out with no way back — `member:grant_owner` is
 * owner-only, so no admin can undo it. `member:revoke_owner` is the
 * distinct, owner-only action for exactly this (lib/authz/policy.ts), and
 * it is asserted here, INSIDE the branch that already knows the target is
 * an owner — before the last-owner count, so an owner is still refused from
 * removing the LAST owner (the two checks compose; neither replaces the
 * other).
 */
export async function removeMember(
  ctx: OrgContext,
  targetUserId: string,
): Promise<RemoveMemberResult> {
  return withOrg(ctx, async (tx) => {
    const target = await tx.membership.findFirst({
      where: { userId: targetUserId, status: 'active' },
      select: { role: true },
    });
    if (!target) return 'not_found';

    if (target.role === 'owner') {
      // Only an owner may remove an owner. Thrown, not returned — an
      // authorization failure is a `ForbiddenError` up through `withOrg`
      // and `toResponse` (403), the same shape every other `assertCan`
      // failure takes; it is not a domain outcome like `not_found`/
      // `last_owner` for the route to translate into its own JSON shape.
      assertCan(ctx, 'member:revoke_owner');

      // Locks every active-owner row in this org for the duration of the
      // transaction before counting: without it, two concurrent removals
      // of two DIFFERENT owners could each read a count of 2 under
      // Postgres's default READ COMMITTED isolation and both proceed,
      // leaving zero.
      await tx.$queryRaw`SELECT id FROM memberships WHERE role = 'owner' AND status = 'active' FOR UPDATE`;
      const ownerCount = await tx.membership.count({ where: { role: 'owner', status: 'active' } });
      if (ownerCount <= 1) return 'last_owner';
    }

    await tx.membership.deleteMany({ where: { userId: targetUserId, status: 'active' } });
    return 'removed';
  });
}
