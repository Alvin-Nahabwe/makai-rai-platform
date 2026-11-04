// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/reopen/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
import { addFinding, addMitigationVersion, addProject } from '../../helpers/recordFixture';

/** Contract route row 9: the owner reopens a team finding closed by a done mitigation; rows() counts the finding's events. */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/reopen/route.ts',
  method: 'POST',
  async prepare(fx) {
    const project = await addProject(fx);
    const finding = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team' });
    await addMitigationVersion(fx, finding.id, { status: 'done', owner: 'assessor', dueDate: '2026-12-01' });
    const requestId = randomUUID();
    const body = () => ({ requestId, reason: 'Replay case reopen', eventCode: null });
    return {
      role: 'owner',
      params: { slug: fx.org.slug, id: project.id, findingId: finding.id },
      body,
      changedBody: () => ({ ...body(), reason: 'Replay case reopen, changed' }),
      rows: () => testDb.findingEvent.count({ where: { findingId: finding.id } }),
      resourceId: (json) => (json as { id: string }).id,
    };
  },
};
