// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents/route.ts
import { randomUUID } from 'node:crypto';
import type { IssuedDocumentView } from '@/types/api';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
// Renamed on import: a `use` name called inside `prepare` reads as a React hook to the lint's rules-of-hooks.
import { useFixtureContent as publishFixtureContent } from '../../helpers/content';
import { addDecision, addProject, addStageReview } from '../../helpers/recordFixture';
import { sealFixture } from '../../helpers/sealFixture';

/**
 * Contract route row 16: the admin issues a data card from a seal of a pre-processing review with one decision. The changed
 * request is the same request id with other typed fields.
 */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents/route.ts',
  method: 'POST',
  async prepare(fx) {
    const { contentVersionId } = await publishFixtureContent('0.0.1-fixture');
    const p = await addProject(fx);
    const decision = await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, declaredDate: '2026-10-20', decidedBy: { kind: 'member', userId: fx.members.owner.userId } });
    const review = await addStageReview(fx, p.id, { stage: 'pre-processing' });
    const seal = await sealFixture(fx, review.id, { projectId: p.id, stage: 'pre-processing', contentVersionId, decisionVersionIds: [decision.id] });
    const requestId = randomUUID();
    return {
      role: 'admin',
      params: { slug: fx.org.slug, id: p.id, reviewId: review.id },
      body: () => ({ requestId, documentType: 'data_card', sealId: seal.id, typedFields: {} }),
      changedBody: () => ({ requestId, documentType: 'data_card', sealId: seal.id, typedFields: { 'DC-25': 'changed' } }),
      rows: () => testDb.issuedDocument.count({ where: { stageReviewId: review.id } }),
      resourceId: (json) => (json as IssuedDocumentView).id,
    };
  },
};
