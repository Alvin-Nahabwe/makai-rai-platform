import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PENDING_ROUTES, ROUTE_ACTIONS } from '../../lib/authz/routeActions';
import type { Action } from '../../lib/authz/policy';
import { ALL_ORG_ROLES } from '../../lib/authz/roles';
import { resetDb } from '../helpers/db';
import { mutableDigest } from '../helpers/digest';
import { answerOrKnownCrash, roleWith } from '../helpers/authzCases';
import { buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { BODY_KEYS, callRoute, sessionAs, idsOf, rowCounts, validRequestFor, type Method } from '../helpers/routeDriver';

/**
 * NFR-SEC-02 (SRS lines 2907-2911): every object named in a request is resolved inside the caller's
 * organisation, so a member of A naming an object of B gets 404 `not_found` and nothing changes, on every
 * route of ROUTE_ACTIONS that takes an object id. Generated from ROUTE_ACTIONS, so a route a producer adds is
 * held here when it leaves PENDING_ROUTES; an id segment with no cross-organisation object fails the first
 * case, so a new segment cannot be skipped.
 *
 * The object case first calls the route on the caller's own objects and requires them found (not 404), then
 * sends the request the route's type accepts (validRequestFor) with B's ids, so it passes the route's parser and
 * reaches the service's withOrg lookup whose 404 it proves (findings SEC-02, C4 F2). It skips
 * PENDING_ROUTES only: a stub's 501 would pass a 404 check vacuously. The 401 and non-member 404 cases run on
 * every route. "Changes nothing" is the row counts and a digest of every row of every table that is not
 * append-only, since a write that renamed B's project would change no count.
 */

const ID_SEGMENTS = ['id', 'questionId', 'findingId', 'mitigationId', 'reviewId', 'sealId', 'documentId', 'evidenceId', 'invitationId', 'userId'];
const segmentsOf = (f: string) => [...f.matchAll(/\[(\w+)\]/g)].map((m) => m[1]).filter((s) => s !== 'slug');
const ROUTES_WITH_IDS = Object.keys(ROUTE_ACTIONS).filter((f) => segmentsOf(f).length > 0);

/**
 * Routes that cannot yet be called with the caller's own ids, each with its reason. Empty: every implemented route
 * with an id segment resolves its own organisation's objects. A route added here is held to its B case alone.
 */
const NOT_CALLABLE_WITH_OWN_IDS: Record<string, string> = {};

const EVIDENCE = 'app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts';
/** The object ids a body can name (routeDriver's BODY_KEYS); `body.evidenceId` is added where the body has an evidence list. */
const BODY_IDS: readonly string[] = BODY_KEYS;

/**
 * Every object a request of (`file`, `method`) names: its path segments (a question id is content, not an
 * organisation's object) and the objects its body names. The body's are read from validRequestFor itself, with
 * placeholder ids, so a body that starts naming an object joins the mixed cases below with no edit here.
 */
function objectIdsOf(file: string, method: Method): string[] {
  const segs = segmentsOf(file).filter((x) => x !== 'questionId');
  const placeholder = Object.fromEntries([...segs, ...BODY_IDS].map((k) => [k, `<${k}>`]));
  const body = validRequestFor(file, method, placeholder).body as Record<string, unknown> | undefined;
  const text = JSON.stringify(body ?? {});
  return [...segs, ...BODY_IDS.filter((k) => text.includes(`"<${k}>"`)), ...(body && 'evidenceIds' in body ? ['body.evidenceId'] : [])];
}

const NOT_FOUND = { status: 404, code: 'not_found' };
const INVALID = { status: 422, code: 'validation' };
/**
 * The answer to another organisation's object, by where the request names it (C4 round 2, RE-1, ruling option a).
 * A path id answers 404 not_found (NFR-SEC-02). A body names an object the service checks against the project, so
 * the contract's and the producers' answer stands: 422 validation for an evidence item (assertEvidenceAttachable,
 * lib/data/evidenceGuard.ts), a mitigation owner (FND-a) and a decision version (FND-a's close-by-decision, FND-b's
 * team finding); 404 for a seal of another organisation (DOC-a's D1). A body object with no answer here fails.
 */
const BODY_ANSWER: Record<string, { status: number; code: string }> = {
  'body.evidenceId': INVALID, 'body.ownerUserId': INVALID, 'body.decisionVersionId': INVALID, 'body.sealId': NOT_FOUND,
};
function foreignAnswer(foreign: string): { status: number; code: string } {
  if (!foreign.startsWith('body.')) return NOT_FOUND;
  const answer = BODY_ANSWER[foreign];
  if (!answer) throw new Error(`authz-cross-org: no contract answer recorded for another organisation's ${foreign}; add it to BODY_ANSWER`);
  return answer;
}

/**
 * The mixed cases (C4 F1, SO-1; NFR-SEC-02 "every object named in a request"): for a route naming more than one
 * object, or naming one in its body, one case per object, with the caller's own organisation's objects everywhere
 * but that one, which is B's. Pending routes are listed here too, and run once their producer implements them.
 */
const MIXED: Array<{ file: string; method: Method; action: Action; foreign: string }> = Object.entries(ROUTE_ACTIONS)
  .flatMap(([file, methods]) => Object.entries(methods).flatMap(([method, action]) => {
    const objects = objectIdsOf(file, method as Method);
    const named = objects.length > 1 || objects.some((k) => k.startsWith('body.'));
    return named ? objects.map((foreign) => ({ file, method: method as Method, action: action as Action, foreign })) : [];
  }));

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
        // A fresh organisation per case: its own call below may delete the project or remove the viewer.
        const own = await buildOrg({ label: 'xorg-own' });
        sessionAs(own.members[roleWith(action as Action)].userId);
        // The control: the same route, same role, on the caller's own objects, must find them. Otherwise the 404
        // below could come from a mapping that resolves nothing, and would prove nothing about the lookup in A.
        if (!(file in NOT_CALLABLE_WITH_OWN_IDS)) {
          const ownIds = await idsOf(own, file);
          const ownRes = await answerOrKnownCrash(file, method, () =>
            callRoute(file, method as Method, { slug: own.org.slug, params: ownIds, ...validRequestFor(file, method as Method, ownIds) }));
          const ownStatus = ownRes === null ? 'reached the delete (known crash)' : ownRes.status;
          const resolved = ownRes === null || (ownRes.status < 500 && ![401, 403, 404].includes(ownRes.status));
          expect({ file, method, ownStatus, resolved }).toEqual({ file, method, ownStatus, resolved: true });
        }
        const ids = await idsOf(b, file);   // before the counts: the first idsOf of a fixture builds its objects
        const [counts, digest] = [await rowCounts(), await mutableDigest()];
        const res = await callRoute(file, method as Method, { slug: own.org.slug, params: ids, ...validRequestFor(file, method as Method, ids) });
        expect({ status: res.status, code: (await res.json()).code }).toEqual({ status: 404, code: 'not_found' });
        expect(await rowCounts()).toEqual(counts);
        expect(await mutableDigest()).toEqual(digest);
      });

  it('NFR-SEC-02: the mixed cases cover each object of every route that names more than one, pending routes included', () => {
    const named = new Set(MIXED.map((m) => `${m.method} ${m.file} ${m.foreign}`));
    for (const expected of [
      'POST app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/mitigations/route.ts findingId',
      'POST app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/mitigations/route.ts body.ownerUserId',
      'POST app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/mitigations/route.ts body.evidenceId',
      'POST app/api/v1/orgs/[slug]/projects/[id]/decisions/route.ts body.evidenceId',
      'POST app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/close-by-decision/route.ts body.decisionVersionId',
      'POST app/api/v1/orgs/[slug]/projects/[id]/findings/route.ts body.decisionVersionId',
      'POST app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents/route.ts body.sealId',
      'GET app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/seals/[sealId]/check/route.ts sealId',
    ]) expect({ expected, listed: named.has(expected) }).toEqual({ expected, listed: true });
  });

  for (const { file, method, action, foreign } of MIXED.filter((m) => !PENDING_ROUTES.includes(m.file)))
    it(`NFR-SEC-02: ${method} ${file}: the caller's objects with another organisation's ${foreign} answer ${foreignAnswer(foreign).status} and change nothing`, async () => {
      if (foreign.startsWith('body.')) {
        // The control (C4 rounds 2 and 3): the same request naming the caller's own object (for an evidence list, the
        // caller's own evidence item on the route's project) must be accepted, so the answer below comes from the
        // lookup of that object and not from a route that refuses the request whatever it names. It runs on an
        // organisation of its own, so the B call and its twin meet an untouched fixture. 422 is refused as well as
        // 401, 403, 404 and any 5xx, since 422 is what most body cases expect from the B call.
        const ctl = await buildOrg({ label: 'xorg-ctl' });
        sessionAs(ctl.members[roleWith(action)].userId);
        const ctlIds = await idsOf(ctl, file);
        if (foreign === 'body.evidenceId') ctlIds['body.evidenceId'] = (await idsOf(ctl, EVIDENCE)).evidenceId;
        const res = await answerOrKnownCrash(file, method, () =>
          callRoute(file, method, { slug: ctl.org.slug, params: ctlIds, ...validRequestFor(file, method, ctlIds) }));
        const ownObjectStatus = res === null ? 'reached the delete (known crash)' : res.status;
        const accepted = res === null || (res.status < 500 && ![401, 403, 404, 422].includes(res.status));
        expect({ file, method, foreign, ownObjectStatus, accepted }).toEqual({ file, method, foreign, ownObjectStatus, accepted: true });
      }
      const own = await buildOrg({ label: 'xorg-mixed' });
      sessionAs(own.members[roleWith(action)].userId);
      const ownIds = await idsOf(own, file);
      const foreignId = foreign === 'body.evidenceId' ? (await idsOf(b, EVIDENCE)).evidenceId : (await idsOf(b, file))[foreign];
      // The whole answer, its support reference aside (each request gets its own).
      const answer = async (value: string) => {
        const ids = { ...ownIds, [foreign]: value };
        const res = await callRoute(file, method, { slug: own.org.slug, params: ids, ...validRequestFor(file, method, ids) });
        const { reference: _reference, ...body } = (await res.json()) as Record<string, unknown>;
        return { status: res.status, body };
      };
      const [counts, digest] = [await rowCounts(), await mutableDigest()];
      const foreignRes = await answer(foreignId);
      expect({ foreign, status: foreignRes.status, code: foreignRes.body.code }).toEqual({ foreign, ...foreignAnswer(foreign) });
      // No oracle: a body naming an id that exists nowhere gets the identical answer, body and all, so nothing in it
      // tells whether another organisation holds that id.
      if (foreign.startsWith('body.')) expect({ foreign, nonexistent: await answer(randomUUID()) }).toEqual({ foreign, nonexistent: foreignRes });
      expect(await rowCounts()).toEqual(counts);
      expect(await mutableDigest()).toEqual(digest);
    });

  for (const file of Object.keys(ROUTE_ACTIONS)) for (const method of Object.keys(ROUTE_ACTIONS[file]))
    it(`NFR-SEC-02 UX-05: ${method} ${file}: no session 401; a member of B naming A's slug, and an unknown organisation, the same coded 404`, async () => {
      const params = await idsOf(a, file);
      sessionAs(null);
      expect((await callRoute(file, method as Method, { slug: a.org.slug, params })).status).toBe(401);
      const notFound = async (slug: string) => {
        const res = await callRoute(file, method as Method, { slug, params });
        return { status: res.status, code: (await res.json()).code };
      };
      for (const role of ALL_ORG_ROLES) {
        sessionAs(b.members[role].userId);
        expect({ role, ...(await notFound(a.org.slug)) }).toEqual({ role, status: 404, code: 'not_found' });
      }
      // S-31 parity at the API: an organisation that does not exist answers exactly as one the caller is not in.
      expect({ unknown: true, ...(await notFound('no-such-organisation')) }).toEqual({ unknown: true, status: 404, code: 'not_found' });
    });
});

it("NFR-SEC-02 Home's next step (plan 1B Task 9, slice 3): a member of B naming A's Home, and an unknown organisation, are not found", async () => {
  // The next step is a read with no route of its own, so ROUTE_ACTIONS cannot hold it; its one door is Home's page. This
  // file's non-member case, applied to that page: every role of B naming A's slug, and an unknown organisation, are refused
  // as not found before any of A's records is read. Imports are local so the cases above keep theirs unchanged.
  const { NotFoundError } = await import('../../lib/data/tenant');
  const page = (await import('../../app/(authenticated)/orgs/[slug]/dashboard/page')).default;
  const a = await buildOrg({ label: 'xorg-home-a' });
  const b = await buildOrg({ label: 'xorg-home-b' });
  const open = (slug: string) => page({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) });
  for (const role of ALL_ORG_ROLES) {
    sessionAs(b.members[role].userId);
    await expect(open(a.org.slug), role).rejects.toBeInstanceOf(NotFoundError);
  }
  await expect(open('no-such-organisation')).rejects.toBeInstanceOf(NotFoundError);
  sessionAs(a.members.assessor.userId);
  await expect(open(a.org.slug)).resolves.toBeDefined();
});
