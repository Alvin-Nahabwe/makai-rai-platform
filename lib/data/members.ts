import { randomBytes } from 'node:crypto';
import type { OrgRole } from '@prisma/client';
import { withOrg, assertCan, type OrgContext } from './tenant';
import { hashInvitationToken } from './invitationToken';

export type RemoveMemberResult = 'not_found' | 'last_owner' | 'removed';

/** A value, not "expiring" (Task 8 brief constraint 1) — an unspecified
 * duration is one an implementer invents and nobody revisits. */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type CreateInvitationResult = {
  id: string; email: string; role: OrgRole; rawToken: string; expiresAt: Date; orgName: string;
};

/**
 * Creates a pending `Invitation` row, tenant-scoped through `withOrg` (the
 * caller already has an `OrgContext`, proven by `requireOrgContext(slug,
 * 'member:invite')` at the route) — unlike its sibling `acceptInvitation`
 * (lib/data/preauth.ts), which runs before any org context exists for the
 * ACCEPTING user and therefore cannot go through `withOrg` at all. Extracted
 * from the inline logic `app/api/v1/orgs/[slug]/members/route.ts`'s POST
 * handler carried before Task 8, so the role-cap invariant below is proven
 * once here rather than re-derived at every caller.
 *
 * PROPERTY 3 (Task 8 brief): the inviter's role caps the invitable role,
 * enforced AT CREATION. `member:invite` is granted to both `owner` and
 * `admin` (lib/authz/policy.ts), so proving the caller may invite SOMEONE
 * does not prove they may invite an OWNER specifically — only `owner` holds
 * `member:grant_owner`. Composed with, not a substitute for, the route's own
 * `member:invite` gate — mirrors how `removeMember` composes `member:remove`
 * with the owner-specific `member:revoke_owner` check.
 *
 * PROPERTY 1: the raw token is `randomBytes(32)` (256 bits, well over the
 * 128-bit floor) hex-encoded; only its sha256 digest is ever persisted
 * (`invitations.tokenHash`, backed by the `invitations_tokenHash_is_sha256_hex`
 * CHECK). `rawToken` is returned to the caller EXACTLY ONCE, here, and this
 * function holds no other reference to it afterward.
 */
export async function createInvitation(input: {
  ctx: OrgContext; email: string; role: OrgRole; invitedById: string;
}): Promise<CreateInvitationResult> {
  if (input.role === 'owner') {
    assertCan(input.ctx, 'member:grant_owner');
  }

  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = hashInvitationToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  // Task 9: the invitation email needs the org's display name, not just its
  // id/slug. Read inside the SAME `withOrg` transaction — `organizations`
  // carries the identical `org_isolation` RLS policy as every other tenant
  // table (`prisma/migrations/20260803074244_.../migration.sql`), scoped to
  // `current_org_id`, so this is one more tenant-scoped read on a
  // connection already proven to be that org's, not a second bypass.
  const { invitation, org } = await withOrg(input.ctx, async (tx) => {
    const invitation = await tx.invitation.create({
      data: {
        orgId: input.ctx.orgId,
        email: input.email,
        role: input.role,
        tokenHash,
        invitedById: input.invitedById,
        expiresAt,
      },
    });
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: input.ctx.orgId },
      select: { name: true },
    });
    return { invitation, org };
  });

  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    rawToken,
    expiresAt,
    orgName: org.name,
  };
}

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
