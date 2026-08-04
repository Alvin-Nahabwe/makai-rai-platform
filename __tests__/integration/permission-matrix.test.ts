import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { OrgRole } from '@prisma/client';
import { testDb, resetDb } from '../helpers/db';
import { buildTwoOrgFixture, FIXTURE_ROLES, type FixtureUser, type FixtureOrg } from '../helpers/fixture';
import { can, type Action } from '../../lib/authz/policy';
import { ROUTE_ACTIONS } from '../../lib/authz/routeActions';
import { createInvitation } from '../../lib/data/members';
import { createUserFromInvitation, acceptInvitation } from '../../lib/data/preauth';
import type { OrgContext } from '../../lib/data/tenant';

/**
 * Task 11 — O-11 (every role x route cell, both orgs) and O-12 (the
 * creator-vs-role control).
 *
 * WHAT THIS SUITE PROVES THAT NEITHER EXISTING SUITE DOES: `__tests__/authz/
 * policy.test.ts` proves `can(role, action)` is correct as a PURE function —
 * it never touches a route, a session, or the database. The IDOR matrix
 * (Task 6/7) proves cross-org isolation against three PERSONAS (other-org
 * member, non-member, unauthenticated) — not against each of the five
 * ROLES. Neither can catch a handler that consults a DIFFERENT action than
 * the one `ROUTE_ACTIONS` declares for it, or the same action for the wrong
 * caller check — `can()` would still report correctly for the action it was
 * asked about, and the IDOR matrix's three personas do not vary role. This
 * suite drives the REAL exported route handlers (imported from `app/api/**`,
 * not re-implemented) with a REAL NextAuth session mocked at the one seam
 * (`lib/auth.ts`'s `auth()`) and asserts the HTTP status the declared
 * ROUTE_ACTIONS map predicts. See the non-vacuity proof in the Task 11
 * report for confirmation this actually catches the defect it exists to
 * catch.
 *
 * SESSION MOCKING: `requireIdentityForApi` (lib/auth/identity.ts) dynamically
 * imports `../auth` (== `lib/auth.ts`) and calls its `auth()` export. Mocking
 * that module is the ONLY seam available without a real browser/cookie jar —
 * every route handler below is otherwise driven completely for real (real
 * Prisma, real RLS, real `requireOrgContext`, real `can()`).
 */

let currentSession: { user: { id: string }; sessionEpoch: number; sessionIssuedAt: number } | null = null;

vi.mock('../../lib/auth', () => ({
  auth: () => Promise.resolve(currentSession),
}));

function sessionFor(userId: string): void {
  currentSession = { user: { id: userId }, sessionEpoch: 0, sessionIssuedAt: Math.floor(Date.now() / 1000) };
}

// ---------------------------------------------------------------------------
// Generic route driver — imports the REAL route module and calls its REAL
// exported handler. No route logic is reimplemented here.
// ---------------------------------------------------------------------------

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type RouteModule = Record<string, (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>>;

// Route modules are imported by ~726 cells but there are only 18 distinct
// files — memoized so each is dynamically imported exactly once instead of
// re-hitting Node's module-cache lookup on every cell.
const routeModuleCache = new Map<string, Promise<RouteModule>>();

function loadRouteModule(file: string): Promise<RouteModule> {
  let cached = routeModuleCache.get(file);
  if (!cached) {
    const specifier = `../../${file.replace(/\.ts$/, '')}`;
    cached = import(/* @vite-ignore */ specifier) as Promise<RouteModule>;
    routeModuleCache.set(file, cached);
  }
  return cached;
}

// Typed off the constructor itself rather than the DOM `RequestInit` lib
// type — Next's own `NextRequestInit` narrows `signal` to
// `AbortSignal | undefined` (no `null`), which the DOM type allows and
// `tsc --noEmit` correctly rejects when the two are conflated.
type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

async function callRoute(
  file: string,
  method: Method,
  opts: { slug: string; id?: string; userId?: string; body?: unknown },
): Promise<Response> {
  const mod = await loadRouteModule(file);
  const handler = mod[method];
  if (typeof handler !== 'function') {
    throw new Error(`permission-matrix: ${file} has no exported ${method} handler`);
  }
  const params: Record<string, string> = { slug: opts.slug };
  if (opts.id !== undefined) params.id = opts.id;
  if (opts.userId !== undefined) params.userId = opts.userId;

  const init: NextRequestInit = { method };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'content-type': 'application/json' };
  }
  const req = new NextRequest('http://localhost/probe', init);
  return handler(req, { params: Promise.resolve(params) });
}

