// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/members/route.ts
import { randomUUID } from 'node:crypto';
import type { InviteMemberResponse } from '../../../types/api';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';

/** Contract route row 25: the owner invites a reviewer; rows() counts the organisation's member invitations. */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/members/route.ts',
  method: 'POST',
  statuses: { first: 201, replay: 200 },
  async prepare(fx) {
    const requestId = randomUUID();
    const body = () => ({ requestId, email: 'replay-invitee@fixture.test', role: 'reviewer', showLink: false });
    return {
      role: 'owner',
      params: { slug: fx.org.slug },
      body,
      changedBody: () => ({ ...body(), role: 'viewer' }),
      rows: () => testDb.invitation.count({ where: { orgId: fx.org.id, kind: 'member' } }),
      resourceId: (json) => (json as InviteMemberResponse).invitation.id,
    };
  },
};
