// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/invitations/[invitationId]/resend/route.ts
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { InviteMemberResponse } from '../../../types/api';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';

/** Contract route row 28: the owner resends a pending invitation; rows() counts member invitations (the old row becomes revoked, it is not deleted). */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/invitations/[invitationId]/resend/route.ts',
  method: 'POST',
  statuses: { first: 201, replay: 200 },
  async prepare(fx) {
    const pending = await testDb.invitation.create({ data: {
      orgId: fx.org.id, email: 'replay-resend@fixture.test', role: 'reviewer', invitedById: fx.members.owner.userId,
      tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'), expiresAt: new Date(Date.now() + 7 * 86_400_000),
    } });
    const requestId = randomUUID();
    const body = () => ({ requestId, showLink: false });
    return {
      role: 'owner',
      params: { slug: fx.org.slug, invitationId: pending.id },
      body,
      changedBody: () => ({ ...body(), showLink: true }),
      rows: () => testDb.invitation.count({ where: { orgId: fx.org.id, kind: 'member' } }),
      resourceId: (json) => (json as InviteMemberResponse).invitation.id,
    };
  },
};
