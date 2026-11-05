// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/unarchive/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
import { addProject } from '../../helpers/recordFixture';

/**
 * Contract route row 22: the owner unarchives a project; the case starts with both projects archived and rows()
 * counts the archived ones, which falls by exactly one.
 */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/unarchive/route.ts',
  method: 'POST',
  statuses: { first: 204, replay: 204 },
  effect: -1,
  async prepare(fx) {
    const project = await addProject(fx, { archived: true });
    const another = await addProject(fx, { archived: true });
    const requestId = randomUUID();
    const body = () => ({ requestId });
    return {
      role: 'owner',
      params: { slug: fx.org.slug, id: project.id },
      body,
      changedBody: () => ({ requestId, note: 'changed' }),
      changedParams: () => ({ slug: fx.org.slug, id: another.id }),
      rows: () => testDb.project.count({ where: { orgId: fx.org.id, archivedAt: { not: null } } }),
    };
  },
};
