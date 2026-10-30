import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PENDING_ROUTES, ROUTE_ACTIONS, UNKEYED_WRITES } from '../../lib/authz/routeActions';
import { can, type Action } from '../../lib/authz/policy';
import { ALL_ORG_ROLES } from '../../lib/authz/roles';
import { APPEND_ONLY_TABLES } from '../../lib/data/appendOnly';
import { resetDb, testDb } from '../helpers/db';
import { buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { callRoute, sessionAs, idsOf, rowCounts, validRequestFor, type Method } from '../helpers/routeDriver';

/**
 * NFR-SEC-03 and FR-AUTHZ-01 over the HTTP API: for every method of every ROUTE_ACTIONS entry and every role,
 * the real handler answers as `can(role, action)` says, on organisation A's own objects. A denied call answers
 * 403 `forbidden` and changes nothing; a permitted one succeeds or meets a business refusal: a status under 400,
 * 409, 422, or a pending stub's 501, and nothing else (a 5xx, 401, 403 or 404 fails the case). Generated from ROUTE_ACTIONS, so a route a producer adds or changes is held here at once.
 *
 * Each call sends the request its route's type accepts (validRequestFor), so a denied write that ran before
 * its gate would have written something. "Changes nothing" is checked twice: the row counts, and a digest of
 * every row of every table that is not append-only (an UPDATE changes no count).
 */

/** md5 of every row of every public table that may be updated: projects, memberships, users and the rest. */
async function mutableDigest(): Promise<Record<string, string>> {
  const tables = (await testDb.$queryRaw<{ t: string }[]>`SELECT tablename::text AS t FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'framework_versions') ORDER BY 1`)
    .map((r) => r.t).filter((t) => !APPEND_ONLY_TABLES.includes(t));
  const sql = `SELECT ${tables.map((t) => `(SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x::text), '')) FROM "${t}" x) AS "${t}"`).join(', ')}`;
  return (await testDb.$queryRawUnsafe<Record<string, string>[]>(sql))[0];
}

/**
 * The one permitted call known to throw rather than answer: the v0.5.0 DELETE of a project that holds records
 * fails on the foreign key of a record table (evidence, decisions and the rest; Prisma P2003), which Next serves
 * as a 500 (`app/api/v1/orgs/[slug]/projects/[id]/route.ts:140`).
 * PRJ answers it 409 `project_has_records` (00-contract.md, Routes, row 24) in the commit that keys the method,
 * so this ends by itself when the method leaves UNKEYED_WRITES. Any other throw fails the case.
 */
const PROJECT = 'app/api/v1/orgs/[slug]/projects/[id]/route.ts';
function knownCrash(file: string, method: string, e: unknown): boolean {
  return file === PROJECT && method === 'DELETE' && (UNKEYED_WRITES[PROJECT]?.methods ?? []).includes('DELETE')
    && (e as { code?: unknown } | null)?.code === 'P2003';
}

let fx: OrgFixture;

beforeAll(async () => {
  await resetDb();
});

// A permitted write may remove the viewer, the project or the caller's own membership, so every case gets an
// organisation of its own.
beforeEach(async () => {
  fx = await buildOrg({ label: 'matrix' });
});

describe('the permission matrix over the HTTP API (FR-AUTHZ-01, NFR-SEC-03)', () => {
  it('NFR-SEC-03: the generated cases cover every method of ROUTE_ACTIONS for every role', () => {
    const cells = Object.values(ROUTE_ACTIONS).flatMap((m) => Object.keys(m)).length * ALL_ORG_ROLES.length;
    expect(cells).toBeGreaterThan(100);
  });

  for (const [file, methods] of Object.entries(ROUTE_ACTIONS)) for (const [method, action] of Object.entries(methods))
    for (const role of ALL_ORG_ROLES)
      it(`NFR-SEC-03 FR-AUTHZ-01: ${method} ${file} as ${role} follows the matrix`, async () => {
        sessionAs(fx.members[role].userId);
        const ids = await idsOf(fx, file);
        const [counts, digest] = [await rowCounts(), await mutableDigest()];
        const call = callRoute(file, method as Method, { slug: fx.org.slug, params: ids, ...validRequestFor(file, method as Method, ids) });
        if (can(role, action as Action)) {
          const res = await call.catch((e: unknown) => { if (knownCrash(file, method, e)) return null; throw e; });
          if (res) {
            const allowed = res.status < 400 || [409, 422].includes(res.status) || (res.status === 501 && PENDING_ROUTES.includes(file));
            expect({ role, action, status: res.status, allowed }).toEqual({ role, action, status: res.status, allowed: true });
          }
        } else {
          const res = await call;
          expect({ status: res.status, code: (await res.json()).code }).toEqual({ status: 403, code: 'forbidden' });
          expect(await rowCounts()).toEqual(counts);
          expect(await mutableDigest()).toEqual(digest);
        }
      });
});
