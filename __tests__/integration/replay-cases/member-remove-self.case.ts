// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/members/[userId]/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';

/**
 * Contract route row 26 DELETE (the caller removes themself): a second owner exists. After the first call the caller
 * is no longer a member, so the gate answers their replay with 404 before any receipt is read.
 */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/members/[userId]/route.ts',
  method: 'DELETE',
  statuses: { first: 204, replay: 404 },
  effect: -1,
  changedRequest: false,
  async prepare(fx) {
    await testDb.membership.updateMany({ where: { orgId: fx.org.id, userId: fx.members.admin.userId }, data: { role: 'owner' } });
    const requestId = randomUUID();
    const body = () => ({ requestId });
    return {
      role: 'owner',
      params: { slug: fx.org.slug, userId: fx.members.owner.userId },
      body,
      changedBody: body,   // never read: changedRequest is false
      rows: () => testDb.membership.count({ where: { orgId: fx.org.id } }),
    };
  },
};
