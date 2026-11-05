// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/members/[userId]/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';

/** Contract route row 26 PATCH: the owner changes the assessor to reviewer; rows() counts the organisation's member_role_changed rows. */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/members/[userId]/route.ts',
  method: 'PATCH',
  statuses: { first: 204, replay: 204 },
  async prepare(fx) {
    const requestId = randomUUID();
    const body = () => ({ requestId, role: 'reviewer' });
    return {
      role: 'owner',
      params: { slug: fx.org.slug, userId: fx.members.assessor.userId },
      body,
      changedBody: () => ({ ...body(), role: 'viewer' }),
      rows: () => testDb.organisationEvent.count({ where: { orgId: fx.org.id, action: 'member_role_changed' } }),
    };
  },
};
