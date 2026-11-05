import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { RETRY_KEYED_WRITES, UNKEYED_WRITES } from '@/lib/authz/routeActions';
import { resetDb, testDb } from '../helpers/db';
import { addProject, buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { callRoute, sessionAs, type Method } from '../helpers/routeDriver';

/**
 * PRJ Task 1: create and edit a project (routes 23 POST and 24 PATCH), the type checks of the descriptive fields,
 * the archived refusal, the origin check, tenant isolation and retry safety (FR-PRJ-01, FR-PRJ-03, NFR-SEC-02,
 * NFR-SEC-08, NFR-INT-02). The real handlers run behind AUTHZ's route driver.
 */
const PROJECTS = 'app/api/v1/orgs/[slug]/projects/route.ts';
const PROJECT = 'app/api/v1/orgs/[slug]/projects/[id]/route.ts';
const REQ = '5d1f0c3e-7a2b-4e6d-8c9a-1b2c3d4e5f60';
const LIVE_NAME = 'Live project';
let fx: OrgFixture;
let fxB: OrgFixture;
let live: { id: string };
let other: { id: string };
const NO_SUCH_ID = randomUUID();

interface Opts { origin?: string; requestId?: string | number | undefined }
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** `origin: 'own'` is the request's own origin (the control of the cross-origin cases); any other string is sent as it is. */
function send(f: OrgFixture, method: Method, file: string, role: OrgRole, id: string | undefined, body: Record<string, unknown> | undefined, o: Opts = {}) {
  sessionAs(f.members[role].userId);
  const requestId = hasOwn(o, 'requestId') ? o.requestId : randomUUID();
  const payload = body === undefined ? undefined : { ...(requestId === undefined ? {} : { requestId }), ...body };
  return callRoute(file, method, {
    slug: f.org.slug, params: id === undefined ? undefined : { id },
    origin: o.origin === undefined || o.origin === 'own' ? undefined : o.origin, body: payload,
  });
}
const post = (f: OrgFixture, role: OrgRole, body: Record<string, unknown>, o?: Opts) => send(f, 'POST', PROJECTS, role, undefined, body, o);
const patch = (f: OrgFixture, role: OrgRole, id: string, body: Record<string, unknown>, o?: Opts) => send(f, 'PATCH', PROJECT, role, id, body, o);
const del = (f: OrgFixture, role: OrgRole, id: string, o?: Opts) => send(f, 'DELETE', PROJECT, role, id, {}, o);
const get = (f: OrgFixture, role: OrgRole, id: string) => { sessionAs(f.members[role].userId); return callRoute(PROJECT, 'GET', { slug: f.org.slug, params: { id } }); };
const receiptsOf = (orgId: string) => testDb.requestReceipt.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
const projectRowCounts = async () => ({
  projects: await testDb.project.count(), metadata: await testDb.projectMetadata.count(), receipts: await testDb.requestReceipt.count(),
});
const codeOf = async (r: Response) => ({ status: r.status, code: (await r.json()).code });

beforeEach(async () => {
  await resetDb();
  fx = await buildOrg();
  fxB = await buildOrg({ label: 'b' });
  live = await addProject(fx, { name: LIVE_NAME });
  other = await addProject(fx, { name: 'Another live project' });
});

describe('projects create and edit (routes 23 POST, 24 PATCH)', () => {
  it('FR-PRJ-01: an assessor creates a project with the descriptive fields and reads them back', async () => {
    const res = await post(fx, 'assessor', {
      name: 'Maternal-risk triage', description: 'Triage model', aiSystemType: 'classification', deploymentSector: 'health',
      datasetType: 'tabular', datasetSize: 'medium_1k_100k', processesPersonalData: true, fundingSource: 'GIZ',
      regulatoryContext: 'Uganda DPPA', developmentStage: 'development', projectStart: '2026-09-01', projectEnd: '2027-03-31',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.metadata).toMatchObject({ datasetSize: 'medium_1k_100k', processesPersonalData: true, developmentStage: 'development' });
  });

  it('FR-PRJ-01: a metadata value of the wrong type answers 422 on its field and writes nothing', async () => {
    for (const bad of [{ datasetSize: 'huge' }, { processesPersonalData: 'yes' }, { teamSize: '3x' }, { projectStart: 'soon' }]) {
      const before = await testDb.project.count();
      const res = await post(fx, 'owner', { name: 'P', ...bad });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ code: 'validation', fields: [{ field: Object.keys(bad)[0], message: expect.any(String) }] });
      expect(await testDb.project.count()).toBe(before);
    }
  });

  it('FR-PRJ-01: a missing, blank or overlong name, a long description and an unknown key each answer 422 on their field', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, 'name'], [{ name: '   ' }, 'name'], [{ name: 'x'.repeat(201) }, 'name'], [{ name: 'P', description: 'd'.repeat(2001) }, 'description'], [{ name: 'P', bogus: 1 }, 'bogus'],
    ];
    for (const [body, field] of cases) {
      const before = await testDb.project.count();
      const res = await post(fx, 'owner', body);
      expect({ status: res.status, field: (await res.json()).fields?.[0]?.field }).toEqual({ status: 422, field });
      expect(await testDb.project.count()).toBe(before);
    }
    const res = await patch(fx, 'owner', live.id, { name: '   ' });
    expect({ status: res.status, field: (await res.json()).fields?.[0]?.field }).toEqual({ status: 422, field: 'name' });
    expect((await testDb.project.findUnique({ where: { id: live.id } }))!.name).toBe(LIVE_NAME);
  });

  it('NFR-INT-02: a request id that is a number, not a UUID, answers 422 on requestId, not 500', async () => {
    for (const call of [() => post(fx, 'owner', { name: 'P' }, { requestId: 1.5 as never }), () => patch(fx, 'owner', live.id, { name: 'Q' }, { requestId: 1.5 as never })]) {
      const res = await call();
      expect({ status: res.status, field: (await res.json()).fields?.[0]?.field }).toEqual({ status: 422, field: 'requestId' });
    }
  });

  it('FR-PRJ-01 FR-AUTHZ-01: a reviewer and a viewer cannot create a project (403)', async () => {
    for (const role of ['reviewer', 'viewer'] as const) expect((await post(fx, role, { name: 'P' })).status).toBe(403);
  });

  it('FR-PRJ-03 UX-31: PATCH on an archived project answers 409 project_archived and changes nothing', async () => {
    const p = await addProject(fx, { name: 'Old', archived: true });
    const res = await patch(fx, 'owner', p.id, { name: 'New' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'project_archived' });
    expect((await testDb.project.findUnique({ where: { id: p.id } }))!.name).toBe('Old');
  });

  it('NFR-INT-02: a replay of a project create answers 200 with the first project and creates nothing; the same id with another name answers 409 request_id_reused', async () => {
    const body = { name: 'Replay probe', description: 'd' };
    const first = await post(fx, 'assessor', body, { requestId: REQ });
    const created = await first.json();
    const before = await projectRowCounts();
    const again = await post(fx, 'assessor', body, { requestId: REQ });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect((await again.json()).id).toBe(created.id);
    expect(await projectRowCounts()).toEqual(before);
    expect(await receiptsOf(fx.org.id)).toEqual([expect.objectContaining({ requestId: REQ, route: 'app/api/v1/orgs/[slug]/projects/route.ts::POST', rowId: created.id })]);
    const changed = await post(fx, 'assessor', { ...body, name: 'Another name' }, { requestId: REQ });
    expect(await codeOf(changed)).toEqual({ status: 409, code: 'request_id_reused' });
    expect(await testDb.project.count({ where: { orgId: fx.org.id, name: 'Another name' } })).toBe(0);
  });

  it('NFR-INT-02: a replay of an edit answers 200 and changes nothing more; the same id for another project or by another member answers 409 request_id_reused', async () => {
    const body = { name: 'Edited once' };
    expect((await patch(fx, 'owner', live.id, body, { requestId: REQ })).status).toBe(200);
    await testDb.project.update({ where: { id: live.id }, data: { updatedAt: new Date('2026-01-01T00:00:00Z') } });
    expect((await patch(fx, 'owner', live.id, body, { requestId: REQ })).status).toBe(200);
    expect((await testDb.project.findUniqueOrThrow({ where: { id: live.id } })).updatedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(await receiptsOf(fx.org.id)).toEqual([expect.objectContaining({ route: 'app/api/v1/orgs/[slug]/projects/[id]/route.ts::PATCH', rowId: null })]);
    for (const call of [() => patch(fx, 'owner', other.id, body, { requestId: REQ }), () => patch(fx, 'admin', live.id, body, { requestId: REQ })]) {
      expect(await codeOf(await call())).toEqual({ status: 409, code: 'request_id_reused' });
    }
  });

  it('NFR-INT-02: a project write without a request id, or with a malformed one, answers 422 on requestId and writes nothing', async () => {
    for (const requestId of [undefined, 'not-a-uuid']) {
      const before = await testDb.project.count();
      const r = await post(fx, 'owner', { name: 'No id' }, { requestId });
      expect(r.status).toBe(422);
      expect((await r.json()).fields).toEqual([expect.objectContaining({ field: 'requestId' })]);
      expect(await testDb.project.count()).toBe(before);
    }
  });

  it('NFR-INT-02: route 23 POST and route 24 PATCH are listed in RETRY_KEYED_WRITES and not in UNKEYED_WRITES', () => {
    expect(RETRY_KEYED_WRITES['app/api/v1/orgs/[slug]/projects/route.ts']).toContain('POST');
    expect(RETRY_KEYED_WRITES['app/api/v1/orgs/[slug]/projects/[id]/route.ts']).toContain('PATCH');
    expect(UNKEYED_WRITES['app/api/v1/orgs/[slug]/projects/route.ts']).toBeUndefined();
    expect(UNKEYED_WRITES['app/api/v1/orgs/[slug]/projects/[id]/route.ts']?.methods ?? []).not.toContain('PATCH');
  });

  it('NFR-SEC-08: project writes from another origin answer 403 cross_origin', async () => {
    for (const call of [() => post(fx, 'owner', { name: 'P' }, { origin: 'https://evil.example' }),
                        () => patch(fx, 'owner', live.id, { name: 'X' }, { origin: 'null' }),
                        () => del(fx, 'owner', live.id, { origin: 'https://evil.example' })]) {
      expect(await (await call()).json()).toMatchObject({ code: 'cross_origin' });
    }
    expect((await post(fx, 'owner', { name: 'Own origin' }, { origin: 'own' })).status).toBe(201);
  });

  it('NFR-SEC-02: PATCH and DELETE of another organisation\'s project answer 404 and change nothing', async () => {
    for (const res of [await patch(fxB, 'owner', live.id, { name: 'X' }), await del(fxB, 'owner', live.id),
                       await get(fxB, 'owner', live.id), await patch(fx, 'owner', NO_SUCH_ID, { name: 'X' })]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'not_found' });
    }
    expect((await testDb.project.findUnique({ where: { id: live.id } }))!.name).toBe(LIVE_NAME);
  });

  it('SRS 11.2 FR-PRJ-02: GET /projects and GET /projects/[id] answer with no assessments key even when the project has a frozen assessment', async () => {
    const p = await addProject(fx, { name: 'Has a frozen row' });
    const fv = await testDb.frameworkVersion.findFirstOrThrow();   // the owner connection may still insert into the frozen table; the application role may not
    await testDb.assessment.create({ data: { orgId: fx.org.id, projectId: p.id, userId: fx.members.owner.userId, frameworkVersionId: fv.id, engineState: {} } });
    sessionAs(fx.members.viewer.userId);
    const list = await (await callRoute(PROJECTS, 'GET', { slug: fx.org.slug })).json();
    const one = await (await get(fx, 'viewer', p.id)).json();
    expect(list.find((x: { id: string }) => x.id === p.id)).not.toHaveProperty('assessments');
    expect(one).not.toHaveProperty('assessments');
    expect(one).toMatchObject({ id: p.id, name: 'Has a frozen row' });
    expect(one).toHaveProperty('createdBy');
  });
});
