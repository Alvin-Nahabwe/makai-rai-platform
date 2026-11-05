// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/members/[userId]/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';

/** Contract route row 26 DELETE (another member): the owner removes the viewer; rows() counts the organisation's memberships. */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/members/[userId]/route.ts',
  method: 'DELETE',
  statuses: { first: 204, replay: 204 },
  effect: -1,
  async prepare(fx) {
    const requestId = randomUUID();
    const body = () => ({ requestId });
    return {
      role: 'owner',
      params: { slug: fx.org.slug, userId: fx.members.viewer.userId },
      body,
      changedBody: body,
      changedParams: () => ({ slug: fx.org.slug, userId: fx.members.reviewer.userId }),
      rows: () => testDb.membership.count({ where: { orgId: fx.org.id } }),
    };
  },
};
