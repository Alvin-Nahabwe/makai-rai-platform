import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { APPEND_ONLY_TABLES } from '../../lib/data/appendOnly';
import { RETRY_KEYED_WRITES } from '../../lib/authz/routeActions';
import { OUTSIDE_ROLES } from '../../types/record';
import { testDb } from './db';
import { sessionFor, clearSession } from './authSession';
// Aliased: the name starts with "use", and react-hooks/rules-of-hooks reads any such call as a React hook.
import { useFixtureContent as publishFixtureContent } from './content';
import {
  addDecision, addEvidence, addFinding, addIssuedDocument, addMitigationVersion, addProject, addSealRow,
  addStageReview, type OrgFixture,
} from './recordFixture';

/**
 * The route driver of 00-contract.md, Test harness API (AUTHZ; MEM and ORG reuse it). It calls the real
 * exported handler of a real route module, as `__tests__/integration/permission-matrix.test.ts` does, with one
 * seam: the session `auth()` returns (`./authSession`'s `vi.mock('../../lib/auth', ...)`). Everything behind the
 * handler is real: the identity read, `requireOrgContext*`, `can()`, `withOrg`, row-level security, triggers.
 */

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type RouteHandler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

/** The request's own host: every request is made to it, and the default `Origin` names it. */
const HOST = 'localhost';

/**
 * Calls `method` of the route module `file` (a repository path such as `app/api/v1/orgs/[slug]/route.ts`).
 * The URL is the route's own path with the parameters put in, and `query` becomes its search string. `origin`
 * defaults to the request's own origin; `null` sends the literal header `Origin: null`. A string, `FormData`,
 * `URLSearchParams` or `Blob` body is sent as itself, any other body as JSON. It throws for a body on a GET and
 * for a dynamic segment `params` gives no value.
 */
export async function callRoute(
  file: string,
  method: Method,
  a: { slug: string; params?: Record<string, string>; query?: Record<string, string>; origin?: string | null; body?: unknown },
): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ '@/' + file.replace(/\.ts$/, ''))) as Record<string, RouteHandler | undefined>;
  const handler = mod[method];
  if (typeof handler !== 'function') throw new Error(`callRoute: ${file} exports no ${method} handler`);
  const params: Record<string, string> = { slug: a.slug, ...a.params };
  // A segment with no value would reach the handler as undefined, and Prisma reads `where: { userId: undefined }`
  // as no filter at all, so it is refused here.
  const path = file.replace(/^app/, '').replace(/\/route\.ts$/, '').replace(/\[(\w+)\]/g, (_whole, name: string) => {
    if (params[name] === undefined) throw new Error(`callRoute: no value for [${name}] of ${file}`);
    return encodeURIComponent(params[name]);
  });
  const url = new URL(`http://${HOST}${path}`);
  for (const [k, v] of Object.entries(a.query ?? {})) url.searchParams.set(k, v);

  const headers: Record<string, string> = { host: HOST, origin: a.origin === undefined ? `http://${HOST}` : String(a.origin) };
  const init: NextRequestInit = { method, headers };
  if (a.body !== undefined) {
    if (method === 'GET') throw new Error(`callRoute: a GET carries no body (${file})`);
    if (typeof a.body === 'string' || a.body instanceof FormData || a.body instanceof URLSearchParams || a.body instanceof Blob) init.body = a.body;
    else {
      init.body = JSON.stringify(a.body);
      headers['content-type'] = 'application/json';
    }
  }
  return handler(new NextRequest(url, init), { params: Promise.resolve(params) });
}

/** The session every later `callRoute` carries: the account `userId`, or none. */
export function sessionAs(userId: string | null): void {
  if (userId === null) clearSession();
  else sessionFor(userId);
}

/** The objects one fixture gets, built on its first `idsOf` and kept for the fixture's lifetime. */
interface FixtureObjects {
  projectId: string; evidenceId: string; decisionVersionId: string; findingId: string; mitigationId: string;
  reviewId: string; sealId: string; documentId: string; invitationId: string; invitationToken: string;
}
const built = new WeakMap<OrgFixture, Promise<FixtureObjects>>();

