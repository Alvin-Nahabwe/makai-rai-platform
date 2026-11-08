// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/members/leave/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';

/** Contract route row 27: an owner leaves while a second owner exists; the gate refuses their replay with 404. */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/members/leave/route.ts',
  method: 'POST',
  statuses: { first: 204, replay: 404 },
  effect: -1,
  changedRequest: false,
  async prepare(fx) {
    await testDb.membership.updateMany({ where: { orgId: fx.org.id, userId: fx.members.admin.userId }, data: { role: 'owner' } });
    const requestId = randomUUID();
    const body = () => ({ requestId });
    return {
      role: 'owner',
      params: { slug: fx.org.slug },
      body,
      changedBody: body,   // never read: changedRequest is false
      rows: () => testDb.membership.count({ where: { orgId: fx.org.id } }),
    };
  },
};
