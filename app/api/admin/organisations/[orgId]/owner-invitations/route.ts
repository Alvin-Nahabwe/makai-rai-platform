import { NextRequest, NextResponse } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { AppError } from '@/lib/http/errors';
import { ADMIN_ROUTE_COPY } from '@/lib/http/api/copy';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { readJsonBody } from '@/lib/http/jsonBody';
import { logSecurityEvent } from '@/lib/security-logger';
import { randomBytes } from 'node:crypto';
import { adminIssueOwnerInvitation } from '@/lib/data/definer';
import { hashInvitationToken } from '@/lib/data/invitationToken';
import { INVITATION_TTL_MS, deliverInvitation } from '@/lib/data/members';
import { newOwnerInvitationView, organisationArchivedForAdmin, organisationNameForAdmin, parseIssueOwnerInvitation } from '@/lib/data/admin';
import { invitationAcceptUrl } from '@/lib/publicOrigin';

/**
 * Contract route row 44, S-24 (FR-ORG-02): a new first-owner invitation for an organisation with no active owner
 * and no pending first-owner invitation, with the reference of the controller's written request. The definer
 * refuses with 409 `active_owner_exists` or `pending_owner_invitation_exists`, and writes `owner_invitation_issued`
 * with the reference. E-01 and the link as route 41.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    assertSameOrigin(req);
    const identity = await requireIdentityForApi();
    if (identity.platformRole !== 'admin') throw new AppError(403, 'not_platform_admin', ADMIN_ROUTE_COPY.notPlatformAdmin);
    const { orgId } = await params;
    const body = parseIssueOwnerInvitation(await readJsonBody(req));
    // An archived organisation gives its invitee S-31 on every page: no first owner is invited into it (C4 ORG-SF-5).
    if (await organisationArchivedForAdmin(orgId)) throw new AppError(409, 'organisation_archived', ADMIN_ROUTE_COPY.organisationArchived);
    const orgName = await organisationNameForAdmin(orgId);
    const rawToken = randomBytes(32).toString('hex');
    invitationAcceptUrl(rawToken);   // throws now, before any write, when the public origin is not configured
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
    const { invitationId } = await adminIssueOwnerInvitation({
      actorUserId: identity.userId, orgId, email: body.email, tokenHash: hashInvitationToken(rawToken),
      expiresAt, requestReference: body.requestReference, linkShown: body.showLink,
    });
    logSecurityEvent('ADMIN_ACTION', 'warn', { userId: identity.userId, details: { action: 'owner_invitation_issued', orgId, invitationId } });
    const invitation = newOwnerInvitationView({ id: invitationId, email: body.email, createdAt: now, expiresAt, linkShown: body.showLink });
    const sent = await deliverInvitation({ issued: { invitation, orgName, rawToken }, showLink: body.showLink, orgId, actorUserId: identity.userId });
    return NextResponse.json(sent, { status: 201 });
  } catch (e) {
    return toResponse(e);
  }
}
