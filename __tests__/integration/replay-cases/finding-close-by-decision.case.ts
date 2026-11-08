// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/close-by-decision/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
// Renamed on import: a `use` name called inside `prepare` reads as a React hook to the lint's rules-of-hooks.
import { useFixtureContent as publishFixtureContent } from '../../helpers/content';
import { addDecision, addFinding, addProject } from '../../helpers/recordFixture';

/**
 * Contract route row 11: the owner closes a shortfall finding raised by version 1 (not yet) of Q-PP-01 by version 2
 * (done); rows() counts the finding's mitigation versions. The changed request names version 1, which does not qualify.
 */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/close-by-decision/route.ts',
  method: 'POST',
  async prepare(fx) {
    const { contentVersionId } = await publishFixtureContent('0.0.1-fixture');
    const project = await addProject(fx);
    const at = { stage: 'pre-processing' as const, questionId: 'Q-PP-01', contentVersionId };
    const raising = await addDecision(fx, project.id, { ...at, status: 'not_yet' });
    const finding = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-01', decisionVersionId: raising.id });
    const done = await addDecision(fx, project.id, { ...at, status: 'done' });
    const requestId = randomUUID();
    const body = () => ({ requestId, decisionVersionId: done.id });
    return {
      role: 'owner',
      params: { slug: fx.org.slug, id: project.id, findingId: finding.id },
      body,
      changedBody: () => ({ ...body(), decisionVersionId: raising.id }),
      rows: () => testDb.mitigationVersion.count({ where: { findingId: finding.id } }),
      resourceId: (json) => (json as { id: string }).id,
    };
  },
};
