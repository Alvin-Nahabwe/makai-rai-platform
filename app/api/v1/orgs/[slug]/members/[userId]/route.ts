import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { toResponse } from '@/lib/http/toResponse';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * Grants `owner` to an existing member. `requireOrgContext(slug,
 * 'member:grant_owner')` already restricts callers to the `owner` role
 * (lib/authz/policy.ts: only `owner` grants `member:grant_owner`), so this
 * handler does no further role check of its own — the gate IS the
 * authorization decision (ADR-0001). Privilege-affecting, so it is
 * audit-logged — `silent-failure-hunter` flagged its absence here and on
 * DELETE/POST below as the one gap in an otherwise-correct file.
 */
export async function PATCH(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; userId: string }> },
) {
  const { slug, userId } = await params;
  try {
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'member:grant_owner');

    const membership = await withOrg(ctx, (tx) =>
      tx.membership.updateMany({
        where: { userId, status: 'active' },
        data: { role: 'owner' },
      }),
    );
    if (membership.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    logSecurityEvent('ORG_MEMBER_ACTION', 'warn', {
      userId: identity.userId,
      details: { action: 'grant_owner', orgId: ctx.orgId, targetUserId: userId },
    });
    return NextResponse.json({ success: true });
  } catch (e) {
    return toResponse(e);
  }
}

/**
 * Removes a member from the organization. Refuses to remove the org's last
 * owner — the same invariant `DELETE /api/users/me` enforces for
 * self-removal, applied here to admin-initiated removal so the two paths
 * cannot together leave an organization with zero owners.
 *
 * `SELECT ... FOR UPDATE` locks every active-owner row in this org for the
 * duration of the transaction before counting: without it, two concurrent
 * removals of two DIFFERENT owners could each read a count of 2 under
 * Postgres's default READ COMMITTED isolation and both proceed, leaving
 * zero — a single `withOrg` transaction alone does not prevent that (see
 * the fuller explanation on `DELETE /api/users/me`, which had the same
 * class of gap without a lock at all).
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; userId: string }> },
) {
  const { slug, userId } = await params;
  try {
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'member:remove');

    const result = await withOrg(ctx, async (tx) => {
      const target = await tx.membership.findFirst({
        where: { userId, status: 'active' },
        select: { role: true },
      });
      if (!target) return { kind: 'not_found' as const };

      if (target.role === 'owner') {
        await tx.$queryRaw`SELECT id FROM memberships WHERE role = 'owner' AND status = 'active' FOR UPDATE`;
        const ownerCount = await tx.membership.count({ where: { role: 'owner', status: 'active' } });
        if (ownerCount <= 1) return { kind: 'last_owner' as const };
      }

      await tx.membership.deleteMany({ where: { userId, status: 'active' } });
      return { kind: 'removed' as const };
    });

    if (result.kind === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (result.kind === 'last_owner') {
      return NextResponse.json(
        { error: 'Cannot remove the last owner of an organization' },
        { status: 409 },
      );
    }

    logSecurityEvent('ORG_MEMBER_ACTION', 'warn', {
      userId: identity.userId,
      details: { action: 'remove', orgId: ctx.orgId, targetUserId: userId },
    });
    return NextResponse.json({ success: true });
  } catch (e) {
    return toResponse(e);
  }
}
