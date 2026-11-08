import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import type { OrgRole } from '@prisma/client';
import { GET } from '@/app/api/v1/orgs/[slug]/projects/[id]/questions/[questionId]/decision/route';
import { ROUTE_ACTIONS } from '@/lib/authz/routeActions';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { clearSession, sessionFor } from '../helpers/authSession';
import { addDecision, addProject, buildOrg, type OrgFixture } from '../helpers/recordFixture';

/**
 * Contract route 48 (FR-OPS-01's read step, NFR-SEC-02): the current decision of one question in one stage.
 * The synthetic journey reads it before and after its save. Runs on the fixture content bundle that holds
 * Q-PP-01 and Q-PP-02, never on the live content files.
 */

const FILE = 'app/api/v1/orgs/[slug]/projects/[id]/questions/[questionId]/decision/route.ts';

let fx: OrgFixture;
let fxB: OrgFixture;
let project: { id: string };
let contentVersionId: string;

beforeEach(async () => {
  await resetDb();
  contentVersionId = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg();
  fxB = await buildOrg({ label: 'other' });
  project = await addProject(fx);
  clearSession();
});

const get = (who: OrgFixture | null, role: OrgRole, slug: string, projectId: string, questionId: string, stage: string | null) => {
  if (who) sessionFor(who.members[role].userId); else clearSession();
  const query = stage === null ? '' : `?stage=${encodeURIComponent(stage)}`;
  return GET(new NextRequest(`http://localhost/api/v1/orgs/${slug}/projects/${projectId}/questions/${questionId}/decision${query}`),
    { params: Promise.resolve({ slug, id: projectId, questionId }) });
};

describe('route 48, GET .../questions/[questionId]/decision?stage=', () => {
  it('FR-OPS-01: the route answers the current decision of a question, then null for one without', async () => {
    const d = await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'done' });
    const res = await get(fx, 'viewer', fx.org.slug, project.id, 'Q-PP-01', 'pre-processing');
    expect(res.status).toBe(200);
    expect((await res.json()).current).toMatchObject({ id: d.id, versionNumber: d.versionNumber, status: 'done', questionId: 'Q-PP-01' });
    expect((await (await get(fx, 'viewer', fx.org.slug, project.id, 'Q-PP-02', 'pre-processing')).json())).toEqual({ current: null });
  });

  it('FR-OPS-01: after a second version the route answers that one, and a stage that does not hold the question answers null', async () => {
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'done' });
    const v2 = await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'partly' });
    const now = await (await get(fx, 'viewer', fx.org.slug, project.id, 'Q-PP-01', 'pre-processing')).json();
    expect(now.current).toMatchObject({ id: v2.id, versionNumber: 2, status: 'partly' });
    expect(await (await get(fx, 'viewer', fx.org.slug, project.id, 'Q-PP-01', 'in-processing')).json()).toEqual({ current: null });
  });

  it('NFR-SEC-02: the current-decision route answers 404 for another organisation\'s project, and 401 with no session', async () => {
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'done' });
    // A member of B asking A's slug: not a member of A.
    expect((await get(fxB, 'owner', fx.org.slug, project.id, 'Q-PP-01', 'pre-processing')).status).toBe(404);
    // A member of B asking B's slug for A's project id: the project is not B's.
    const res = await get(fxB, 'owner', fxB.org.slug, project.id, 'Q-PP-01', 'pre-processing');
    expect([res.status, (await res.json()).code]).toEqual([404, 'not_found']);
    // A project that never existed answers the same.
    expect((await get(fx, 'viewer', fx.org.slug, '00000000-0000-4000-8000-000000000000', 'Q-PP-01', 'pre-processing')).status).toBe(404);
    expect((await get(fx, 'viewer', fx.org.slug, 'not-a-uuid', 'Q-PP-01', 'pre-processing')).status).toBe(404);
    expect((await get(null, 'viewer', fx.org.slug, project.id, 'Q-PP-01', 'pre-processing')).status).toBe(401);
  });

  it('FR-OPS-01: an unknown or missing stage answers 422 on field stage', async () => {
    for (const stage of ['later', '', null]) {
      const res = await get(fx, 'viewer', fx.org.slug, project.id, 'Q-PP-01', stage);
      expect({ stage, status: res.status, body: await res.json() }).toMatchObject({ stage, status: 422, body: { code: 'validation', fields: [{ field: 'stage' }] } });
    }
  });

  it('NFR-SEC-02: record:read is held by every role, and the route is in ROUTE_ACTIONS as GET record:read', async () => {
    expect(ROUTE_ACTIONS[FILE]).toEqual({ GET: 'record:read' });
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'done' });
    for (const role of ['owner', 'admin', 'assessor', 'reviewer', 'viewer'] as OrgRole[]) {
      const res = await get(fx, role, fx.org.slug, project.id, 'Q-PP-01', 'pre-processing');
      expect({ role, status: res.status }).toEqual({ role, status: 200 });
    }
  });
});
