import { NextRequest, NextResponse } from 'next/server';
import type { OrgRole } from '@prisma/client';
import { requireOrgContext, requireOrgContextWithIdentity } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { createInvitation } from '@/lib/data/members';
import { ALL_ORG_ROLES } from '@/lib/authz/roles';
import { lookupUserNames } from '@/lib/data/identity';
import { toResponse } from '@/lib/http/toResponse';
import { validateEmail } from '@/lib/validate';
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
 * Creates a pending `Invitation` row via `createInvitation`
 * (lib/data/members.ts), which owns the role-cap-at-creation invariant
 * (Task 8 brief property 3) and the token generation (property 1). Sending
 * the email itself is out of this task's scope (Task 9); the one-time
 * accept link is returned to the caller, who already proved `member:invite`
 * in this org, exactly as `bootstrapOrgWithOwner`'s caller is trusted with
 * the row it creates.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'member:invite');

    const body = await req.json();
    const emailError = validateEmail(body.email);
    if (emailError) return NextResponse.json({ error: emailError.message }, { status: 400 });
    const email = (body.email as string).trim().toLowerCase();

    const role = body.role as unknown;
    if (typeof role !== 'string' || !ALL_ORG_ROLES.includes(role as OrgRole)) {
      return NextResponse.json({ error: 'role must be one of: ' + ALL_ORG_ROLES.join(', ') }, { status: 400 });
    }

    // Throws ForbiddenError (-> 403 via toResponse below) if `ctx.role` may
    // not mint an `owner` invitation — property 3, enforced inside
    // `createInvitation` itself so this is proven once, not re-derived at
    // every caller.
    const invitation = await createInvitation({
      ctx, email, role: role as OrgRole, invitedById: identity.userId,
    });

    logSecurityEvent('ORG_MEMBER_ACTION', 'warn', {
      userId: identity.userId,
      details: { action: 'invite', orgId: ctx.orgId, invitedEmail: email, role },
    });

    const acceptUrl = new URL(`/invitations/${invitation.rawToken}`, req.nextUrl.origin).toString();
    return NextResponse.json(
      {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        token: invitation.rawToken,
        acceptUrl,
        expiresAt: invitation.expiresAt,
      },
      { status: 201 },
    );
  } catch (e) {
    return toResponse(e);
  }
}
