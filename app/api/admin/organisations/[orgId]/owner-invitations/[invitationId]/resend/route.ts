import { NextRequest, NextResponse } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { AppError } from '@/lib/http/errors';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { readJsonBody } from '@/lib/http/jsonBody';
import { logSecurityEvent } from '@/lib/security-logger';
import { randomBytes } from 'node:crypto';
import { adminResendInvitation } from '@/lib/data/definer';
import { hashInvitationToken } from '@/lib/data/invitationToken';
import { INVITATION_TTL_MS, deliverInvitation, parseResendRequest } from '@/lib/data/members';
import { firstOwnerInvitationOf, newOwnerInvitationView } from '@/lib/data/admin';
import { invitationAcceptUrl } from '@/lib/publicOrigin';

/**
 * Contract route row 45, S-24 (FR-ORG-02): resend a pending first-owner invitation. The definer revokes the old row
 * (its link stops working) and inserts a new one with a new token and seven more days, with its
 * `owner_invitation_resent` row; a revoked, accepted or expired one answers 409 `invitation_not_pending`. The path
 * invitation must be a first-owner invitation of the path organisation, else 404. The body is MEM's
 * ResendInvitationRequest (`requestId`, `showLink`); the request id is logged with the action. E-01 as route 41.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ orgId: string; invitationId: string }> }) {
  try {
    assertSameOrigin(req);
    const identity = await requireIdentityForApi();
    if (identity.platformRole !== 'admin') throw new AppError(403, 'not_platform_admin');
    const { orgId, invitationId } = await params;
    const body = parseResendRequest(await readJsonBody(req));
    const { email, orgName } = await firstOwnerInvitationOf(orgId, invitationId);
    const rawToken = randomBytes(32).toString('hex');
    invitationAcceptUrl(rawToken);   // throws now, before the old link is revoked, when the public origin is not configured
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
    const resent = await adminResendInvitation({
      actorUserId: identity.userId, invitationId, tokenHash: hashInvitationToken(rawToken), expiresAt, linkShown: body.showLink,
    });
    logSecurityEvent('ADMIN_ACTION', 'warn', {
      userId: identity.userId, details: { action: 'owner_invitation_resent', orgId, invitationId: resent.invitationId, previousInvitationId: invitationId, requestId: body.requestId },
    });
    const invitation = newOwnerInvitationView({ id: resent.invitationId, email, createdAt: now, expiresAt, linkShown: body.showLink });
    const sent = await deliverInvitation({ issued: { invitation, orgName, rawToken }, showLink: body.showLink, orgId, actorUserId: identity.userId });
    return NextResponse.json(sent, { status: 201 });
  } catch (e) {
    return toResponse(e);
  }
}
