// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/mitigations/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
import { addFinding, addProject } from '../../helpers/recordFixture';

/** Contract route row 6: the owner adds version 1 of a mitigation to an open team finding; rows() counts the finding's versions. */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/mitigations/route.ts',
  method: 'POST',
  async prepare(fx) {
    const project = await addProject(fx);
    const finding = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team' });
    const requestId = randomUUID();
    const body = () => ({
      requestId, what: 'Replay case action', ownerUserId: fx.members.assessor.userId, dueDate: '2026-12-01', status: 'planned',
      followsControl: null, closureNote: null, cancelReason: null, evidenceIds: [],
    });
    return {
      role: 'owner',
      params: { slug: fx.org.slug, id: project.id, findingId: finding.id },
      body,
      changedBody: () => ({ ...body(), what: 'Replay case action, changed' }),
      rows: () => testDb.mitigationVersion.count({ where: { findingId: finding.id } }),
      resourceId: (json) => (json as { id: string }).id,
    };
  },
};
