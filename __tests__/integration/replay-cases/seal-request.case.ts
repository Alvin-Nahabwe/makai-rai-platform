// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/reviews/seal-request/route.ts
import { randomUUID } from 'node:crypto';
import type { StageReviewView } from '@/types/api';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
import { addProject } from '../../helpers/recordFixture';

/**
 * Design G2: an assessor asks for a seal of a stage with no review, which opens one (201); the replay answers the same
 * review (200). The changed request is the same id for another stage, which answers 409 `request_id_reused` (its digest
 * differs); `rows()` counts the project's reviews.
 */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/reviews/seal-request/route.ts',
  method: 'POST',
  async prepare(fx) {
    const p = await addProject(fx);
    const requestId = randomUUID();
    return {
      role: 'assessor',
      params: { slug: fx.org.slug, id: p.id },
      body: () => ({ requestId, stage: 'pre-processing' }),
      changedBody: () => ({ requestId, stage: 'in-processing' }),
      rows: () => testDb.stageReview.count({ where: { projectId: p.id } }),
      resourceId: (json) => (json as StageReviewView).id,
    };
  },
};
