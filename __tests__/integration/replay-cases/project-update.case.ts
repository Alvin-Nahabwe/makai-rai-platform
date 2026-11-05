// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
import { addProject } from '../../helpers/recordFixture';

const NEW_NAME = 'Replay case project, edited';

/** Contract route row 24 PATCH: the owner renames a project; rows() counts the organisation's projects with the new name. */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/route.ts',
  method: 'PATCH',
  statuses: { first: 200, replay: 200 },
  async prepare(fx) {
    const project = await addProject(fx, { name: 'Replay case project' });
    const requestId = randomUUID();
    const body = () => ({ requestId, name: NEW_NAME });
    return {
      role: 'owner',
      params: { slug: fx.org.slug, id: project.id },
      body,
      changedBody: () => ({ ...body(), name: 'Replay case project, changed' }),
      rows: () => testDb.project.count({ where: { orgId: fx.org.id, name: NEW_NAME } }),
    };
  },
};
