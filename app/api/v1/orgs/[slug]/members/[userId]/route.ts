import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { requestDigest } from '@/lib/data/idempotency';
import { changeMemberRole, parseChangeRoleRequest, parseRequestIdBody, removeMember } from '@/lib/data/members';
import { readJsonBody } from '@/lib/http/jsonBody';
import { toResponse } from '@/lib/http/toResponse';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * Contract route row 26 PATCH: change a member's role (FR-MEM-03). Gate `member:role` (owners and administrators);
 * granting owner needs `member:grant_owner` and changing an owner `member:revoke_owner`, both owner-only, checked
 * in the service. 204 the first time and on a replay. A missing member, or one of another organisation, is the
 * coded 404; demoting the last active owner is 409 `last_active_owner`.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ slug: string; userId: string }> }) {
  const { slug, userId } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'member:role');
    const body = parseChangeRoleRequest(await readJsonBody(req));
    const digest = requestDigest({ path: { userId }, body });
    const out = await changeMemberRole(ctx, { userId: identity.userId, role: ctx.role }, { ...body, userId }, digest);
    if (!out.replayed) {
      logSecurityEvent('ORG_MEMBER_ACTION', 'warn', { userId: identity.userId, details: { action: 'role_change', orgId: ctx.orgId, targetUserId: userId, role: body.role } });
    }
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return toResponse(e);
  }
}

/**
 * Contract route row 26 DELETE: remove a member (FR-MEM-04). Removing an owner needs `member:revoke_owner`
 * (owner-only), so an administrator cannot lock an owner out. 204 the first time and on a replay; removing the
 * last active owner is 409 `last_active_owner`. A caller who removes themself is no longer a member on a replay,
 * which the gate answers with 404 before any receipt is read.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ slug: string; userId: string }> }) {
  const { slug, userId } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'member:remove');
    const body = parseRequestIdBody(await readJsonBody(req));
    const digest = requestDigest({ path: { userId }, body });
    const out = await removeMember(ctx, { userId: identity.userId, role: ctx.role }, { ...body, userId }, digest);
    if (!out.replayed) {
      logSecurityEvent('ORG_MEMBER_ACTION', 'warn', { userId: identity.userId, details: { action: 'remove', orgId: ctx.orgId, targetUserId: userId } });
    }
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return toResponse(e);
  }
}
