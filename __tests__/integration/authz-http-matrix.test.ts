import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PENDING_ROUTES, ROUTE_ACTIONS } from '../../lib/authz/routeActions';
import { can, type Action } from '../../lib/authz/policy';
import { ALL_ORG_ROLES } from '../../lib/authz/roles';
import { resetDb } from '../helpers/db';
import { mutableDigest } from '../helpers/digest';
import { answerOrKnownCrash } from '../helpers/authzCases';
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
        const call = () => callRoute(file, method as Method, { slug: fx.org.slug, params: ids, ...validRequestFor(file, method as Method, ids) });
        if (can(role, action as Action)) {
          const res = await answerOrKnownCrash(file, method, call);
          if (res) {
            const allowed = res.status < 400 || [409, 422].includes(res.status) || (res.status === 501 && PENDING_ROUTES.includes(file));
            expect({ role, action, status: res.status, allowed }).toEqual({ role, action, status: res.status, allowed: true });
          }
        } else {
          const res = await call();
          expect({ status: res.status, code: (await res.json()).code }).toEqual({ status: 403, code: 'forbidden' });
          expect(await rowCounts()).toEqual(counts);
          expect(await mutableDigest()).toEqual(digest);
        }
      });
});
