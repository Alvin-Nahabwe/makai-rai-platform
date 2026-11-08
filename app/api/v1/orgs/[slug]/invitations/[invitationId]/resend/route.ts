import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { requestDigest } from '@/lib/data/idempotency';
import { deliverInvitation, parseResendRequest, resendInvitation } from '@/lib/data/members';
import type { InviteMemberResponse } from '@/types/api';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * Contract route row 28: resend a pending member invitation (FR-MEM-02). The old row becomes `revoked` and a new
 * one is created in one receipt-mode transaction; E-01 is sent here after the commit, only when it was not a
 * replay. 201 with the new invitation (the link only with `showLink`); 200 on a replay, with no link and
 * `emailSent: false`. A first-owner invitation, another organisation's and a missing one answer 404.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; invitationId: string }> }) {
  const { slug, invitationId } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'member:invite');
    const body = parseResendRequest(await readJsonBody(req));
    const digest = requestDigest({ path: { invitationId }, body });
    const out = await resendInvitation(ctx, { userId: identity.userId, role: ctx.role }, { ...body, invitationId }, digest);
    if (out.replayed) {
      return NextResponse.json({ invitation: out.value.invitation, acceptUrl: null, emailSent: false } satisfies InviteMemberResponse, { status: 200 });
    }
    logSecurityEvent('ORG_MEMBER_ACTION', 'warn', {
      userId: identity.userId, details: { action: 'resend', orgId: ctx.orgId, invitationId, newInvitationId: out.value.invitation.id },
    });
    return NextResponse.json(await deliverInvitation({ issued: out.value, showLink: body.showLink, orgId: ctx.orgId, actorUserId: identity.userId }), { status: 201 });
  } catch (e) {
    return toResponse(e);
  }
}
