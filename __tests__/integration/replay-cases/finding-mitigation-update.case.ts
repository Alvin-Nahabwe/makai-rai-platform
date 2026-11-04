// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/mitigations/[mitigationId]/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
import { addFinding, addMitigationVersion, addProject } from '../../helpers/recordFixture';

/** Contract route row 7: the owner saves version 2 of a planned mitigation, based on version 1; rows() counts its versions. */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/mitigations/[mitigationId]/route.ts',
  method: 'POST',
  async prepare(fx) {
    const project = await addProject(fx);
    const finding = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team' });
    const m = await addMitigationVersion(fx, finding.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
    const requestId = randomUUID();
    const body = () => ({
      requestId, what: 'Replay case action', ownerUserId: fx.members.assessor.userId, dueDate: '2026-12-01', status: 'in_progress',
      followsControl: null, closureNote: null, cancelReason: null, evidenceIds: [], baseVersionNumber: 1, changeNote: null,
    });
    return {
      role: 'owner',
      params: { slug: fx.org.slug, id: project.id, findingId: finding.id, mitigationId: m.mitigationId },
      body,
      changedBody: () => ({ ...body(), what: 'Replay case action, changed' }),
      rows: () => testDb.mitigationVersion.count({ where: { mitigationId: m.mitigationId } }),
      resourceId: (json) => (json as { id: string }).id,
    };
  },
};
