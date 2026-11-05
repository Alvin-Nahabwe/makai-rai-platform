// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/archive/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
import { addProject } from '../../helpers/recordFixture';

/**
 * Contract route row 21: the owner archives a project; rows() counts the organisation's archived projects, over both
 * projects, so a refused call that archived the other one fails the case.
 */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/archive/route.ts',
  method: 'POST',
  statuses: { first: 204, replay: 204 },
  async prepare(fx) {
    const project = await addProject(fx);
    const another = await addProject(fx);
    const requestId = randomUUID();
    const body = () => ({ requestId });
    return {
      role: 'owner',
      params: { slug: fx.org.slug, id: project.id },
      body,
      changedBody: () => ({ requestId, note: 'changed' }),
      changedParams: () => ({ slug: fx.org.slug, id: another.id }),
      rows: () => testDb.project.count({ where: { orgId: fx.org.id, archivedAt: { not: null } } }),
    };
  },
};
