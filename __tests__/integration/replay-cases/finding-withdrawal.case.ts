// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/withdrawal/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
import { addFinding, addProject } from '../../helpers/recordFixture';

/** Contract route row 10: the owner withdraws an open team finding; rows() counts the finding's events. */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/withdrawal/route.ts',
  method: 'POST',
  async prepare(fx) {
    const project = await addProject(fx);
    const finding = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team' });
    const requestId = randomUUID();
    const body = () => ({ requestId, reason: 'Replay case withdrawal', eventCode: null });
    return {
      role: 'owner',
      params: { slug: fx.org.slug, id: project.id, findingId: finding.id },
      body,
      changedBody: () => ({ ...body(), reason: 'Replay case withdrawal, changed' }),
      rows: () => testDb.findingEvent.count({ where: { findingId: finding.id } }),
      resourceId: (json) => (json as { id: string }).id,
    };
  },
};
