// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/invitations/[invitationId]/revoke/route.ts
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';

/** Contract route row 29: the owner revokes a pending invitation; rows() counts revoked invitations of both, since the conflicting request names the other one. */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/invitations/[invitationId]/revoke/route.ts',
  method: 'POST',
  statuses: { first: 204, replay: 204 },
  async prepare(fx) {
    const make = (email: string) => testDb.invitation.create({ data: {
      orgId: fx.org.id, email, role: 'reviewer', invitedById: fx.members.owner.userId,
      tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'), expiresAt: new Date(Date.now() + 7 * 86_400_000),
    } });
    const first = await make('replay-revoke-1@fixture.test');
    const other = await make('replay-revoke-2@fixture.test');
    const requestId = randomUUID();
    const body = () => ({ requestId });
    return {
      role: 'owner',
      params: { slug: fx.org.slug, invitationId: first.id },
      body,
      changedBody: body,
      changedParams: () => ({ slug: fx.org.slug, invitationId: other.id }),
      rows: () => testDb.invitation.count({ where: { orgId: fx.org.id, status: 'revoked' } }),
    };
  },
};
