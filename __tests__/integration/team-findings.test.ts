import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { listFindings, openShortfallForQuestion } from '@/lib/data/findings';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { markerFor } from '../helpers/markers';
import { callRoute, sessionAs } from '../helpers/routeDriver';
import { addDecision, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

const ROUTE = 'app/api/v1/orgs/[slug]/projects/[id]/findings/route.ts';

let fx: OrgFixture;
let p: { id: string };
let contentVersionId: string;

beforeEach(async () => {
  await resetDb();
  contentVersionId = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg();
  p = await addProject(fx);
});

/** A fixed request except for its request id, which `post` makes new unless the body names one. */
const RAISE = { stage: 'in-processing', title: 'Labels disagree between annotators', description: 'Two annotators label the same rows differently.',
  riskArea: null, questionId: null, decisionVersionId: null } as Record<string, unknown>;

/**
 * Posts to route 5 as `role`. Whenever `origin` is given, the driver sets the `host` header to the host of the URL it builds
 * (an `Origin` with no `Host` is refused by `assertSameOrigin`), so a foreign origin is refused for being foreign; `'own'` is the
 * request's own origin and is the control (round 11b, R11-28).
 */
function post(role: OrgRole, body: Record<string, unknown>, opts: { projectId?: string; origin?: string } = {}) {
  sessionAs(fx.members[role].userId);
  return callRoute(ROUTE, 'POST', {
    slug: fx.org.slug, params: { id: opts.projectId ?? p.id }, body: { requestId: randomUUID(), ...body },
    ...(opts.origin === undefined ? {} : { origin: opts.origin === 'own' ? 'http://localhost' : opts.origin }),
  });
}
const findingsCount = () => testDb.finding.count();

describe('route 5: raise a team finding (FR-FND-02, FR-DEC-07, NFR-INT-02, FR-PRJ-03, NFR-OBS-01)', () => {
  it('FR-FND-02: a reviewer raises a team finding; it is listed for its stage with source team', async () => {
    const res = await post('reviewer', RAISE);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ source: 'team', stage: 'in-processing', state: 'open', raisedBy: { userId: fx.members.reviewer.userId } });
    expect((await listFindings(ctxFor(fx, 'viewer'), p.id, 'in-processing')).map((f) => f.source)).toEqual(['team']);
  });

  it('FR-FND-02: raised about a question and its version, the finding carries both and never counts as the shortfall', async () => {
    const v = await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'done' });
    const f = await (await post('reviewer', { ...RAISE, stage: 'pre-processing', questionId: 'Q-PP-12', decisionVersionId: v.id })).json();
    expect(f).toMatchObject({ questionId: 'Q-PP-12', decisionVersionId: v.id, source: 'team' });
    expect(await openShortfallForQuestion(ctxFor(fx, 'reviewer'), p.id, 'Q-PP-12')).toBeNull();
  });

  it('FR-FND-02: a question without a version, and an area of the stage, are accepted', async () => {
    const res = await post('reviewer', { ...RAISE, stage: 'pre-processing', questionId: 'Q-PP-12', riskArea: 'PP-07' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ questionId: 'Q-PP-12', decisionVersionId: null, riskArea: 'PP-07' });
  });

  it('FR-FND-02 NFR-SEC-02: a viewer gets 403, a foreign Origin 403, nothing written', async () => {
    expect((await post('viewer', RAISE)).status).toBe(403);
    expect((await post('reviewer', RAISE, { origin: 'https://evil.example' })).status).toBe(403);
    expect(await findingsCount()).toBe(0);
    expect((await post('reviewer', RAISE, { origin: 'own' })).status).toBe(201);
  });

  it('FR-FND-02: every role that holds finding:raise can raise, and only those', async () => {
    const answers: Record<string, number> = {};
    for (const role of ['owner', 'admin', 'assessor', 'reviewer', 'viewer'] as const) answers[role] = (await post(role, RAISE)).status;
    expect(answers).toEqual({ owner: 201, admin: 201, assessor: 201, reviewer: 201, viewer: 403 });
  });

  it('FR-FND-02: a question of another stage, a version of another project or question, or an area of another stage answers 422', async () => {
    const other = await addProject(fx, { name: 'Other' });
    const versionOfOtherProject = await addDecision(fx, other.id, { stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'done' });
    const versionOfQPP01 = await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'done' });
    for (const bad of [
      { stage: 'in-processing', questionId: 'Q-PP-12' },
      { questionId: 'Q-PP-12', decisionVersionId: versionOfOtherProject.id },
      { questionId: 'Q-PP-12', decisionVersionId: versionOfQPP01.id },
      { questionId: null, decisionVersionId: versionOfQPP01.id },
      { questionId: 'Q-PP-12', decisionVersionId: randomUUID() },
      { questionId: 'Q-NOPE-99' },
      { stage: 'in-processing', riskArea: 'PP-07' },
      { riskArea: 'NOT-AN-AREA' },
      { title: '' },
    ]) {
      const res = await post('reviewer', { ...RAISE, stage: 'pre-processing', ...bad });
      expect({ bad, status: res.status }).toEqual({ bad, status: 422 });
    }
    expect(await findingsCount()).toBe(0);
  });

  it('FR-FND-02 NFR-SEC-02: a foreign object in the body answers the same fixed text as a missing one, and never echoes the id', async () => {
    const other = await addProject(fx, { name: 'Other' });
    const foreign = await addDecision(fx, other.id, { stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'done' });
    const refusal = async (id: string) => {
      const res = await post('reviewer', { ...RAISE, stage: 'pre-processing', questionId: 'Q-PP-12', decisionVersionId: id });
      return { status: res.status, body: await res.json() };
    };
    const a = await refusal(foreign.id); const b = await refusal(randomUUID());
    expect(a.status).toBe(422);
    expect(a).toEqual(b);
    expect(JSON.stringify(a.body)).not.toContain(foreign.id);
  });

  it('FR-DEC-07 NFR-INT-02: replaying POST app/api/v1/orgs/[slug]/projects/[id]/findings/route.ts with the same request id creates nothing', async () => {
    const R1 = randomUUID();
    const a = await post('reviewer', { ...RAISE, requestId: R1 }); const b = await post('reviewer', { ...RAISE, requestId: R1 });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect((await b.json()).id).toBe((await a.json()).id);
    expect(await findingsCount()).toBe(1);
    expect((await post('reviewer', { ...RAISE, requestId: R1, title: 'Other' })).status).toBe(409);
  });

  it('FR-FND-02: an empty title and no stage answer 422 with the 7.4.2 S-14 texts', async () => {
    const r = await post('reviewer', { ...RAISE, title: '', stage: null });
    expect(r.status).toBe(422);
    expect((await r.json()).fields).toEqual(expect.arrayContaining([{ field: 'title', message: 'Write a title.' }, { field: 'stage', message: 'Choose a stage.' }]));
  });

  it('FR-FND-02: a description is required, and a title of 201 or a description of 4,001 characters answers 422 on its field', async () => {
    const empty = await post('reviewer', { ...RAISE, description: '   ' });
    expect((await empty.json()).fields).toEqual([{ field: 'description', message: 'Write a description.' }]);
    for (const [field, n] of [['title', 201], ['description', 4001]] as const) {
      const r = await post('reviewer', { ...RAISE, [field]: 'x'.repeat(n) });
      expect({ field, status: r.status, fields: (await r.json()).fields.map((f: { field: string }) => f.field) }).toEqual({ field, status: 422, fields: [field] });
    }
    expect((await post('reviewer', { ...RAISE, title: 'x'.repeat(200), description: 'y'.repeat(4000) })).status).toBe(201);
  });

  it('FR-FND-02: texts are stored trimmed and in NFC', async () => {
    const res = await post('reviewer', { ...RAISE, title: '  Café  ', description: '\nOk\n' });
    expect(await res.json()).toMatchObject({ title: 'Café', description: 'Ok' });
  });

  it('FR-DEC-07 NFR-INT-02: the same request id and body sent to another project answers 409 and writes nothing there', async () => {
    const R1 = randomUUID();
    expect((await post('reviewer', { ...RAISE, requestId: R1 })).status).toBe(201);
    const other = await addProject(fx, { name: 'Other' });
    expect((await post('reviewer', { ...RAISE, requestId: R1 }, { projectId: other.id })).status).toBe(409);
    expect(await testDb.finding.count({ where: { projectId: other.id } })).toBe(0);
  });

  it('FR-PRJ-03 RF-4: raising a team finding in an archived project answers 409 project_archived and writes nothing', async () => {
    const archived = await addProject(fx, { archived: true });
    expect(await (await post('reviewer', RAISE, { projectId: archived.id })).json()).toMatchObject({ code: 'project_archived' });
    expect(await findingsCount()).toBe(0);
  });

  it('NFR-SEC-02: a project of another organisation answers 404 and writes nothing', async () => {
    const stranger = await buildOrg({ label: 'other' });
    const foreign = await addProject(stranger);
    const res = await post('reviewer', RAISE, { projectId: foreign.id });
    expect(res.status).toBe(404);
    expect(await findingsCount()).toBe(0);
  });

  it('NFR-OBS-01 NFR-PRIV-03: raising logs FINDING_RAISED once with source team and no text', async () => {
    const { lines } = await captureLogs(() => post('reviewer', { ...RAISE, title: markerFor('title', 1), description: markerFor('description', 1) }));
    expect(lines.filter((l) => l.includes('FINDING_RAISED') && l.includes('team'))).toHaveLength(1);
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
  });

  it('NFR-OBS-01: a replay logs nothing', async () => {
    const R1 = randomUUID();
    await post('reviewer', { ...RAISE, requestId: R1 });
    const { lines } = await captureLogs(() => post('reviewer', { ...RAISE, requestId: R1 }));
    expect(lines.filter((l) => l.includes('FINDING_RAISED'))).toHaveLength(0);
  });
});
