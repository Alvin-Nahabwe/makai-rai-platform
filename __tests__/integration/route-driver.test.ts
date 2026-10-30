import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PENDING_ROUTES, RETRY_KEYED_WRITES, ROUTE_ACTIONS, UNKEYED_WRITES } from '../../lib/authz/routeActions';
import { resetDb } from '../helpers/db';
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

/**
 * The one implemented call known to throw rather than answer: the v0.5.0 DELETE of a project that holds
 * records fails on the evidence foreign key (`app/api/v1/orgs/[slug]/projects/[id]/route.ts:137`), a 500, not a
 * parser refusal. PRJ answers it 409 `project_has_records` (00-contract.md, Routes, row 24) in the commit that
 * keys the method, so this ends by itself when the method leaves UNKEYED_WRITES.
 */
const PROJECT = `${ORG}projects/[id]/route.ts`;
function knownCrash(file: string, method: string, e: unknown): boolean {
  return file === PROJECT && method === 'DELETE' && (UNKEYED_WRITES[PROJECT]?.methods ?? []).includes('DELETE')
    && (e as { code?: unknown } | null)?.code === 'P2003';
}

let a: OrgFixture;

beforeAll(async () => {
  await resetDb();
});

// A write as the owner may remove the project, the viewer or a membership, so each case gets its own organisation.
beforeEach(async () => {
  a = await buildOrg({ label: 'driver' });
});

describe('validRequestFor (NFR-SEC-02, NFR-INT-02)', () => {
  for (const file of Object.keys(ROUTE_ACTIONS).filter((f) => !PENDING_ROUTES.includes(f)))
    for (const method of Object.keys(ROUTE_ACTIONS[file]) as Method[])
      it(`NFR-SEC-02: validRequestFor gives every implemented route a request its parser accepts (${method} ${file})`, async () => {
        sessionAs(a.members.owner.userId);
        const ids = await idsOf(a, file);
        const res = await callRoute(file, method, { slug: a.org.slug, params: ids, ...validRequestFor(file, method, ids) })
          .catch((e: unknown) => { if (knownCrash(file, method, e)) return null; throw e; });
        if (!res) return;
        const code = res.status >= 400 ? (await res.clone().json()).code : null;
        expect({ file, method, status: res.status, code }).not.toMatchObject({ code: 'validation' });
        expect([400, 422], `${method} ${file} answered ${res.status}`).not.toContain(res.status);
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
      const id = body instanceof FormData ? 'multipart' : (body as { requestId?: string } | undefined)?.requestId;
      expect({ file, method, id }).toEqual({ file, method, id: expect.stringMatching(UUID_V4) });
    }
  });

  it('NFR-SEC-02: validRequestFor throws for a route it does not know', () => {
    expect(() => validRequestFor('app/api/v1/orgs/[slug]/no-such/route.ts', 'POST', {})).toThrow(/no entry for POST/);
  });
});
