// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/seals/route.ts
import { randomUUID } from 'node:crypto';
import type { SealView } from '@/types/api';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
// Renamed on import: a `use` name called inside `prepare` reads as a React hook to the lint's rules-of-hooks.
import { useFixtureContent as publishFixtureContent } from '../../helpers/content';
import { addDecision, addProject, addStageReview } from '../../helpers/recordFixture';

/**
 * Contract route row 13: the reviewer seals a review of a stage with one decision. `SealRequest` has only
 * `requestId`, and any other key answers 422 (obligation A1), so no body change can give 409: the changed request
 * is the same id against another review of the project (`changedParams`), and `rows()` counts both reviews' seals.
 */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/seals/route.ts',
  method: 'POST',
  async prepare(fx) {
    const { contentVersionId } = await publishFixtureContent('0.0.1-fixture');
    const p = await addProject(fx);
    await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, declaredDate: '2026-10-20' });
    const r = await addStageReview(fx, p.id, { stage: 'pre-processing' });
    const r2 = await addStageReview(fx, p.id, { stage: 'pre-processing' });
    const requestId = randomUUID();
    return {
      role: 'reviewer',
      params: { slug: fx.org.slug, id: p.id, reviewId: r.id },
      body: () => ({ requestId }),
      changedBody: () => ({ requestId }),                                         // SealRequest has no other key
      changedParams: () => ({ slug: fx.org.slug, id: p.id, reviewId: r2.id }),    // the 409 case by path (contract ReplayCase row)
      rows: () => testDb.seal.count({ where: { stageReviewId: { in: [r.id, r2.id] } } }),
      resourceId: (json) => (json as SealView).id,
    };
  },
};
