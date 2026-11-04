import 'dotenv/config';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test, expect, request, type APIRequestContext } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { can, type Action } from '../lib/authz/policy';
import { PENDING_ROUTES, ROUTE_ACTIONS } from '../lib/authz/routeActions';
import { FIXTURE_ROLES } from '../__tests__/helpers/fixture';
import { testDb } from '../__tests__/helpers/db';
import { addEvidence, addProject, type FixtureMember, type OrgFixture } from '../__tests__/helpers/recordFixture';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';

/**
 * FR-AUTHZ-01 and NFR-SEC-03 end to end: each role's saved session (the seats e2e/fixtures/auth.setup.ts
 * signed in through /login) sends one write per action of ROUTE_ACTIONS through the HTTP API of the running
 * server, and is refused 403 exactly when `can(role, action)` is false. NFR-SEC-02: five routes answer 404 to a
 * member of A naming an object of B (SRS line 2909, "the same check for five routes in the end-to-end run").
 *
 * The seats are shared with later specs, so no write here leaves a seat changed: each role deletes a project
 * made for that delete alone, the member PATCH and DELETE name a member of A made for that role, and a seat that leaves A is
 * put back. The objects are written with the record fixture builder into the database the server
 * reads (.env, as auth.setup.ts does).
 */

const manifest: FixtureManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
const [orgA, orgB] = manifest.orgs;

function seat(orgSlug: string, role: OrgRole): FixtureManifestUser {
  const found = manifest.users.find((u) => u.orgSlug === orgSlug && u.role === role && u.index === 0);
  if (!found) throw new Error(`authz-api-matrix: no fixture seat for ${orgSlug}/${role}/0`);
  return found;
}

/** The record fixture builder's view of a manifest organisation (its index-0 seats). */
function fixtureOf(org: { id: string; slug: string }): OrgFixture {
  const members = Object.fromEntries(FIXTURE_ROLES.map((role) => {
    const u = seat(org.slug, role);
    const member: FixtureMember = { userId: u.userId, email: u.email, name: `${role} seat`, password: u.password, role, orgId: org.id, orgSlug: org.slug };
    return [role, member];
  })) as Record<OrgRole, FixtureMember>;
  return { org: { ...org, name: org.slug }, members, text: (field, n) => `E2E ${field} ${n}` };
}

/**
 * The first route of ROUTE_ACTIONS for each action it holds on a write method, with member:leave last: a seat
 * that has left answers every later call 404 as a non-member, which would hide the 403 a denied action is owed.
 */
const ONE_WRITE_PER_ACTION: Array<{ action: Action; method: string; file: string }> = [];
for (const [file, methods] of Object.entries(ROUTE_ACTIONS))
  for (const [method, action] of Object.entries(methods))
    if (method !== 'GET' && !ONE_WRITE_PER_ACTION.some((w) => w.action === action)) ONE_WRITE_PER_ACTION.push({ action: action as Action, method, file });
ONE_WRITE_PER_ACTION.sort((x, y) => Number(x.action === 'member:leave') - Number(y.action === 'member:leave'));

/** The URL of `file` for organisation `slug`; `ids` gives each dynamic segment, a fresh UUID otherwise (the pending stubs gate on the slug). */
function urlOf(file: string, slug: string, ids: Record<string, string>): string {
  return file.replace(/^app/, '').replace(/\/route\.ts$/, '').replace(/\[(\w+)\]/g, (_w, name: string) =>
    name === 'slug' ? slug : name === 'questionId' ? 'Q-PP-01' : (ids[name] ?? randomUUID()));
}

/** A body the handler accepts where it reads one (v0.5.0 routes and route 1); the pending stubs refuse or answer 501 before reading theirs. */
function bodyFor(file: string, method: string, role: OrgRole): Record<string, unknown> {
  if (method === 'POST' && file === 'app/api/v1/orgs/[slug]/projects/route.ts') return { name: `AUTHZ e2e ${role} project` };
  if (method === 'POST' && file === 'app/api/v1/orgs/[slug]/members/route.ts')
    return { email: `${INVITE_PREFIX}${role}-${randomUUID().slice(0, 8)}@fixture.test`, role: 'viewer' };
  // Route 1 is implemented and all its ids are real, so its permitted cell must be 2xx: a whole SaveDecisionRequest, a
  // first decision (base null) on a question of the fixture content the server runs, in the role's own new project.
  if (method === 'POST' && file === 'app/api/v1/orgs/[slug]/projects/[id]/decisions/route.ts') {
    return {
      requestId: randomUUID(), stage: 'pre-processing', questionId: 'Q-PP-01', baseVersionNumber: null, status: 'done', scopeAnswer: null,
      optionsInPlace: [], reasonCode: null, reason: `AUTHZ e2e ${role} decision`, decidedBy: { kind: 'outside_role', role: 'other' },
      declaredDate: '2026', evidenceIds: [],
    };
  }
  return {};
}

