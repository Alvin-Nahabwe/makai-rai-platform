import { beforeAll, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { PENDING_ROUTES, ROUTE_ACTIONS } from '../../lib/authz/routeActions';
import { can, type Action } from '../../lib/authz/policy';
import { ALL_ORG_ROLES } from '../../lib/authz/roles';
import { APPEND_ONLY_TABLES } from '../../lib/data/appendOnly';
import { resetDb, testDb } from '../helpers/db';
import { buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { callRoute, sessionAs, idsOf, rowCounts, validRequestFor, type Method } from '../helpers/routeDriver';

/**
 * NFR-SEC-02 (SRS lines 2907-2911): every object named in a request is resolved inside the caller's
 * organisation, so a member of A naming an object of B gets 404 `not_found` and nothing changes, on every
 * route of ROUTE_ACTIONS that takes an object id. Generated from ROUTE_ACTIONS, so a route a producer adds is
 * held here when it leaves PENDING_ROUTES; an id segment with no cross-organisation object fails the first
 * case, so a new segment cannot be skipped.
 *
 * The object case sends the request the route's type accepts (validRequestFor), with B's ids, so it passes
 * the route's parser and reaches the service's withOrg lookup whose 404 it proves (finding SEC-02). It skips
 * PENDING_ROUTES only: a stub's 501 would pass a 404 check vacuously. The 401 and non-member 404 cases run on
 * every route. "Changes nothing" is the row counts and a digest of every row of every table that is not
 * append-only, since a write that renamed B's project would change no count.
 */

const ID_SEGMENTS = ['id', 'questionId', 'findingId', 'mitigationId', 'reviewId', 'sealId', 'documentId', 'evidenceId', 'invitationId', 'userId'];
const segmentsOf = (f: string) => [...f.matchAll(/\[(\w+)\]/g)].map((m) => m[1]).filter((s) => s !== 'slug');
const ROUTES_WITH_IDS = Object.keys(ROUTE_ACTIONS).filter((f) => segmentsOf(f).length > 0);
const ROLE_ORDER: OrgRole[] = ['owner', 'admin', 'assessor', 'reviewer', 'viewer'];
const roleWith = (action: Action): OrgRole => {
  const role = ROLE_ORDER.find((r) => can(r, action));
  if (!role) throw new Error(`no role may ${action}`);
  return role;
};

/** md5 of every row of every public table that may be updated: projects, memberships, users and the rest. */
async function mutableDigest(): Promise<Record<string, string>> {
  const tables = (await testDb.$queryRaw<{ t: string }[]>`SELECT tablename::text AS t FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'framework_versions') ORDER BY 1`)
    .map((r) => r.t).filter((t) => !APPEND_ONLY_TABLES.includes(t));
  const sql = `SELECT ${tables.map((t) => `(SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x::text), '')) FROM "${t}" x) AS "${t}"`).join(', ')}`;
  return (await testDb.$queryRawUnsafe<Record<string, string>[]>(sql))[0];
}

let a: OrgFixture;
let b: OrgFixture;

beforeAll(async () => {
  await resetDb();
  a = await buildOrg({ label: 'xorg-a' });
  b = await buildOrg({ label: 'xorg-b' });
  // Build both fixtures' objects now, so no case's counts include them, whichever cases run.
  for (const fx of [a, b]) await idsOf(fx, 'app/api/v1/orgs/[slug]/projects/[id]/route.ts');
});

describe('objects of another organisation answer 404 (NFR-SEC-02)', () => {
  it('NFR-SEC-02: every id segment of ROUTE_ACTIONS has a cross-organisation object', async () => {
    const segs = new Set(Object.keys(ROUTE_ACTIONS).flatMap(segmentsOf));
    expect([...segs].filter((s) => !ID_SEGMENTS.includes(s))).toEqual([]);   // a new segment name must be mapped here first
    for (const f of ROUTES_WITH_IDS) {
      const [ofA, ofB] = [await idsOf(a, f), await idsOf(b, f)];
      for (const s of segmentsOf(f).filter((x) => x !== 'questionId'))   // a question id is a content id, the same in both
        expect({ f, s, differs: ofA[s] !== ofB[s] }).toEqual({ f, s, differs: true });
    }
    expect(ROUTES_WITH_IDS.filter((f) => !PENDING_ROUTES.includes(f)).length).toBeGreaterThan(0);
  });

  for (const file of ROUTES_WITH_IDS.filter((f) => !PENDING_ROUTES.includes(f)))
    for (const [method, action] of Object.entries(ROUTE_ACTIONS[file]))
      it(`NFR-SEC-02: ${method} ${file}: an object of another organisation answers 404 and changes nothing`, async () => {
        sessionAs(a.members[roleWith(action as Action)].userId);
        const ids = await idsOf(b, file);   // before the counts: the first idsOf of a fixture builds its objects
        const [counts, digest] = [await rowCounts(), await mutableDigest()];
        const res = await callRoute(file, method as Method, { slug: a.org.slug, params: ids, ...validRequestFor(file, method as Method, ids) });
        expect({ status: res.status, code: (await res.json()).code }).toEqual({ status: 404, code: 'not_found' });
        expect(await rowCounts()).toEqual(counts);
        expect(await mutableDigest()).toEqual(digest);
      });

  for (const file of Object.keys(ROUTE_ACTIONS)) for (const method of Object.keys(ROUTE_ACTIONS[file]))
    it(`NFR-SEC-02: ${method} ${file}: no session 401, a member of B naming A's slug 404`, async () => {
      const params = await idsOf(a, file);
      sessionAs(null);
      expect((await callRoute(file, method as Method, { slug: a.org.slug, params })).status).toBe(401);
      for (const role of ALL_ORG_ROLES) {
        sessionAs(b.members[role].userId);
        expect({ role, status: (await callRoute(file, method as Method, { slug: a.org.slug, params })).status }).toEqual({ role, status: 404 });
      }
    });
});
