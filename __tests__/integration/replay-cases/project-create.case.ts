// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';

/** Contract route row 23 POST: an assessor creates a project; rows() counts the organisation's projects. */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/route.ts',
  method: 'POST',
  statuses: { first: 201, replay: 200 },
  async prepare(fx) {
    const requestId = randomUUID();
    const body = () => ({ requestId, name: 'Replay case project', description: 'Created once' });
    return {
      role: 'assessor',
      params: { slug: fx.org.slug },
      body,
      changedBody: () => ({ ...body(), name: 'Replay case project, changed' }),
      rows: () => testDb.project.count({ where: { orgId: fx.org.id } }),
      resourceId: (json) => (json as { id: string }).id,
    };
  },
};
