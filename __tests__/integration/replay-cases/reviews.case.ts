// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/reviews/route.ts
import { randomUUID } from 'node:crypto';
import type { StageReviewView } from '@/types/api';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
import { addProject } from '../../helpers/recordFixture';

/**
 * Contract route row 12: an assessor opens a pre-processing review with a note. The changed request is the same id
 * with another note, which answers 409 `request_id_reused` (its digest differs); `rows()` counts the project's reviews.
 */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/reviews/route.ts',
  method: 'POST',
  async prepare(fx) {
    const p = await addProject(fx);
    const requestId = randomUUID();
    return {
      role: 'assessor',
      params: { slug: fx.org.slug, id: p.id },
      body: () => ({ requestId, stage: 'pre-processing', preparedFor: 'Ethics submission' }),
      changedBody: () => ({ requestId, stage: 'pre-processing', preparedFor: 'Other' }),
      rows: () => testDb.stageReview.count({ where: { projectId: p.id } }),
      resourceId: (json) => (json as StageReviewView).id,
    };
  },
};
