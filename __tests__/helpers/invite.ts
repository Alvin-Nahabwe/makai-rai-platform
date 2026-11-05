import { randomUUID } from 'node:crypto';
import type { OrgRole } from '@prisma/client';
import { inviteMember } from '../../lib/data/members';
import { requestDigest } from '../../lib/data/idempotency';
import type { OrgContext } from '../../lib/data/tenant';

/**
 * Issues a member invitation through the member service (the receipt-mode write of route 25), for tests that need a
 * pending invitation and its token without going through the route. Returns what those tests read.
 */
export async function createInvitation(input: { ctx: OrgContext; email: string; role: OrgRole; invitedById: string }) {
  const body = { requestId: randomUUID(), email: input.email, role: input.role, showLink: false };
  const { value } = await inviteMember(input.ctx, { userId: input.invitedById, role: input.ctx.role }, body, requestDigest({ path: {}, body }));
  return { id: value.invitation.id, rawToken: value.rawToken as string, orgName: value.orgName, expiresAt: new Date(value.invitation.expiresAt) };
}