// ---------------------------------------------------------------------------
// Disposable-resource helpers. Several cells are DESTRUCTIVE (DELETE a
// project, DELETE/leave a membership) and cannot share state with other
// cells that also expect success on the same resource — a second successful
// DELETE on an already-deleted row is a 404, not the 200 every permitted
// caller is owed. Every disposable member is minted through the SAME
// real invite-and-accept path `buildTwoOrgFixture` itself uses (brief
// constraint 3: never insert a Membership row directly).
// ---------------------------------------------------------------------------

function ownerCtx(orgId: string): OrgContext {
  return { orgId, role: 'owner' } as OrgContext;
}

let disposableCounter = 0;

async function makeDisposableMember(
  org: FixtureOrg,
  inviterId: string,
  role: OrgRole,
): Promise<{ userId: string }> {
  disposableCounter += 1;
  // `disposableCounter` alone is a sufficient uniqueness key within one run
  // of this file (it only ever increases, and `resetDb()` at the top of the
  // suite guarantees no `Invitation`/`User` row from a previous run survives
  // to collide with it) — no timestamp suffix needed on top of it.
  const email = `matrix-disposable-${role}-${disposableCounter}@fixture.test`;
  const invitation = await createInvitation({ ctx: ownerCtx(org.id), email, role, invitedById: inviterId });
  const created = await createUserFromInvitation({
    email,
    name: `Matrix disposable ${role} ${disposableCounter}`,
    passwordHash: 'x',
    researchConsent: false,
    ipAddress: 'permission-matrix-test',
  });
  await acceptInvitation({ rawToken: invitation.rawToken, userId: created.userId, userEmail: email });
  return { userId: created.userId };
}

// ---------------------------------------------------------------------------
// O-11 setup: one shared, reusable set of resources per target org, built
// through direct Prisma writes (the established convention for test FIXTURE
// DATA in this suite — see isolation.test.ts's `seed()` and assessments.
// test.ts's `seedAssessment()` — as opposed to buildTwoOrgFixture's 20 real
// USERS, which brief constraint 3 requires stay on the real invite path).
// ---------------------------------------------------------------------------

type OrgResources = {
  ownerUserId: string;
  projectId: string;
  respondAssessmentId: string;
  completeAssessmentId: string;
  remediationItemId: string;
  bufferMemberUserId: string;
};