/** The fixture question id (G-17): every test naming one runs on the fixture content bundle that holds it. */
const QUESTION_ID = 'Q-PP-01';

async function buildObjects(fx: OrgFixture): Promise<FixtureObjects> {
  const { contentVersionId } = await publishFixtureContent('0.0.1-fixture');
  const stage = 'pre-processing' as const;
  const project = await addProject(fx);
  const evidence = await addEvidence(fx, project.id, { kind: 'file' });
  const decision = await addDecision(fx, project.id, { stage, questionId: QUESTION_ID, contentVersionId });
  const finding = await addFinding(fx, project.id, { stage, source: 'team' });
  const mitigation = await addMitigationVersion(fx, finding.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
  const review = await addStageReview(fx, project.id, { stage });
  const seal = await addSealRow(fx, review.id, { contentVersionId });
  const document = await addIssuedDocument(fx, review.id, { documentType: 'data_card', sealIds: [seal.id] });
  const invitationToken = randomBytes(32).toString('hex');
  const invitation = await testDb.invitation.create({ data: {
    orgId: fx.org.id, email: `invitee-${randomUUID().slice(0, 8)}@fixture.test`, role: 'viewer',
    tokenHash: createHash('sha256').update(invitationToken).digest('hex'), invitedById: fx.members.owner.userId,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  } });
  return {
    projectId: project.id, evidenceId: evidence.id, decisionVersionId: decision.id, findingId: finding.id,
    mitigationId: mitigation.mitigationId, reviewId: review.id, sealId: seal.id, documentId: document.id,
    invitationId: invitation.id, invitationToken,
  };
}

/**
 * An object of `fx` for every dynamic segment of `file`, plus the objects a body names (`decisionVersionId`,
 * `ownerUserId`, `sealId`). The objects are built once per fixture with the record fixture builder and
 * memoised: a project with an evidence file, a decision on the fixture question `Q-PP-01`, a team finding with
 * a planned mitigation, a stage review with a seal and an issued document, and a pending invitation. `userId`
 * is the viewer seat (a permitted DELETE removes the viewer); `[id]` is the project under
 * `app/api/v1/orgs/[slug]/projects/[id]/` and an account (the viewer's) under `app/api/admin/users/[id]/`. A
 * segment it does not know, or an `[id]` anywhere else, throws, so a route added later fails loudly instead of
 * being given the wrong kind of object.
 */
export async function idsOf(fx: OrgFixture, file: string): Promise<Record<string, string>> {
  let objects = built.get(fx);
  if (!objects) {
    objects = buildObjects(fx);
    built.set(fx, objects);
  }
  const o = await objects;
  const id = file.startsWith('app/api/admin/users/[id]/') ? fx.members.viewer.userId
    : file.startsWith('app/api/v1/orgs/[slug]/projects/[id]/') ? o.projectId : undefined;
  const bySegment: Record<string, string | undefined> = {
    id,
    questionId: QUESTION_ID,
    findingId: o.findingId, mitigationId: o.mitigationId, reviewId: o.reviewId, sealId: o.sealId,
    documentId: o.documentId, evidenceId: o.evidenceId, invitationId: o.invitationId,
    userId: fx.members.viewer.userId, orgId: fx.org.id, token: o.invitationToken,
  };
  const ids: Record<string, string> = { decisionVersionId: o.decisionVersionId, ownerUserId: fx.members.assessor.userId, sealId: o.sealId };
  for (const [, name] of file.matchAll(/\[(\w+)\]/g)) {
    if (name === 'slug') continue;
    const value = bySegment[name];
    if (value === undefined) throw new Error(`idsOf: no fixture object for the segment [${name}] of ${file}`);
    ids[name] = value;
  }
  return ids;
}

/** Row counts of every append-only table (`APPEND_ONLY_TABLES`) and of projects, memberships, invitations and organizations. */
export async function rowCounts(): Promise<Record<string, number>> {
  const tables = [...APPEND_ONLY_TABLES, 'projects', 'memberships', 'invitations', 'organizations'];
  const sql = `SELECT ${tables.map((t) => `(SELECT count(*)::int FROM "${t}") AS "${t}"`).join(', ')}`;
  const [row] = await testDb.$queryRawUnsafe<Record<string, number>[]>(sql);
  return row;
}

// ---------------------------------------------------------------------------------------------------------
// validRequestFor: a body and query valid under the request type of each route (types/api.ts, 00-contract.md
// "Routes"), so a request naming another organisation's object passes the route's parser and reaches the
// service's withOrg lookup (finding SEC-02).

type Ids = Record<string, string>;
interface RequestSpec {
  /** The body without `requestId`. */
  body?: (ids: Ids) => Record<string, unknown>;
  /** The request type is `RequestIdBody`: the body is `{ requestId }` while keyed and absent while not. */
  requestIdOnly?: true;
  query?: Record<string, string>;
}

function need(ids: Ids, key: string, file: string): string {
  const v = ids[key];
  if (v === undefined) throw new Error(`validRequestFor: ${file} names ${key}, which ids does not hold`);
  return v;
}

const ORG = 'app/api/v1/orgs/[slug]/';
const P = `${ORG}projects/[id]/`;
const STAGE = 'pre-processing';
const OUTSIDE = { kind: 'outside_role', role: OUTSIDE_ROLES[0] };
const mitigation = (ids: Ids, file: string) => ({
  what: 'Probe action', ownerUserId: need(ids, 'ownerUserId', file), dueDate: '2026-12-01', status: 'planned',
  followsControl: null, closureNote: null, cancelReason: null, evidenceIds: [],
});

const REQUESTS: Record<string, Partial<Record<Method, RequestSpec>>> = {
  // Rows 1 to 20 of the contract's org-scoped route table.
  [`${P}decisions/route.ts`]: { POST: { body: () => ({
    stage: STAGE, questionId: QUESTION_ID, baseVersionNumber: null, status: 'done', scopeAnswer: null, optionsInPlace: [],
    reasonCode: null, reason: 'Probe reason for this decision.', decidedBy: OUTSIDE, declaredDate: '2026-10-30', evidenceIds: [],
  }) } },
  [`${P}questions/[questionId]/withdrawal/route.ts`]: { POST: { body: () => ({
    stage: STAGE, baseVersionNumber: 1, withdrawalCode: 'entered_in_error', reason: 'Probe withdrawal reason.',
  }) } },
  [`${P}evidence/route.ts`]: { POST: { body: () => ({ kind: 'link', url: 'https://example.org/evidence', label: null }) } },
  [`${ORG}evidence/[evidenceId]/route.ts`]: { GET: {} },
  [`${P}findings/route.ts`]: { POST: { body: () => ({
    stage: STAGE, title: 'Probe finding', description: 'Probe finding description.', riskArea: null, questionId: null, decisionVersionId: null,
  }) } },
  [`${P}findings/[findingId]/mitigations/route.ts`]: { POST: { body: (ids) => mitigation(ids, `${P}findings/[findingId]/mitigations/route.ts`) } },
  [`${P}findings/[findingId]/mitigations/[mitigationId]/route.ts`]: { POST: { body: (ids) => ({
    ...mitigation(ids, `${P}findings/[findingId]/mitigations/[mitigationId]/route.ts`), baseVersionNumber: 1, changeNote: null,
  }) } },
  [`${P}findings/[findingId]/accepted-risks/route.ts`]: { POST: { body: () => ({
    mode: 'accept', acceptedBy: OUTSIDE, reason: 'Probe acceptance reason.', lookAgainOn: null, lookAgainNote: null,
  }) } },
  [`${P}findings/[findingId]/reopen/route.ts`]: { POST: { body: () => ({ reason: 'Probe reopen reason.', eventCode: null }) } },
  [`${P}findings/[findingId]/withdrawal/route.ts`]: { POST: { body: () => ({ reason: 'Probe withdrawal reason.', eventCode: null }) } },
  [`${P}findings/[findingId]/close-by-decision/route.ts`]: { POST: { body: (ids) => ({
    decisionVersionId: need(ids, 'decisionVersionId', `${P}findings/[findingId]/close-by-decision/route.ts`),
  }) } },
  [`${P}reviews/route.ts`]: { POST: { body: () => ({ stage: STAGE, preparedFor: null }) } },
  [`${P}reviews/[reviewId]/seals/route.ts`]: { POST: { body: () => ({}) } },
  [`${P}reviews/[reviewId]/seals/[sealId]/check/route.ts`]: { GET: {} },
  [`${P}reviews/[reviewId]/documents/preview/route.ts`]: { POST: { body: (ids) => ({
    documentType: 'data_card', sealId: need(ids, 'sealId', `${P}reviews/[reviewId]/documents/preview/route.ts`), typedFields: {},
  }) } },
  [`${P}reviews/[reviewId]/documents/route.ts`]: { POST: { body: (ids) => ({
    documentType: 'data_card', sealId: need(ids, 'sealId', `${P}reviews/[reviewId]/documents/route.ts`), typedFields: {},
  }) } },
  [`${ORG}documents/[documentId]/pdf/route.ts`]: { GET: {} },
  [`${ORG}documents/[documentId]/text/route.ts`]: { GET: {} },
  [`${ORG}documents/[documentId]/withdrawal/route.ts`]: { POST: { body: () => ({ reason: 'Probe withdrawal reason.' }) } },
  [`${ORG}export/route.ts`]: { GET: {} },
  // Rows 21 to 29 (owner answer A1: keyed once MEM or PRJ moves the method to RETRY_KEYED_WRITES).
  [`${P}archive/route.ts`]: { POST: { requestIdOnly: true } },
  [`${P}unarchive/route.ts`]: { POST: { requestIdOnly: true } },
  [`${ORG}projects/route.ts`]: { GET: {}, POST: { body: () => ({ name: 'Probe' }) } },
  [`${ORG}projects/[id]/route.ts`]: { GET: {}, PATCH: { body: () => ({ name: 'Probe' }) }, DELETE: { requestIdOnly: true } },
  [`${ORG}members/route.ts`]: { GET: {}, POST: { body: () => ({ email: 'probe@fixture.test', role: 'viewer', showLink: false }) } },
  [`${ORG}members/[userId]/route.ts`]: { PATCH: { body: () => ({ role: 'viewer' }) }, DELETE: { requestIdOnly: true } },
  [`${ORG}members/leave/route.ts`]: { POST: { requestIdOnly: true } },
  [`${ORG}invitations/[invitationId]/resend/route.ts`]: { POST: { body: () => ({ showLink: false }) } },
  [`${ORG}invitations/[invitationId]/revoke/route.ts`]: { POST: { requestIdOnly: true } },
  // Row 48 (OPS adds its ROUTE_ACTIONS entry with the route).
  [`${P}questions/[questionId]/decision/route.ts`]: { GET: { query: { stage: STAGE } } },
};

/**
 * A body and query for `method` of `file` that its request type accepts. A method `RETRY_KEYED_WRITES` lists
 * at the time of the call gets a fresh v4 `requestId` first; a method it does not list gets the same body
 * without one (no body at all for a `RequestIdBody` route), because the v0.5.0 handlers of rows 21 to 29
 * answer 400 to an unknown key until MEM or PRJ keys them. A body that names an object takes it from `ids`.
 * Throws for a file or method it does not know.
 */
export function validRequestFor(file: string, method: Method, ids: Record<string, string>): { body?: unknown; query?: Record<string, string> } {
  const spec = REQUESTS[file]?.[method];
  if (!spec) throw new Error(`validRequestFor: no entry for ${method} ${file}`);
  const out: { body?: unknown; query?: Record<string, string> } = {};
  if (spec.query) out.query = { ...spec.query };
  if (method === 'GET') return out;
  const keyed = RETRY_KEYED_WRITES[file]?.includes(method as never) ?? false;
  const rest = spec.requestIdOnly ? {} : (spec.body?.(ids) ?? {});
  if (keyed) out.body = { requestId: randomUUID(), ...rest };
  else if (!spec.requestIdOnly) out.body = rest;
  return out;
}
