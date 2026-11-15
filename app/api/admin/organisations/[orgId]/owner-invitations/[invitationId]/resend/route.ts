import { NextRequest, NextResponse } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { AppError } from '@/lib/http/errors';
import { ADMIN_ROUTE_COPY } from '@/lib/http/api/copy';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { readJsonBody } from '@/lib/http/jsonBody';
import { logSecurityEvent } from '@/lib/security-logger';
import { randomBytes } from 'node:crypto';
import { adminResendInvitation } from '@/lib/data/definer';
import { hashInvitationToken } from '@/lib/data/invitationToken';
import { INVITATION_TTL_MS, deliverInvitation, parseResendRequest } from '@/lib/data/members';
import { firstOwnerInvitationOf, newOwnerInvitationView, organisationArchivedForAdmin, ownerInvitationViewOf } from '@/lib/data/admin';
import { requestDigest } from '@/lib/data/idempotency';
import type { InviteMemberResponse } from '@/types/api';
import { invitationAcceptUrl } from '@/lib/publicOrigin';

/**
 * Contract route row 45, S-24 (FR-ORG-02): resend a pending first-owner invitation. The definer revokes the old row
 * (its link stops working) and inserts a new one with a new token and seven more days, with its
 * `owner_invitation_resent` row; a revoked, accepted or expired one answers 409 `invitation_not_pending`. The path
 * invitation must be a first-owner invitation of the path organisation, else 404. The body is MEM's
 * ResendInvitationRequest (`requestId`, `showLink`); the definer keeps a receipt of the request id (NFR-INT-02), so a
 * repeat answers 200 with the first call's invitation, no link and `emailSent: false`, and the same id with another
 * body 409 `request_id_reused`. E-01 as route 41, only on the first call.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ orgId: string; invitationId: string }> }) {
  try {
    assertSameOrigin(req);
    const identity = await requireIdentityForApi();
    if (identity.platformRole !== 'admin') throw new AppError(403, 'not_platform_admin', ADMIN_ROUTE_COPY.notPlatformAdmin);
    const { orgId, invitationId } = await params;
    const body = parseResendRequest(await readJsonBody(req));
    const { email, orgName } = await firstOwnerInvitationOf(orgId, invitationId);
    // As route 44: no first owner is invited into an archived organisation (C4 ORG-SF-5).
    if (await organisationArchivedForAdmin(orgId)) throw new AppError(409, 'organisation_archived', ADMIN_ROUTE_COPY.organisationArchived);
    const rawToken = randomBytes(32).toString('hex');
    invitationAcceptUrl(rawToken);   // throws now, before the old link is revoked, when the public origin is not configured
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
    const digest = requestDigest({ path: { orgId, invitationId }, body });
    const resent = await adminResendInvitation({
      actorUserId: identity.userId, invitationId, tokenHash: hashInvitationToken(rawToken), expiresAt, linkShown: body.showLink,
      requestId: body.requestId, digest,
    });
    if (resent.replayed) {
      // As MEM's resend (route 28): the first answer's invitation, with no link (the token is never kept) and no email.
      const invitation = await ownerInvitationViewOf(orgId, resent.invitationId);
      return NextResponse.json({ invitation, acceptUrl: null, emailSent: false } satisfies InviteMemberResponse, { status: 200 });
    }
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
