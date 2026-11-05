import { NextRequest, NextResponse } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { AppError } from '@/lib/http/errors';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { readJsonBody } from '@/lib/http/jsonBody';
import { logSecurityEvent } from '@/lib/security-logger';
import { randomBytes } from 'node:crypto';
import { adminCreateOrganisation } from '@/lib/data/definer';
import { deriveSlug } from '@/lib/data/preauth';
import { hashInvitationToken } from '@/lib/data/invitationToken';
import { INVITATION_TTL_MS, deliverInvitation } from '@/lib/data/members';
import { newOwnerInvitationView, parseCreateOrganisation } from '@/lib/data/admin';
import { invitationAcceptUrl } from '@/lib/publicOrigin';
import { eatDate } from '@/lib/followup/overdue';
import type { CreateOrganisationResponse } from '@/types/api';

/**
 * Contract route row 41, S-24 (FR-ORG-01): the MAK-AI administrator creates an organisation, records its
 * agreement and invites its first owner, in one definer transaction (`admin_create_organisation`, which writes the
 * `organisation_created` row): if any part fails, nothing is created. The slug is derived from the name and never
 * chosen; a name with no Latin letters or digits gets `org-<random>` (register D-112). The invitation token is 32
 * random bytes, stored only as its hash, and expires seven days later (FR-ORG-02's test). E-01 is sent after the
 * transaction has committed (MEM's `deliverInvitation`): a failed send still answers 201 with `emailSent: false`.
 * `acceptUrl` is returned only with `showLink`, which the definer records as `linkShownAt` (FR-ACC-10). The log
 * line holds ids only (NFR-OBS-01).
 */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const identity = await requireIdentityForApi();
    if (identity.platformRole !== 'admin') throw new AppError(403, 'not_platform_admin');
    const now = new Date();
    const body = parseCreateOrganisation(await readJsonBody(req), eatDate(now));
    const rawToken = randomBytes(32).toString('hex');
    invitationAcceptUrl(rawToken);   // throws now, before any write, when the public origin is not configured
    const slug = deriveSlug(body.name) || `org-${randomBytes(4).toString('hex')}`;
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
    const { orgId, invitationId } = await adminCreateOrganisation({
      actorUserId: identity.userId, name: body.name, slug, agreement: body.agreement, ownerEmail: body.ownerEmail,
      tokenHash: hashInvitationToken(rawToken), expiresAt, linkShown: body.showLink,
    });
    logSecurityEvent('ADMIN_ACTION', 'warn', { userId: identity.userId, details: { action: 'organisation_created', orgId, invitationId } });
    // Nothing after the commit reads the database: the view is built from what was sent (the link must not be lost).
    const invitation = newOwnerInvitationView({ id: invitationId, email: body.ownerEmail, createdAt: now, expiresAt, linkShown: body.showLink });
    const sent = await deliverInvitation({ issued: { invitation, orgName: body.name, rawToken }, showLink: body.showLink, orgId, actorUserId: identity.userId });
    return NextResponse.json({ orgId, slug, ...sent } satisfies CreateOrganisationResponse, { status: 201 });
  } catch (e) {
    return toResponse(e);
  }
}