async function buildOrgResources(org: FixtureOrg, ownerUserId: string): Promise<OrgResources> {
  const project = await testDb.project.create({
    data: { orgId: org.id, name: `Matrix probe project (${org.slug})`, createdById: ownerUserId },
  });

  // The two assessments and the disposable buffer member depend only on
  // `project`/`org`/`ownerUserId` above, not on each other — run them
  // concurrently rather than as three sequential round trips.
  const [respondAssessment, completeAssessment, buffer] = await Promise.all([
    // Stays in_progress for the whole run — used by GET and PATCH-respond
    // cells, neither of which ever completes it.
    testDb.assessment.create({
      data: {
        orgId: org.id,
        projectId: project.id,
        userId: ownerUserId,
        mode: 'quick',
        engineState: { mode: 'quick', quick: { responses: { q1: 3 } } },
      },
    }),
    // A SEPARATE assessment, dedicated to the `complete` route's cells.
    // `completeAssessment` is idempotent on an already-completed row
    // (`already_completed` -> 200), so the first successful caller among the
    // 20 completes it for real and every later successful caller reuses that
    // same 200 outcome — which is also what lets the PDF route (processed
    // later in ROUTE_ACTIONS' own key order) find real `reportData` instead
    // of hitting the inline-generate fallback.
    testDb.assessment.create({
      data: {
        orgId: org.id,
        projectId: project.id,
        userId: ownerUserId,
        mode: 'quick',
        engineState: { mode: 'quick', quick: { responses: { q1: 4, q2: 2 } } },
      },
    }),
    // A disposable low-privilege member. Reused, never deleted, for two
    // purposes: (a) the target of every `member:grant_owner` cell (idempotent
    // — repeated grants are a no-op success), and (b) once granted owner by
    // the first successful grant-owner caller, it becomes a THIRD owner in
    // the org, which is what lets BOTH real owner fixture users succeed at
    // `member:leave` later without either hitting the last-owner guard (a
    // real business invariant, unrelated to the authorization wiring this
    // suite tests). `members/[userId]` (grant_owner, then DELETE) is
    // processed before `members/leave` in ROUTE_ACTIONS' own key order, so
    // this ordering is guaranteed, not assumed.
    makeDisposableMember(org, ownerUserId, 'viewer'),
  ]);

  // Depends on `respondAssessment.id` — cannot join the batch above.
  const remediationItem = await testDb.remediationItem.create({
    data: {
      orgId: org.id,
      assessmentId: respondAssessment.id,
      areaId: 'PO-03',
      areaName: 'Accountability',
      tier: 'gap',
      description: 'Matrix probe remediation item',
    },
  });

  return {
    ownerUserId,
    projectId: project.id,
    respondAssessmentId: respondAssessment.id,
    completeAssessmentId: completeAssessment.id,
    remediationItemId: remediationItem.id,
    bufferMemberUserId: buffer.userId,
  };
}

// ---------------------------------------------------------------------------
// The success status per (file, method) — every ROUTE_ACTIONS entry has one.
// Mechanically checked below against ROUTE_ACTIONS itself, so a new route
// method with no entry here fails loudly rather than being silently skipped
// (brief constraint 2).
// ---------------------------------------------------------------------------

const SUCCESS_STATUS: Record<string, number> = {
  'app/api/v1/orgs/[slug]/projects/route.ts::GET': 200,
  'app/api/v1/orgs/[slug]/projects/route.ts::POST': 201,
  'app/api/v1/orgs/[slug]/projects/[id]/route.ts::GET': 200,
  'app/api/v1/orgs/[slug]/projects/[id]/route.ts::PATCH': 200,
  'app/api/v1/orgs/[slug]/projects/[id]/route.ts::DELETE': 200,
  'app/api/v1/orgs/[slug]/assessments/route.ts::GET': 200,
  'app/api/v1/orgs/[slug]/assessments/route.ts::POST': 201,
  'app/api/v1/orgs/[slug]/assessments/[id]/route.ts::GET': 200,
  'app/api/v1/orgs/[slug]/assessments/[id]/route.ts::PATCH': 200,
  'app/api/v1/orgs/[slug]/assessments/[id]/complete/route.ts::POST': 200,
  'app/api/v1/orgs/[slug]/assessments/[id]/remediation/route.ts::GET': 200,
  'app/api/v1/orgs/[slug]/assessments/[id]/remediation/route.ts::PATCH': 200,
  'app/api/v1/orgs/[slug]/reports/[id]/pdf/route.ts::GET': 200,
  'app/api/v1/orgs/[slug]/members/route.ts::GET': 200,
  'app/api/v1/orgs/[slug]/members/route.ts::POST': 201,
  'app/api/v1/orgs/[slug]/members/[userId]/route.ts::PATCH': 200,
  'app/api/v1/orgs/[slug]/members/[userId]/route.ts::DELETE': 200,
  'app/api/v1/orgs/[slug]/members/leave/route.ts::POST': 200,
};

it('SUCCESS_STATUS declares exactly one entry per ROUTE_ACTIONS method (no route silently unexercised)', () => {
  const expectedKeys = new Set<string>();
  for (const [file, methods] of Object.entries(ROUTE_ACTIONS)) {
    for (const method of Object.keys(methods)) expectedKeys.add(`${file}::${method}`);
  }
  expect(new Set(Object.keys(SUCCESS_STATUS))).toEqual(expectedKeys);
});

