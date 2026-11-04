import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { requestDigest } from '@/lib/data/idempotency';
import { parseRequestIdBody, revokeInvitation } from '@/lib/data/members';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * Contract route row 29: revoke a pending member invitation (FR-MEM-02). 204 the first time and on a replay.
 * A second revoke with another request id answers 409 `invitation_not_pending`; a first-owner invitation,
 * another organisation's and a missing one answer 404.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; invitationId: string }> }) {
  const { slug, invitationId } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'member:invite');
    const body = parseRequestIdBody(await readJsonBody(req));
    const digest = requestDigest({ path: { invitationId }, body });
    const out = await revokeInvitation(ctx, { userId: identity.userId, role: ctx.role }, { ...body, invitationId }, digest);
    if (!out.replayed) {
      logSecurityEvent('ORG_MEMBER_ACTION', 'warn', { userId: identity.userId, details: { action: 'revoke', orgId: ctx.orgId, invitationId } });
    }
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return toResponse(e);
  }
}
