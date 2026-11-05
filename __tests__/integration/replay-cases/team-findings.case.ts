// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/findings/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
import { addProject } from '../../helpers/recordFixture';

/** Contract route row 5: a reviewer raises a team finding; rows() counts the project's findings, resourceId is the answer's id. */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/findings/route.ts',
  method: 'POST',
  async prepare(fx) {
    const project = await addProject(fx);
    const requestId = randomUUID();
    const body = () => ({
      requestId, stage: 'in-processing', title: 'Replay case finding', description: 'Raised by the replay case.',
      riskArea: null, questionId: null, decisionVersionId: null,
    });
    return {
      role: 'reviewer',
      params: { slug: fx.org.slug, id: project.id },
      body,
      changedBody: () => ({ ...body(), title: 'Replay case finding, changed' }),
      rows: () => testDb.finding.count({ where: { projectId: project.id } }),
      resourceId: (json) => (json as { id: string }).id,
    };
  },
};