// ---------------------------------------------------------------------------
// Per-route request construction. Keyed by the SAME file strings iterated
// out of ROUTE_ACTIONS below — this is domain plumbing (what body/id a given
// route needs), not the (role x route) expectation table, which is
// generated, never hand-written (brief constraint 1). Any ROUTE_ACTIONS file
// with no case here throws instead of silently producing an unbuilt request
// (constraint 2).
// ---------------------------------------------------------------------------

async function buildRequestExtras(
  file: string,
  method: string,
  args: { user: FixtureUser; targetOrg: FixtureOrg; res: OrgResources; expected: number; successStatus: number },
): Promise<{ id?: string; userId?: string; body?: unknown }> {
  const { targetOrg, res, expected, successStatus, user } = args;
  // Shared by both DELETE routes below: a destructive call expected to
  // actually succeed must never touch a resource other cells still depend
  // on — a call that is expected to fail (403/404) never reaches the
  // destructive code path at all, so reusing shared state for it is safe.
  const isDestructiveSuccess = method === 'DELETE' && expected === successStatus;

  switch (file) {
    case 'app/api/v1/orgs/[slug]/projects/route.ts':
      return method === 'POST' ? { body: { name: 'Matrix probe project (created)' } } : {};

    case 'app/api/v1/orgs/[slug]/projects/[id]/route.ts': {
      if (isDestructiveSuccess) {
        // Destructive and expected to succeed here: never reuse the shared
        // project other cells still depend on.
        const fresh = await testDb.project.create({
          data: { orgId: targetOrg.id, name: 'Matrix probe disposable project', createdById: res.ownerUserId },
        });
        return { id: fresh.id };
      }
      return {
        id: res.projectId,
        ...(method === 'PATCH' ? { body: { name: 'Matrix probe project (updated)' } } : {}),
      };
    }

    case 'app/api/v1/orgs/[slug]/assessments/route.ts':
      return method === 'POST' ? { body: { projectId: res.projectId, mode: 'quick' } } : {};

    case 'app/api/v1/orgs/[slug]/assessments/[id]/route.ts':
      return {
        id: res.respondAssessmentId,
        ...(method === 'PATCH'
          ? { body: { engineState: { mode: 'quick', quick: { responses: { q1: 3 } } } } }
          : {}),
      };

    case 'app/api/v1/orgs/[slug]/assessments/[id]/complete/route.ts':
      return { id: res.completeAssessmentId };

    case 'app/api/v1/orgs/[slug]/assessments/[id]/remediation/route.ts':
      return {
        id: res.respondAssessmentId,
        ...(method === 'PATCH' ? { body: { itemId: res.remediationItemId, completed: true } } : {}),
      };

    case 'app/api/v1/orgs/[slug]/reports/[id]/pdf/route.ts':
      return { id: res.completeAssessmentId };

    case 'app/api/v1/orgs/[slug]/members/route.ts':
      return method === 'POST'
        ? { body: { email: `matrix-invite-${targetOrg.slug}-${user.userId}@fixture.test`, role: 'viewer' } }
        : {};

    case 'app/api/v1/orgs/[slug]/members/[userId]/route.ts': {
      if (isDestructiveSuccess) {
        const fresh = await makeDisposableMember(targetOrg, res.ownerUserId, 'viewer');
        return { userId: fresh.userId };
      }
      // PATCH (grant_owner) is idempotent, and DELETE cells that are NOT
      // expected to succeed never reach `removeMember` at all (the
      // permission/cross-org check throws first) — safe to reuse the
      // buffer member as the target in both cases.
      return { userId: res.bufferMemberUserId };
    }

    case 'app/api/v1/orgs/[slug]/members/leave/route.ts':
      return {}; // self-service; no body, no id

    default:
      throw new Error(
        `permission-matrix: no request-builder for route ${file} — every ROUTE_ACTIONS entry ` +
          `must be exercised (brief constraint 2); add a case here.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('permission matrix (O-11 exhaustive role x route, O-12 creator-vs-role)', async () => {
  await resetDb();
  const fixture = await buildTwoOrgFixture();

  const ownerOf = (org: FixtureOrg): FixtureUser => {
    const owner = fixture.users.find((u) => u.orgSlug === org.slug && u.role === 'owner' && u.index === 0);
    if (!owner) throw new Error(`no bootstrap owner found for org ${org.slug}`);
    return owner;
  };

  // ---- O-12 — the creator-vs-role control -------------------------------
  //
  // Member 1 of a role creates a project; member 2 of the SAME role then
  // acts on it. If ownership residue survived the port (`assessment.userId
  // !== user.id`, the premise `lib/authz.ts` — deleted by ADR-0001 — used to
  // gate on), member 2 is wrongly denied where member 1 succeeded and this
  // goes red. The fixture carries two members per role for exactly this.
  describe('O-12', () => {
    const orgA = fixture.orgs[0];

    for (const role of FIXTURE_ROLES) {
      it(`member 2 of role '${role}' gets the same PATCH-project answer as member 1 on member 1's own project`, async () => {
        const [m1, m2] = fixture.users.filter((u) => u.role === role && u.orgSlug === orgA.slug);
        expect(m1, `fixture must carry two ${role} members in ${orgA.slug}`).toBeDefined();
        expect(m2, `fixture must carry two ${role} members in ${orgA.slug}`).toBeDefined();

        // Member 1 "creates" the project. Roles that hold `project:create`
        // do so through the REAL route (best fidelity). Roles that do not
        // (reviewer, viewer) cannot legitimately reach that route at all —
        // that is a real, already-covered-by-O-11 fact, not what O-12 is
        // testing — so for them the row is inserted directly with
        // `createdById: m1.userId`, matching what a permitted creator's row
        // would look like, purely as SETUP for the ownership-residue probe
        // below.
        let projectId: string;
        if (can(role, 'project:create')) {
          sessionFor(m1.userId);
          const created = await callRoute('app/api/v1/orgs/[slug]/projects/route.ts', 'POST', {
            slug: orgA.slug,
            body: { name: `O-12 ${role} project` },
          });
          expect(created.status).toBe(201);
          const json = (await created.json()) as { id: string };
          projectId = json.id;
        } else {
          const project = await testDb.project.create({
            data: { orgId: orgA.id, name: `O-12 ${role} project`, createdById: m1.userId },
          });
          projectId = project.id;
        }

        sessionFor(m2.userId);
        const response = await callRoute('app/api/v1/orgs/[slug]/projects/[id]/route.ts', 'PATCH', {
          slug: orgA.slug,
          id: projectId,
          body: { name: `O-12 ${role} project (patched by member 2)` },
        });

        const expected = can(role, 'project:update') ? 200 : 403;
        expect(response.status).toBe(expected);
      });
    }
  });

  // ---- O-11 — exhaustive (role x route) cells, both orgs -----------------
  const resourcesByOrg = new Map<string, OrgResources>();
  for (const org of fixture.orgs) {
    resourcesByOrg.set(org.slug, await buildOrgResources(org, ownerOf(org).userId));
  }

  describe('O-11', () => {
    for (const targetOrg of fixture.orgs) {
      const res = resourcesByOrg.get(targetOrg.slug);
      if (!res) throw new Error(`no resources built for ${targetOrg.slug}`);

      describe(`target org ${targetOrg.slug}`, () => {
        for (const [file, methods] of Object.entries(ROUTE_ACTIONS)) {
          for (const [method, action] of Object.entries(methods) as [Method, Action][]) {
            for (const user of fixture.users) {
              const sameOrg = user.orgSlug === targetOrg.slug;
              const successStatus = SUCCESS_STATUS[`${file}::${method}`];
              if (successStatus === undefined) {
                throw new Error(`permission-matrix: no SUCCESS_STATUS for ${file}::${method}`);
              }
              const expected = !sameOrg ? 404 : can(user.role, action) ? successStatus : 403;

              it(
                `${method} ${file} as ${user.role}#${user.index} (member of ${user.orgSlug}) ` +
                  `-> target ${targetOrg.slug} expect ${expected}`,
                async () => {
                  sessionFor(user.userId);
                  const extras = await buildRequestExtras(file, method, { user, targetOrg, res, expected, successStatus });
                  const response = await callRoute(file, method, { slug: targetOrg.slug, ...extras });
                  expect(response.status).toBe(expected);
                },
              );
            }
          }
        }
      });
    }
  });
});
