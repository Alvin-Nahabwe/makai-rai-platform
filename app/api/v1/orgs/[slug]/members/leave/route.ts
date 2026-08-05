import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { removeMember } from '@/lib/data/members';
import { toResponse } from '@/lib/http/toResponse';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * Self-service departure from the current org — every `OrgRole` grants
 * `member:leave` (lib/authz/policy.ts), unlike `member:remove` (owner/admin
 * only), which is why this is a distinct route rather than the caller
 * pointing `DELETE .../members/[userId]` at their own id.
 *
 * Delegates to `removeMember(ctx, identity.userId)` — the SAME function
 * `DELETE .../members/[userId]` uses — rather than re-deriving the
 * last-owner guard. `removeMember` only asserts `member:revoke_owner` when
 * the TARGET is an owner; `owner` grants that action to itself
 * (lib/authz/policy.ts), so an owner leaving passes that check and still
 * gets refused by the last-owner count if they are the sole owner. A
 * non-owner leaving never reaches that branch at all. Static route segment
 * `leave` coexists with the sibling dynamic `[userId]/route.ts` — Next.js
 * resolves the literal segment first (see the App Router routing docs);
 * `leave` is not a valid membership id shape (no such user), so there is no
 * real ambiguity even before that resolution order applies.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'member:leave');

    const result = await removeMember(ctx, identity.userId);

    if (result === 'not_found') {
      // Structurally unreachable: `requireOrgContextWithIdentity` above
      // already proved an active membership for this exact user in this
      // exact org. Kept as a real branch (not asserted away) because
      // `removeMember` is shared code whose contract this route must honour
      // regardless of what today's callers happen to guarantee.
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (result === 'last_owner') {
      return NextResponse.json(
        { error: 'You are the last owner of this organization. Transfer ownership before leaving.' },
        { status: 409 },
      );
    }

    logSecurityEvent('ORG_MEMBER_ACTION', 'warn', {
      userId: identity.userId,
      details: { action: 'leave', orgId: ctx.orgId },
    });
    return NextResponse.json({ success: true });
  } catch (e) {
    return toResponse(e);
  }
}
