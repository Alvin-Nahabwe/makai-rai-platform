// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
import { addProject } from '../../helpers/recordFixture';

/** Contract route row 24 DELETE: the owner deletes an empty project; rows() counts the organisation's projects, which falls by one. */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/route.ts',
  method: 'DELETE',
  statuses: { first: 200, replay: 200 },
  effect: -1,
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
      rows: () => testDb.project.count({ where: { orgId: fx.org.id } }),
    };
  },
};
