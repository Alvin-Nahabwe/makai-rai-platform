import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_ROUTES, RETRY_KEYED_WRITES, ROUTE_ACTIONS, UNKEYED_WRITES } from '../../lib/authz/routeActions';
import { resetDb } from '../helpers/db';
import { answerOrKnownCrash } from '../helpers/authzCases';
import { buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { callRoute, sessionAs, idsOf, validRequestFor, type Method } from '../helpers/routeDriver';

/**
 * The route driver's `validRequestFor` must not rot as routes change (finding SEC-02): the cross-organisation
 * case of authz-cross-org.test.ts is only meaningful if its request passes the route's parser and reaches the
 * withOrg lookup. So every implemented route is called as A's owner on A's own objects with the request
 * validRequestFor gives, and must answer neither 400 nor 422 nor a `validation` code; a producer whose parser
 * refuses the contract's request type fails here on the producer's branch.
 *
 * Owner answer A1 (round 9): rows 21 to 29 get a `requestId` exactly when RETRY_KEYED_WRITES lists the method
 * at the time of the call, and the v0.5.0 handlers answer 400 to an unknown key, so an unkeyed row must not be
 * sent one.
 */

const ORG = 'app/api/v1/orgs/[slug]/';
/** Contract Routes rows 21 to 29: nine rows, eleven methods, each held by exactly one of the two lists. */
const EXPECTED_ROWS_21_TO_29 = [
  `POST ${ORG}projects/[id]/archive/route.ts`,
  `POST ${ORG}projects/[id]/unarchive/route.ts`,
  `POST ${ORG}projects/route.ts`,
  `DELETE ${ORG}projects/[id]/route.ts`,
  `PATCH ${ORG}projects/[id]/route.ts`,
  `POST ${ORG}members/route.ts`,
  `DELETE ${ORG}members/[userId]/route.ts`,
  `PATCH ${ORG}members/[userId]/route.ts`,
  `POST ${ORG}members/leave/route.ts`,
  `POST ${ORG}invitations/[invitationId]/resend/route.ts`,
  `POST ${ORG}invitations/[invitationId]/revoke/route.ts`,
].sort();
/** The rows of those whose request type is `RequestIdBody` (rows 21, 22, 24 DELETE, 26 DELETE, 27, 29). */
const REQUEST_ID_ONLY = [
  `POST ${ORG}projects/[id]/archive/route.ts`,
  `POST ${ORG}projects/[id]/unarchive/route.ts`,
  `DELETE ${ORG}projects/[id]/route.ts`,
  `DELETE ${ORG}members/[userId]/route.ts`,
  `POST ${ORG}members/leave/route.ts`,
  `POST ${ORG}invitations/[invitationId]/revoke/route.ts`,
];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** (method file) -> the reason it answers 404 to the owner on the owner's own objects. Empty: none does. */
const OWN_OBJECTS_404: Record<string, string> = {};

let a: OrgFixture;

beforeAll(async () => {
  await resetDb();
});

// A write as the owner may remove the project, the viewer or a membership, so each case gets its own organisation.
beforeEach(async () => {
  a = await buildOrg({ label: 'driver' });
});

describe('callRoute (NFR-SEC-02)', () => {
  // A pending route no other case here imports, so its module can be stood in for while this case runs.
  const ECHO = 'app/api/v1/orgs/[slug]/documents/[documentId]/text/route.ts';
  it('NFR-SEC-02: callRoute gives a handler only the segments of its own path, as Next does', async () => {
    vi.doMock('@/app/api/v1/orgs/[slug]/documents/[documentId]/text/route', () => ({
      GET: async (_req: Request, ctx: { params: Promise<Record<string, string>> }) => Response.json(await ctx.params),
    }));
    try {
      const res = await callRoute(ECHO, 'GET', { slug: 'probe-org', params: { documentId: 'd1', id: 'p1', 'body.sealId': 's1' } });
      expect(await res.json()).toEqual({ slug: 'probe-org', documentId: 'd1' });
    } finally {
      vi.doUnmock('@/app/api/v1/orgs/[slug]/documents/[documentId]/text/route');
    }
  });
});

describe('validRequestFor (NFR-SEC-02, NFR-INT-02)', () => {
  for (const file of Object.keys(ROUTE_ACTIONS).filter((f) => !PENDING_ROUTES.includes(f)))
    for (const method of Object.keys(ROUTE_ACTIONS[file]) as Method[])
      it(`NFR-SEC-02: validRequestFor gives every implemented route a request its parser accepts (${method} ${file})`, async () => {
        sessionAs(a.members.owner.userId);
        const ids = await idsOf(a, file);
        const res = await answerOrKnownCrash(file, method, () =>
          callRoute(file, method, { slug: a.org.slug, params: ids, ...validRequestFor(file, method, ids) }));
        if (!res) return;
        const code = res.status >= 400 ? (await res.clone().json()).code : null;
        expect({ file, method, status: res.status, code }).not.toMatchObject({ code: 'validation' });
        // Success, or a business refusal (409, 410); never 400 or 422, and no 404, 5xx, 401 or 403: the owner on the
        // owner's own objects is always found (authz-cross-org's own-ids control holds the same), so any of these
        // shows the call never reached the route's own logic. A route that truly answers 404 here is listed below.
        const accepted = res.status < 400 || [409, 410].includes(res.status)
          || (res.status === 404 && `${method} ${file}` in OWN_OBJECTS_404);
        expect({ file, method, status: res.status, accepted }).toEqual({ file, method, status: res.status, accepted: true });
      });

  it('NFR-INT-02 (owner answer A1, round 9): validRequestFor gives a fresh v4 requestId to each method of rows 21 to 29 that RETRY_KEYED_WRITES lists, none to a method that UNKEYED_WRITES lists, and only the requestId for a keyed RequestIdBody row', () => {
    const ROW_FILES = /\/(projects(\/\[id\](\/(un)?archive)?)?|members(\/\[userId\]|\/leave)?|invitations\/\[invitationId\]\/(resend|revoke))\/route\.ts$/;
    const files = [...new Set([...Object.keys(RETRY_KEYED_WRITES), ...Object.keys(UNKEYED_WRITES)])].filter((f) => ROW_FILES.test(f));
    const rows = files.flatMap((f) => [
      ...(RETRY_KEYED_WRITES[f] ?? []).map((m) => ({ f, m: m as Method, keyed: true })),
      ...(UNKEYED_WRITES[f]?.methods ?? []).map((m) => ({ f, m: m as Method, keyed: false })),
    ]);
    expect(rows.map((r) => `${r.m} ${r.f}`).sort()).toEqual(EXPECTED_ROWS_21_TO_29);
    for (const { f, m, keyed } of rows) {
      const first = validRequestFor(f, m, {}).body as Record<string, unknown> | undefined;
      const second = validRequestFor(f, m, {}).body as Record<string, unknown> | undefined;
      if (keyed) {
        expect({ f, m, id: first?.requestId }).toEqual({ f, m, id: expect.stringMatching(UUID_V4) });
        expect(first?.requestId).not.toBe(second?.requestId);
        if (REQUEST_ID_ONLY.includes(`${m} ${f}`)) expect(Object.keys(first ?? {})).toEqual(['requestId']);
      } else {
        // the v0.5.0 handlers answer 400 to an unknown key
        expect({ f, m, sentRequestId: first !== undefined && 'requestId' in first }).toEqual({ f, m, sentRequestId: false });
      }
    }
  });

  it('NFR-INT-02: every method of RETRY_KEYED_WRITES gets a body whose requestId is a v4 UUID', async () => {
    for (const [file, methods] of Object.entries(RETRY_KEYED_WRITES)) for (const method of methods as Method[]) {
      const { body } = validRequestFor(file, method, await idsOf(a, file));
      expect({ file, method, id: (body as { requestId?: string } | undefined)?.requestId }).toEqual({ file, method, id: expect.stringMatching(UUID_V4) });
    }
  });

  it('NFR-SEC-02: validRequestFor throws for a route it does not know', () => {
    expect(() => validRequestFor('app/api/v1/orgs/[slug]/no-such/route.ts', 'POST', {})).toThrow(/no entry for POST/);
  });
});
