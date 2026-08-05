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
import { sendEmail } from '@/lib/email/send';
import { invitationEmail } from '@/lib/email/templates';

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
 * (Task 8 brief property 3) and the token generation (property 1). The
 * one-time accept link is returned to the caller, who already proved
 * `member:invite` in this org, exactly as `bootstrapOrgWithOwner`'s caller
 * is trusted with the row it creates.
 *
 * Task 9: this handler ALSO sends the accept link by email
 * (`lib/email/send.ts` + `lib/email/templates.ts`). The two delivery paths
 * are not alternatives — Resend's shared testing sender only reaches the
 * account holder's own inbox, so most real invitees in a multi-user fixture
 * can only be reached by the copy-link (D-030). The invitation row is
 * created and the response always carries `acceptUrl` regardless of
 * whether the email leg succeeds: `sendEmail` throws on failure
 * (constraint 2), and that throw is caught HERE, not left to propagate
 * into the shared `catch (e) { return toResponse(e); }` below — a plain
 * `Error` isn't one of `toResponse`'s known types, so letting it propagate
 * would 500 the whole request AFTER the invitation and token already exist,
 * destroying the very `acceptUrl` the copy-link path depends on. Instead
 * the response still 201s with `acceptUrl`, and `emailSent`/`emailError`
 * tell the inviter — not just the server log — whether the email actually
 * went out. That is the AGENTS.md §2 silent-failure trigger's fix applied
 * one layer up: the *transport* fails loud (throws); the *route* must still
 * not let that throw manufacture a NEW silent failure by either swallowing
 * it (a 201 with no signal) or letting it destroy the copy-link response
 * (a 500 with no acceptUrl). Found by `pr-review-toolkit:silent-failure-hunter`,
 * dispatched on this exact question before this handler was written.
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

    let emailSent = false;
    let deliveryError: string | undefined;
    try {
      const from = process.env.EMAIL_FROM_ADDRESS;
      if (typeof from !== 'string' || from.length === 0) {
        throw new Error('EMAIL_FROM_ADDRESS is not set.');
      }
      const content = invitationEmail({ orgName: invitation.orgName, role: invitation.role, acceptUrl });
      const sent = await sendEmail({ to: invitation.email, from, ...content });
      emailSent = true;
      // `resendMessageId` only — never `acceptUrl`/`rawToken` (constraint 4).
      logSecurityEvent('ORG_MEMBER_ACTION', 'info', {
        userId: identity.userId,
        details: { action: 'invite_email_sent', orgId: ctx.orgId, invitedEmail: email, resendMessageId: sent.id },
      });
    } catch (e) {
      // Never a `throw` here: a failed EMAIL LEG must not cost the inviter
      // the `acceptUrl` that already exists (see the handler doc comment).
      // `e.message` only — `sendEmail` guarantees it carries Resend's
      // `name`/`message`, never the API key or the raw token.
      deliveryError = e instanceof Error ? e.message : 'Unknown email error';
      logSecurityEvent('ORG_MEMBER_ACTION', 'error', {
        userId: identity.userId,
        details: { action: 'invite_email_failed', orgId: ctx.orgId, invitedEmail: email, error: deliveryError },
      });
    }

    return NextResponse.json(
      {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        token: invitation.rawToken,
        acceptUrl,
        expiresAt: invitation.expiresAt,
        emailSent,
        ...(emailSent ? {} : { emailError: deliveryError }),
      },
      { status: 201 },
    );
  } catch (e) {
    return toResponse(e);
  }
}
