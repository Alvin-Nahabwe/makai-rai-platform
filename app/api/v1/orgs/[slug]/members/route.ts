import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContext, requireOrgContextWithIdentity } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { deliverInvitation, inviteMember, parseInviteRequest } from '@/lib/data/members';
import { requestDigest } from '@/lib/data/idempotency';
import { readJsonBody } from '@/lib/http/jsonBody';
import type { InviteMemberResponse } from '@/types/api';
import { lookupUserNames } from '@/lib/data/identity';
import { toResponse } from '@/lib/http/toResponse';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { logSecurityEvent } from '@/lib/security-logger';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const ctx = await requireOrgContext(slug, 'member:read');
    // No `user` relation `include` — `makrai_app` has no grant on `users`
    // (lib/data/identity.ts#lookupUserNames). `userId` is read as a scalar
    // column and names attached afterwards.
    const members = await withOrg(ctx, (tx) =>
      tx.membership.findMany({
        where: { status: 'active' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    // Name only — `lookupUserNames` deliberately does not return email
    // (fix round 1, Important finding 2). If a members-management UI later
    // needs email (Task 8, D-118), it asks for it explicitly rather than
    // this endpoint quietly regaining a field it never had a proven need
    // for.
    const names = await lookupUserNames(members.map((m) => m.userId));
    const withNames = members.map((m) => ({
      ...m,
      user: { id: m.userId, name: names.get(m.userId)?.name ?? 'Unknown' },
    }));
    return NextResponse.json(withNames);
  } catch (e) {
    return toResponse(e);
  }
}

/**
 * Contract route row 25: invite a member (FR-MEM-01). Same-origin check, the gate (`member:invite`), the body's
 * shape (422 on each field at fault, `requestId` included), the digest of the path ids and the parsed body, then
 * `inviteMember`: one receipt-mode transaction (lock, counts, insert, event row; owner answer A1). E-01 is sent
 * here, after that transaction has committed and only when it was not a replay (`deliverInvitation`), so a failed
 * send still answers 201 with `emailSent: false` and a retry sends nothing twice. `acceptUrl` comes back only with
 * `showLink`. A replay answers 200 with the invitation rebuilt from its receipt, no link and `emailSent: false`.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'member:invite');
    const body = parseInviteRequest(await readJsonBody(req));
    const digest = requestDigest({ path: {}, body });
    const out = await inviteMember(ctx, { userId: identity.userId, role: ctx.role }, body, digest);
    if (out.replayed) {
      return NextResponse.json({ invitation: out.value.invitation, acceptUrl: null, emailSent: false } satisfies InviteMemberResponse, { status: 200 });
    }
    logSecurityEvent('ORG_MEMBER_ACTION', 'warn', {
      userId: identity.userId,
      details: { action: 'invite', orgId: ctx.orgId, invitationId: out.value.invitation.id, role: body.role },
    });
    const response = await deliverInvitation({ issued: out.value, showLink: body.showLink, orgId: ctx.orgId, actorUserId: identity.userId });
    return NextResponse.json(response, { status: 201 });
  } catch (e) {
    return toResponse(e);
  }
}
