// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/questions/[questionId]/withdrawal/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
import { useFixtureContent } from '../../helpers/content';
import { addDecision, addProject } from '../../helpers/recordFixture';

/** Contract route row 2: the assessor withdraws version 2 of Q-PP-01, two versions they entered; rows() counts the project's versions. */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/questions/[questionId]/withdrawal/route.ts',
  method: 'POST',
  async prepare(fx) {
    const { contentVersionId } = await useFixtureContent('0.0.1-fixture');
    const project = await addProject(fx);
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'done', by: 'assessor' });
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'partly', by: 'assessor' });
    const requestId = randomUUID();
    const body = () => ({ requestId, stage: 'pre-processing', baseVersionNumber: 2, withdrawalCode: 'duplicate', reason: 'Replay case withdrawal' });
    return {
      role: 'assessor',
      params: { slug: fx.org.slug, id: project.id, questionId: 'Q-PP-01' },
      body,
      changedBody: () => ({ ...body(), withdrawalCode: 'test_entry' }),
      rows: () => testDb.decisionVersion.count({ where: { projectId: project.id } }),
      resourceId: (json) => (json as { id: string }).id,
    };
  },
};
