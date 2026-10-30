// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/decisions/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
import { useFixtureContent } from '../../helpers/content';
import { addProject } from '../../helpers/recordFixture';

/** Contract route row 1: a first decision on Q-PP-01 of a new project, by its assessor; rows() counts the project's versions. */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/decisions/route.ts',
  method: 'POST',
  async prepare(fx) {
    await useFixtureContent('0.0.1-fixture');
    const project = await addProject(fx);
    const requestId = randomUUID();
    const body = () => ({
      requestId, stage: 'pre-processing', questionId: 'Q-PP-01', baseVersionNumber: null, status: 'done', scopeAnswer: null,
      optionsInPlace: [], reasonCode: null, reason: 'Replay case reason', decidedBy: { kind: 'member', userId: fx.members.assessor.userId },
      declaredDate: '2026-10-12', evidenceIds: [],
    });
    return {
      role: 'assessor',
      params: { slug: fx.org.slug, id: project.id },
      body,
      changedBody: () => ({ ...body(), reason: 'Replay case reason, changed' }),
      rows: () => testDb.decisionVersion.count({ where: { projectId: project.id } }),
      resourceId: (json) => (json as { id: string }).id,
    };
  },
};
