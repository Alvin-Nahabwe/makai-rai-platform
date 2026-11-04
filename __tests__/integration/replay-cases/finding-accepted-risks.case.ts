// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/accepted-risks/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
import { addFinding, addMitigationVersion, addProject } from '../../helpers/recordFixture';

/**
 * Contract route row 8: the owner accepts the risk of an open team finding that has one planned mitigation, which the
 * acceptance cancels; rows() counts the finding's accepted risks (the cancelled version is a further row of another table).
 */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/accepted-risks/route.ts',
  method: 'POST',
  async prepare(fx) {
    const project = await addProject(fx);
    const finding = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team' });
    await addMitigationVersion(fx, finding.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
    const requestId = randomUUID();
    const body = () => ({
      requestId, mode: 'accept', acceptedBy: { kind: 'outside_role', role: 'ethics_committee' }, reason: 'Replay case reason',
      lookAgainOn: null, lookAgainNote: null,
    });
    return {
      role: 'owner',
      params: { slug: fx.org.slug, id: project.id, findingId: finding.id },
      body,
      changedBody: () => ({ ...body(), reason: 'Replay case reason, changed' }),
      rows: () => testDb.acceptedRisk.count({ where: { findingId: finding.id } }),
      resourceId: (json) => (json as { id: string }).id,
    };
  },
};
