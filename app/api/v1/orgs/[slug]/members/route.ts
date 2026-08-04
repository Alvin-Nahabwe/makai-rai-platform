import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import type { OrgRole } from '@prisma/client';
import { requireOrgContext, requireOrgContextWithIdentity } from '@/lib/auth/context';
import { withOrg, assertCan } from '@/lib/data/tenant';
import { lookupUserNames } from '@/lib/data/identity';
import { toResponse } from '@/lib/http/toResponse';
import { validateEmail } from '@/lib/validate';
import { logSecurityEvent } from '@/lib/security-logger';

const INVITABLE_ROLES: readonly OrgRole[] = ['owner', 'admin', 'assessor', 'reviewer', 'viewer'];
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
 * Creates a pending `Invitation` row. Sending the email itself is out of
 * this task's scope (no acceptance flow exists yet — that is Task 8's
 * `acceptInvitation`, per lib/data/preauth.ts's module doc); the plaintext
 * token is returned to the caller, who already proved `member:invite` in
 * this org, exactly as `bootstrapOrgWithOwner`'s caller is trusted with the
 * row it creates. Only `tokenHash` (sha256 hex) is ever persisted —
 * mirrors `lib/data/preauth.ts#invitationByToken` and the
 * `invitations_tokenHash_is_sha256_hex` CHECK constraint (D-097).
 *
 * Inviting someone as `owner` requires `member:grant_owner`, not merely
 * `member:invite` — otherwise an `admin` (who has `member:invite` but not
 * `member:grant_owner`) could mint a peer owner through the invite path,
 * a privilege-escalation route the PATCH-based grant endpoint closes.
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
    if (typeof role !== 'string' || !INVITABLE_ROLES.includes(role as OrgRole)) {
      return NextResponse.json({ error: 'role must be one of: ' + INVITABLE_ROLES.join(', ') }, { status: 400 });
    }
    if (role === 'owner') {
      assertCan(ctx, 'member:grant_owner');
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const invitation = await withOrg(ctx, (tx) =>
      tx.invitation.create({
        data: {
          orgId: ctx.orgId,
          email,
          role: role as OrgRole,
          tokenHash,
          invitedById: identity.userId,
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        },
      }),
    );

    logSecurityEvent('ORG_MEMBER_ACTION', 'warn', {
      userId: identity.userId,
      details: { action: 'invite', orgId: ctx.orgId, invitedEmail: email, role },
    });

    return NextResponse.json(
      { id: invitation.id, email: invitation.email, role: invitation.role, token },
      { status: 201 },
    );
  } catch (e) {
    return toResponse(e);
  }
}