/** Every dynamic segment of `file` is given a real object of A: the role's project and a member made for the role. */
const realIds = (file: string) => [...file.matchAll(/\[(\w+)\]/g)].every(([, name]) => ['slug', 'id', 'userId'].includes(name));

const newApi = (storageState: string): Promise<APIRequestContext> =>
  request.newContext({ baseURL: test.info().project.use.baseURL, storageState });

/**
 * Per role: a project of A for its project-scoped actions, a second one that its project:delete names (so no
 * later action meets a deleted project once its route is implemented), and a member of A made for it (the target of the
 * member PATCH and DELETE, so a permitted call succeeds on a real member and no shared seat changes); and B's
 * objects for the cross-organisation routes.
 */
const projectFor: Partial<Record<OrgRole, string>> = {};
/** The project each role's project:delete names: never the one its other project-scoped actions use. */
const deleteProjectFor: Partial<Record<OrgRole, string>> = {};
const memberFor: Partial<Record<OrgRole, string>> = {};
let bProject: string;
let bEvidence: string;

test.beforeAll(async () => {
  const fxA = fixtureOf(orgA);
  for (const role of FIXTURE_ROLES) {
    projectFor[role] = (await addProject(fxA, { name: `AUTHZ e2e ${role} ${randomUUID().slice(0, 6)}` })).id;
    deleteProjectFor[role] = (await addProject(fxA, { name: `AUTHZ e2e ${role} to delete ${randomUUID().slice(0, 6)}` })).id;
    const run = randomUUID().slice(0, 8);
    const user = await testDb.user.create({ data: { email: `authz-e2e-target-${role}-${run}@fixture.test`, name: `AUTHZ e2e target ${run}`, passwordHash: 'not-a-login' } });
    await testDb.membership.create({ data: { orgId: orgA.id, userId: user.id, role: 'viewer' } });
    memberFor[role] = user.id;
  }
  const fxB = fixtureOf(orgB);
  bProject = (await addProject(fxB, { name: `AUTHZ e2e B ${randomUUID().slice(0, 6)}` })).id;
  bEvidence = (await addEvidence(fxB, bProject, { kind: 'file' })).id;
});

const INVITE_PREFIX = 'authz-e2e-invite-';

/** Every project this spec makes is named so (`addProject` above, and the projects POST's body). */
const PROJECT_PREFIX = 'AUTHZ e2e ';
/** A project holding none of the records its foreign keys keep (ON DELETE RESTRICT; most are append-only). */
const RECORD_FREE = { evidence: { none: {} }, decisionVersions: { none: {} }, findings: { none: {} }, stageReviews: { none: {} }, issuedDocuments: { none: {} } } as const;

test.afterAll(async () => {
  // Leave organisation A as the setup made it: what this spec added is gone before the disconnect, which runs
  // even when a delete or the check below throws.
  try {
    const targets = Object.values(memberFor).filter((id): id is string => id !== undefined);
    const toDelete = Object.values(deleteProjectFor).filter((id): id is string => id !== undefined);
    await testDb.membership.deleteMany({ where: { userId: { in: targets } } });
    await testDb.user.deleteMany({ where: { id: { in: targets } } });
    await testDb.invitation.deleteMany({ where: { email: { startsWith: INVITE_PREFIX } } });
    // The delete targets a refused role left: by id, so one that somehow holds a record fails here, loudly.
    await testDb.project.deleteMany({ where: { id: { in: toDelete } } });
    // Then every record-free project of this spec, this run's or an earlier one's; a project holding a record stays.
    await testDb.project.deleteMany({ where: { name: { startsWith: PROJECT_PREFIX }, ...RECORD_FREE } });
    expect({
      memberships: await testDb.membership.count({ where: { userId: { in: targets } } }),
      users: await testDb.user.count({ where: { id: { in: targets } } }),
      invitations: await testDb.invitation.count({ where: { email: { startsWith: INVITE_PREFIX } } }),
      projectsToDelete: await testDb.project.count({ where: { id: { in: toDelete } } }),
      recordFreeProjects: await testDb.project.count({ where: { name: { startsWith: PROJECT_PREFIX }, ...RECORD_FREE } }),
    }).toEqual({ memberships: 0, users: 0, invitations: 0, projectsToDelete: 0, recordFreeProjects: 0 });
  } finally {
    await testDb.$disconnect();
  }
});

