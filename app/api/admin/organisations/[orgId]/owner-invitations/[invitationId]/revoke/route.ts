import { NextRequest, NextResponse } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { AppError } from '@/lib/http/errors';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { logSecurityEvent } from '@/lib/security-logger';
import { adminRevokeInvitation } from '@/lib/data/definer';
import { firstOwnerInvitationOf } from '@/lib/data/admin';

/**
 * Contract route row 46, S-24 (FR-ORG-02): revoke a pending first-owner invitation through
 * `admin_revoke_invitation` and its `owner_invitation_revoked` row; 204, no body read. A revoked, accepted or
 * expired one answers 409 `invitation_not_pending`; an invitation that is not a first-owner invitation of the path
 * organisation answers 404.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ orgId: string; invitationId: string }> }) {
  try {
    assertSameOrigin(req);
    const identity = await requireIdentityForApi();
    if (identity.platformRole !== 'admin') throw new AppError(403, 'not_platform_admin');
    const { orgId, invitationId } = await params;
    await firstOwnerInvitationOf(orgId, invitationId);
    await adminRevokeInvitation({ actorUserId: identity.userId, invitationId });
    logSecurityEvent('ADMIN_ACTION', 'warn', { userId: identity.userId, details: { action: 'owner_invitation_revoked', orgId, invitationId } });
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return toResponse(e);
  }
}
