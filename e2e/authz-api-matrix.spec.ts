import 'dotenv/config';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test, expect, request, type APIRequestContext } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { can, type Action } from '../lib/authz/policy';
import { ROUTE_ACTIONS } from '../lib/authz/routeActions';
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
 * made for it, the member PATCH and DELETE name an account that belongs to no organisation, and a seat that
 * leaves A is put back. The objects are written with the record fixture builder into the database the server
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

const newApi = (storageState: string): Promise<APIRequestContext> =>
  request.newContext({ baseURL: test.info().project.use.baseURL, storageState });

/** A project of A per role (the one that role may delete), and B's objects for the cross-organisation routes. */
const projectFor: Partial<Record<OrgRole, string>> = {};
let bProject: string;
let bEvidence: string;

test.beforeAll(async () => {
  const fxA = fixtureOf(orgA);
  for (const role of FIXTURE_ROLES) projectFor[role] = (await addProject(fxA, { name: `AUTHZ e2e ${role} ${randomUUID().slice(0, 6)}` })).id;
  const fxB = fixtureOf(orgB);
  bProject = (await addProject(fxB, { name: `AUTHZ e2e B ${randomUUID().slice(0, 6)}` })).id;
  bEvidence = (await addEvidence(fxB, bProject, { kind: 'file' })).id;
});

test.afterAll(async () => {
  await testDb.$disconnect();
});

for (const role of FIXTURE_ROLES)
  test(`FR-AUTHZ-01 NFR-SEC-03: ${role} gets the matrix answer for one write per action`, async () => {
    const me = seat(orgA.slug, role);
    const api = await newApi(me.storageStatePath);
    const outcomes: Array<{ action: Action; status: number }> = [];
    try {
      for (const { action, method, file } of ONE_WRITE_PER_ACTION) {
        // userId: an account of no organisation, so a permitted PATCH or DELETE changes no seat (it answers 404).
        const ids = { id: projectFor[role]!, userId: randomUUID() };
        const res = await api.fetch(urlOf(file, orgA.slug, ids), { method, data: {} });
        outcomes.push({ action, status: res.status() });
      }
    } finally {
      await api.dispose();
      // member:leave is every role's: put the seat back so later specs find it as it was.
      const kept = await testDb.membership.findUnique({ where: { orgId_userId: { orgId: orgA.id, userId: me.userId } } });
      if (!kept) await testDb.membership.create({ data: { orgId: orgA.id, userId: me.userId, role } });
    }
    expect(outcomes.length).toBe(ONE_WRITE_PER_ACTION.length);
    expect(outcomes.map(({ action, status }) => ({ action, role, refused: status === 403 })))
      .toEqual(outcomes.map(({ action }) => ({ action, role, refused: !can(role, action) })));
    for (const { action, status } of outcomes) expect({ action, status, unauthenticated: status === 401 }).toEqual({ action, status, unauthenticated: false });
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