for (const role of FIXTURE_ROLES)
  test(`FR-AUTHZ-01 NFR-SEC-03: ${role} gets the matrix answer for one write per action`, async () => {
    const me = seat(orgA.slug, role);
    const api = await newApi(me.storageStatePath);
    const outcomes: Array<{ action: Action; file: string; status: number; code: unknown }> = [];
    try {
      for (const { action, method, file } of ONE_WRITE_PER_ACTION) {
        const project = action === 'project:delete' ? deleteProjectFor[role]! : projectFor[role]!;
        const ids = { id: project, userId: memberFor[role]! };
        const res = await api.fetch(urlOf(file, orgA.slug, ids), { method, data: bodyFor(file, method, role) });
        const text = await res.text();
        outcomes.push({ action, file, status: res.status(), code: text.startsWith('{') ? JSON.parse(text).code : null });
      }
    } finally {
      await api.dispose();
      // member:leave is every role's: put the seat back so later specs find it as it was.
      const kept = await testDb.membership.findUnique({ where: { orgId_userId: { orgId: orgA.id, userId: me.userId } } });
      if (!kept) await testDb.membership.create({ data: { orgId: orgA.id, userId: me.userId, role } });
    }
    expect(outcomes.length).toBe(ONE_WRITE_PER_ACTION.length);
    // A refused cell is the role gate's refusal: 403 forbidden (not cross_origin, must_change_password or the
    // like). A permitted cell on a pending stub answers 501 not_implemented and nothing else (contract rule 5: the
    // stub's gate, then NotImplementedError); on an implemented route it is never 401, 403 or a 5xx, and where its
    // ids are all real objects it succeeds (2xx).
    const verdict = ({ action, file, status, code }: (typeof outcomes)[number]) => {
      if (!can(role, action)) return status === 403 && code === 'forbidden';
      if (status === 401 || status === 403) return false;
      if (PENDING_ROUTES.includes(file)) return status === 501 && code === 'not_implemented';
      return realIds(file) ? status >= 200 && status < 300 : status < 500;
    };
    expect(outcomes.map((o) => ({ ...o, role, ok: verdict(o) }))).toEqual(outcomes.map((o) => ({ ...o, role, ok: true })));
  });

test('NFR-SEC-02: five routes answer 404 for an object of the other organisation', async () => {
  const api = await newApi(seat(orgA.slug, 'owner').storageStatePath);
  const FIVE_CROSS_ORG = [
    { method: 'GET', path: `/api/v1/orgs/${orgA.slug}/projects/${bProject}` },
    { method: 'PATCH', path: `/api/v1/orgs/${orgA.slug}/projects/${bProject}` },
    { method: 'DELETE', path: `/api/v1/orgs/${orgA.slug}/projects/${bProject}` },
    { method: 'PATCH', path: `/api/v1/orgs/${orgA.slug}/members/${seat(orgB.slug, 'viewer').userId}` },
    { method: 'GET', path: `/api/v1/orgs/${orgA.slug}/evidence/${bEvidence}` },
  ];
  try {
    for (const { method, path } of FIVE_CROSS_ORG) {
      const res = await api.fetch(path, method === 'GET' ? { method } : { method, data: {} });
      expect({ method, path, status: res.status(), code: (await res.json()).code }).toEqual({ method, path, status: 404, code: 'not_found' });
    }
  } finally {
    await api.dispose();
  }
  expect(await testDb.project.count({ where: { id: bProject } })).toBe(1);   // B's project is still there
  expect((await testDb.membership.findUnique({ where: { orgId_userId: { orgId: orgB.id, userId: seat(orgB.slug, 'viewer').userId } } }))?.role).toBe('viewer');
});
