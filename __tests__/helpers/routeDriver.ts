import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { APPEND_ONLY_TABLES } from '../../lib/data/appendOnly';
import { RETRY_KEYED_WRITES } from '../../lib/authz/routeActions';
import { OUTSIDE_ROLES, type Decider } from '../../types/record';
import type {
  AcceptRiskRequest, AddMitigationRequest, ChangeRoleRequest, CloseByDecisionRequest, CreateLinkEvidenceRequest,
  FindingEventRequest, InviteMemberRequest, IssueDocumentRequest, OpenReviewRequest, PreviewDocumentRequest,
  RaiseTeamFindingRequest, ResendInvitationRequest, SaveDecisionRequest, SealRequest, UpdateMitigationRequest,
  WithdrawDecisionRequest, WithdrawDocumentRequest,
} from '../../types/api';
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
  // The handler gets the segments of its own path and nothing else, as Next gives them (a body id or another
  // route's segment in `a.params` stays out). A segment with no value would reach the handler as undefined, and
  // Prisma reads `where: { userId: undefined }` as no filter at all, so it is refused here.
  const given: Record<string, string> = { slug: a.slug, ...a.params };
  const params: Record<string, string> = {};
  const path = file.replace(/^app/, '').replace(/\/route\.ts$/, '').replace(/\[(\w+)\]/g, (_whole, name: string) => {
    if (given[name] === undefined) throw new Error(`callRoute: no value for [${name}] of ${file}`);
    params[name] = given[name];
    return encodeURIComponent(given[name]);
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

/**
 * The keys under which idsOf gives the objects a request body names (validRequestFor reads them; callRoute never
 * sends them as path segments). `body.evidenceId`, one item of an `evidenceIds` list, is not among them: idsOf
 * never sets it, a caller does.
 */
export const BODY_KEYS = ['body.decisionVersionId', 'body.ownerUserId', 'body.sealId'] as const;

/** The objects one fixture gets, built on its first `idsOf` and kept for the fixture's lifetime. */
interface FixtureObjects {
  projectId: string; evidenceId: string; decisionVersionId: string; findingId: string; mitigationId: string;
  reviewId: string; sealId: string; invitationId: string; invitationToken: string;
}
const built = new WeakMap<OrgFixture, Promise<FixtureObjects>>();
/**
 * A fixture's issued document, built only for a route whose path names one, then kept. Building one for every
 * fixture (about 200 a suite) wrote rows no case read, and made a race in addIssuedDocument's issue time common
 * until unit/fixture-margin gave it a second of margin (__tests__/helpers/recordFixture.ts, 118 s, not 119).
 */
const documents = new WeakMap<OrgFixture, Promise<string>>();
/**
 * A fixture's closable shortfall finding, built only for the close-by-decision route, then kept: version 1 on
 * CLOSABLE_QUESTION_ID is `not_yet` and raises the finding, version 2 is `done`. The route gets that finding as
 * [findingId] and version 2 as body.decisionVersionId, so the caller's own request can succeed (the team finding
 * idsOf gives every other route cannot be closed by a decision, and made every request answer 422; C4 round 3).
 */
const closables = new WeakMap<OrgFixture, Promise<{ findingId: string; doneVersionId: string }>>();
const CLOSE_BY_DECISION = 'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/close-by-decision/route.ts';

/** The fixture question id (G-17): every test naming one runs on the fixture content bundle that holds it. */
const QUESTION_ID = 'Q-PP-01';
/** A question of the same stage of the fixture bundle on which idsOf records no decision. */
const UNDECIDED_QUESTION_ID = 'Q-PP-03';
/** The question of the closable shortfall finding (no other fixture version names it). */
const CLOSABLE_QUESTION_ID = 'Q-PP-04';

async function buildClosable(fx: OrgFixture, projectId: string): Promise<{ findingId: string; doneVersionId: string }> {
  const { contentVersionId } = await publishFixtureContent('0.0.1-fixture');
  const stage = 'pre-processing' as const;
  const notYet = await addDecision(fx, projectId, { stage, questionId: CLOSABLE_QUESTION_ID, contentVersionId, status: 'not_yet' });
  const finding = await addFinding(fx, projectId, { stage, source: 'shortfall', questionId: CLOSABLE_QUESTION_ID, decisionVersionId: notYet.id });
  const done = await addDecision(fx, projectId, { stage, questionId: CLOSABLE_QUESTION_ID, contentVersionId, status: 'done' });
  return { findingId: finding.id, doneVersionId: done.id };
}

async function buildObjects(fx: OrgFixture): Promise<FixtureObjects> {
  const { contentVersionId } = await publishFixtureContent('0.0.1-fixture');
  const stage = 'pre-processing' as const;
  const project = await addProject(fx);
  const evidence = await addEvidence(fx, project.id, { kind: 'file' });
  // The decision names the file: an unattached file is its uploader's alone to download (FR-EVD-06), and the driver acts as every role.
  const decision = await addDecision(fx, project.id, { stage, questionId: QUESTION_ID, contentVersionId, evidenceIds: [evidence.id] });
  const finding = await addFinding(fx, project.id, { stage, source: 'team' });
  const mitigation = await addMitigationVersion(fx, finding.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
  const review = await addStageReview(fx, project.id, { stage });
  const seal = await addSealRow(fx, review.id, { contentVersionId });
  const invitationToken = randomBytes(32).toString('hex');
  const invitation = await testDb.invitation.create({ data: {
    orgId: fx.org.id, email: `invitee-${randomUUID().slice(0, 8)}@fixture.test`, role: 'viewer',
    tokenHash: createHash('sha256').update(invitationToken).digest('hex'), invitedById: fx.members.owner.userId,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  } });
  return {
    projectId: project.id, evidenceId: evidence.id, decisionVersionId: decision.id, findingId: finding.id,
    mitigationId: mitigation.mitigationId, reviewId: review.id, sealId: seal.id,
    invitationId: invitation.id, invitationToken,
  };
}

/**
 * An object of `fx` for every dynamic segment of `file`, plus the objects a body names, keyed `body.decisionVersionId`,
 * `body.ownerUserId` and `body.sealId` (validRequestFor reads them; callRoute passes only path segments). The objects are built once per fixture with the record fixture builder and
 * memoised: a project with an evidence file, a decision on the fixture question `Q-PP-01`, a team finding with
 * a planned mitigation, a stage review with a seal, a pending invitation, and an issued document of that seal
 * (built only for a route whose path names a `[documentId]`, then kept). `userId`
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
  let documentId: string | undefined;
  if (file.includes('[documentId]')) {
    let document = documents.get(fx);
    if (!document) {
      document = addIssuedDocument(fx, o.reviewId, { documentType: 'data_card', sealIds: [o.sealId] }).then((d) => d.id);
      documents.set(fx, document);
    }
    documentId = await document;
  }
  let closable: { findingId: string; doneVersionId: string } | undefined;
  if (file === CLOSE_BY_DECISION) {
    let pending = closables.get(fx);
    if (!pending) {
      pending = buildClosable(fx, o.projectId);
      closables.set(fx, pending);
    }
    closable = await pending;
  }
  const id = file.startsWith('app/api/admin/users/[id]/') ? fx.members.viewer.userId
    : file.startsWith('app/api/v1/orgs/[slug]/projects/[id]/') ? o.projectId : undefined;
  const bySegment: Record<string, string | undefined> = {
    id,
    questionId: QUESTION_ID,
    findingId: closable?.findingId ?? o.findingId, mitigationId: o.mitigationId, reviewId: o.reviewId, sealId: o.sealId,
    documentId, evidenceId: o.evidenceId, invitationId: o.invitationId,
    userId: fx.members.viewer.userId, orgId: fx.org.id, token: o.invitationToken,
  };
  // The objects a body names, under `body.`, so they never pass for a path segment (callRoute sends only those).
  const bodyObjects: Record<(typeof BODY_KEYS)[number], string> = {
    'body.decisionVersionId': closable?.doneVersionId ?? o.decisionVersionId, 'body.ownerUserId': fx.members.assessor.userId, 'body.sealId': o.sealId,
  };
  const ids: Record<string, string> = { ...bodyObjects };
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
const OUTSIDE: Decider = { kind: 'outside_role', role: OUTSIDE_ROLES[0] };
/** A body's evidence list: empty, or the one evidence item `body.evidenceId` names (a cross-organisation case sets it). */
const evidenceIdsOf = (ids: Ids): string[] => (ids['body.evidenceId'] === undefined ? [] : [ids['body.evidenceId']]);
const mitigation = (ids: Ids, file: string): Omit<AddMitigationRequest, 'requestId'> => ({
  what: 'Probe action', ownerUserId: need(ids, 'body.ownerUserId', file), dueDate: '2026-12-01', status: 'planned',
  followsControl: null, closureNote: null, cancelReason: null, evidenceIds: evidenceIdsOf(ids),
});

const REQUESTS: Record<string, Partial<Record<Method, RequestSpec>>> = {
  // Rows 1 to 20 of the contract's org-scoped route table.
  // A question with no version yet (idsOf records version 1 on QUESTION_ID), so a null base is the current one and
  // the save is not refused 409 base_version_moved (FR-DEC-05).
  [`${P}decisions/route.ts`]: { POST: { body: (ids) => ({
    stage: STAGE, questionId: UNDECIDED_QUESTION_ID, baseVersionNumber: null, status: 'done', scopeAnswer: null, optionsInPlace: [],
    reasonCode: null, reason: 'Probe reason for this decision.', decidedBy: OUTSIDE, declaredDate: '2026-10-30', evidenceIds: evidenceIdsOf(ids),
  } satisfies Omit<SaveDecisionRequest, 'requestId'>) } },
  [`${P}questions/[questionId]/withdrawal/route.ts`]: { POST: { body: () => ({
    stage: STAGE, baseVersionNumber: 1, withdrawalCode: 'entered_in_error', reason: 'Probe withdrawal reason.',
  } satisfies Omit<WithdrawDecisionRequest, 'requestId'>) } },
  [`${P}evidence/route.ts`]: { POST: { body: () => ({ kind: 'link', url: 'https://example.org/evidence', label: null } satisfies Omit<CreateLinkEvidenceRequest, 'requestId'>) } },
  [`${ORG}evidence/[evidenceId]/route.ts`]: { GET: {} },
  // A team finding may name the question and decision version it concerns (FR-FND-02; RaiseTeamFindingRequest,
  // contract line 667): it names the fixture's decision on QUESTION_ID in this stage, so the mixed cases probe it.
  [`${P}findings/route.ts`]: { POST: { body: (ids) => ({
    stage: STAGE, title: 'Probe finding', description: 'Probe finding description.', riskArea: null, questionId: QUESTION_ID,
    decisionVersionId: need(ids, 'body.decisionVersionId', `${P}findings/route.ts`),
  } satisfies Omit<RaiseTeamFindingRequest, 'requestId'>) } },
  [`${P}findings/[findingId]/mitigations/route.ts`]: { POST: { body: (ids) => mitigation(ids, `${P}findings/[findingId]/mitigations/route.ts`) } },
  [`${P}findings/[findingId]/mitigations/[mitigationId]/route.ts`]: { POST: { body: (ids) => ({
    ...mitigation(ids, `${P}findings/[findingId]/mitigations/[mitigationId]/route.ts`), baseVersionNumber: 1, changeNote: null,
  } satisfies Omit<UpdateMitigationRequest, 'requestId'>) } },
  [`${P}findings/[findingId]/accepted-risks/route.ts`]: { POST: { body: () => ({
    mode: 'accept', acceptedBy: OUTSIDE, reason: 'Probe acceptance reason.', lookAgainOn: null, lookAgainNote: null,
  } satisfies Omit<AcceptRiskRequest, 'requestId'>) } },
  [`${P}findings/[findingId]/reopen/route.ts`]: { POST: { body: () => ({ reason: 'Probe reopen reason.', eventCode: null } satisfies Omit<FindingEventRequest, 'requestId'>) } },
  [`${P}findings/[findingId]/withdrawal/route.ts`]: { POST: { body: () => ({ reason: 'Probe withdrawal reason.', eventCode: null } satisfies Omit<FindingEventRequest, 'requestId'>) } },
  [`${P}findings/[findingId]/close-by-decision/route.ts`]: { POST: { body: (ids) => ({
    decisionVersionId: need(ids, 'body.decisionVersionId', `${P}findings/[findingId]/close-by-decision/route.ts`),
  } satisfies Omit<CloseByDecisionRequest, 'requestId'>) } },
  [`${P}reviews/route.ts`]: { POST: { body: () => ({ stage: STAGE, preparedFor: null } satisfies Omit<OpenReviewRequest, 'requestId'>) } },
  [`${P}reviews/[reviewId]/seals/route.ts`]: { POST: { body: () => ({} satisfies Omit<SealRequest, 'requestId'>) } },
  [`${P}reviews/[reviewId]/seals/[sealId]/check/route.ts`]: { GET: {} },
  [`${P}reviews/[reviewId]/documents/preview/route.ts`]: { POST: { body: (ids) => ({
    documentType: 'data_card', sealId: need(ids, 'body.sealId', `${P}reviews/[reviewId]/documents/preview/route.ts`), typedFields: {},
  } satisfies PreviewDocumentRequest) } },
  [`${P}reviews/[reviewId]/documents/route.ts`]: { POST: { body: (ids) => ({
    documentType: 'data_card', sealId: need(ids, 'body.sealId', `${P}reviews/[reviewId]/documents/route.ts`), typedFields: {},
  } satisfies Omit<IssueDocumentRequest, 'requestId'>) } },
  [`${ORG}documents/[documentId]/pdf/route.ts`]: { GET: {} },
  [`${ORG}documents/[documentId]/text/route.ts`]: { GET: {} },
  [`${ORG}documents/[documentId]/withdrawal/route.ts`]: { POST: { body: () => ({ reason: 'Probe withdrawal reason.' } satisfies Omit<WithdrawDocumentRequest, 'requestId'>) } },
  [`${ORG}export/route.ts`]: { GET: {} },
  // Rows 21 to 29 (owner answer A1: keyed once MEM or PRJ moves the method to RETRY_KEYED_WRITES).
  [`${P}archive/route.ts`]: { POST: { requestIdOnly: true } },
  [`${P}unarchive/route.ts`]: { POST: { requestIdOnly: true } },
  // types/api.ts has no type for the projects POST and PATCH: "as today, plus requestId" (contract Routes, rows 23, 24).
  [`${ORG}projects/route.ts`]: { GET: {}, POST: { body: () => ({ name: 'Probe' }) } },
  [`${ORG}projects/[id]/route.ts`]: { GET: {}, PATCH: { body: () => ({ name: 'Probe' }) }, DELETE: { requestIdOnly: true } },
  [`${ORG}members/route.ts`]: { GET: {}, POST: { body: () => ({ email: 'probe@fixture.test', role: 'viewer', showLink: false } satisfies Omit<InviteMemberRequest, 'requestId'>) } },
  [`${ORG}members/[userId]/route.ts`]: { PATCH: { body: () => ({ role: 'viewer' } satisfies Omit<ChangeRoleRequest, 'requestId'>) }, DELETE: { requestIdOnly: true } },
  [`${ORG}members/leave/route.ts`]: { POST: { requestIdOnly: true } },
  [`${ORG}invitations/[invitationId]/resend/route.ts`]: { POST: { body: () => ({ showLink: false } satisfies Omit<ResendInvitationRequest, 'requestId'>) } },
  [`${ORG}invitations/[invitationId]/revoke/route.ts`]: { POST: { requestIdOnly: true } },
  // Row 48 (OPS adds its ROUTE_ACTIONS entry with the route).
  [`${P}questions/[questionId]/decision/route.ts`]: { GET: { query: { stage: STAGE } } },
};

/**
 * A body and query for `method` of `file` that its request type accepts. A method `RETRY_KEYED_WRITES` lists
 * at the time of the call gets a fresh v4 `requestId` first; a method it does not list gets the same body
 * without one (no body at all for a `RequestIdBody` route), because the v0.5.0 handlers of rows 21 to 29
 * answer 400 to an unknown key until MEM or PRJ keys them. A body that names an object takes it from `ids`
 * (`body.decisionVersionId`, `body.ownerUserId`, `body.sealId`); an `evidenceIds` list is empty unless
 * `body.evidenceId` is given.
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
