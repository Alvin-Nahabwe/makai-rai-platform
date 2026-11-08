import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { requestDigest } from '@/lib/data/idempotency';
import { leaveOrganisation, parseRequestIdBody } from '@/lib/data/members';
import { readJsonBody } from '@/lib/http/jsonBody';
import { toResponse } from '@/lib/http/toResponse';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * Contract route row 27: a member leaves the organisation (FR-MEM-05). Every role holds `member:leave`. 204 the
 * first time; the last active owner is refused with 409 `last_active_owner`. Once the member has left, the gate
 * answers their replay with 404 before any receipt is read, which repeats no effect.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'member:leave');
    const body = parseRequestIdBody(await readJsonBody(req));
    const digest = requestDigest({ path: {}, body });
    const out = await leaveOrganisation(ctx, { userId: identity.userId, role: ctx.role }, body, digest);
    if (!out.replayed) {
      logSecurityEvent('ORG_MEMBER_ACTION', 'warn', { userId: identity.userId, details: { action: 'leave', orgId: ctx.orgId } });
    }
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return toResponse(e);
  }
}
