import type { Prisma } from '@prisma/client';
import { assertCan, type OrgContext, type TenantTx } from '@/lib/data/tenant';
import { STAGES, type Actor, type CalendarDate, type FieldError, type FindingEventKind, type FindingSource, type MitigationStatus, type Stage, type WriteOutcome } from '@/types/record';
import type { FindingView, RaiseTeamFindingRequest } from '@/types/api';
import { ValidationFailed } from '@/lib/http/errors';
import { idempotentWrite, isRequestId } from '@/lib/data/idempotency';
import { assertProjectWritable } from '@/lib/data/projectGuard';
import { userRefs } from '@/lib/data/views';
import { runningContent } from '@/lib/content/loader';
import { deriveFindingState } from '@/lib/findings/state';
import { FINDING_MESSAGES, TEXT_MAX, textLength } from '@/lib/findings/validate';
import { eatDate, isOverdue } from '@/lib/followup/overdue';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * Team findings (SRS 4 FR-FND-02; contract Services, `lib/data/teamFindings.ts`): a finding a member raises about a stage,
 * optionally one risk area and optionally the question and decision version it concerns (IC-8). A team finding linked to a
 * question never counts as that question's shortfall finding (FR-FND-01): `openShortfallForQuestion` reads `source =
 * 'shortfall'` only. Row-level security scopes every read and write to the context's organisation, and the question link is
 * checked against the project and the running content, so a link cannot point at another project's version.
 */

/** FR-FND-02 / owner question B14: a team finding's title is 1 to 200 characters; its description 1 to 4,000. */
export const TEAM_TITLE_MAX = 200;

/**
 * The texts of the three links (7.4.2 S-14 and this unit's builder copy). One fixed sentence each for a missing object,
 * an object of another stage, project or question, and a malformed id alike, and never the id itself: a body-named foreign
 * object answers the same 422 as a nonexistent one (no oracle, ruling RE-1; round 17 queue, AUTHZ M3).
 */
export const TEAM_FINDING_MESSAGES = Object.freeze({
  title: 'Write a title.',
  description: 'Write a description.',
  stage: 'Choose a stage.',
  riskArea: 'Choose a risk area of this stage, or none.',
  questionId: 'Choose a question of this stage, or none.',
  decisionVersionId: 'Choose a decision version of this question, or none.',
});

/** A lone UTF-16 surrogate cannot be carried by UTF-8; NUL cannot be stored in a PostgreSQL text column (as lib/findings/validate.ts). */
const NOT_STORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const clean = (s: string): string => s.trim().normalize('NFC');
const isString = (v: unknown): v is string => typeof v === 'string';
const isStage = (v: unknown): v is Stage => isString(v) && (STAGES as readonly string[]).includes(v);
/** null, or a non-empty string the database can store. */
const isNullableId = (v: unknown): v is string | null => v === null || (isString(v) && v !== '' && !NOT_STORABLE.test(v));

function textError(v: unknown, field: 'title' | 'description', max: number): FieldError | null {
  if (!isString(v) || textLength(v) === 0) return { field, message: TEAM_FINDING_MESSAGES[field] };
  const n = textLength(v);
  if (n > max) return { field, message: FINDING_MESSAGES.tooLong(n, max) };
  if (NOT_STORABLE.test(v)) return { field, message: FINDING_MESSAGES.notStorable };
  return null;
}

/**
 * The shape and length check of route 5's body, in body order, every faulty field named in one `ValidationFailed`. Returns a
 * new object of exactly the request type's keys with the texts trimmed and in NFC, the form their length was checked in, so
 * a stray body field reaches neither the digest nor a row. The rules that need the database (the question, the version and
 * the area against the project and the running content) are the service's.
 */
export function parseRaiseTeamFinding(body: unknown): RaiseTeamFindingRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed([{ field: 'body', message: FINDING_MESSAGES.body }]);
  }
  const b = body as Record<string, unknown>;
  const errors: FieldError[] = [];
  if (!isRequestId(b.requestId)) errors.push({ field: 'requestId', message: FINDING_MESSAGES.requestId });
  if (!isStage(b.stage)) errors.push({ field: 'stage', message: TEAM_FINDING_MESSAGES.stage });
  for (const e of [textError(b.title, 'title', TEAM_TITLE_MAX), textError(b.description, 'description', TEXT_MAX)]) if (e) errors.push(e);
  for (const f of ['riskArea', 'questionId', 'decisionVersionId'] as const) {
    if (!isNullableId(b[f])) errors.push({ field: f, message: TEAM_FINDING_MESSAGES[f] });
  }
  if (errors.length > 0) throw new ValidationFailed(errors);
  return {
    requestId: b.requestId as string, stage: b.stage as Stage, title: clean(b.title as string), description: clean(b.description as string),
    riskArea: b.riskArea as string | null, questionId: b.questionId as string | null, decisionVersionId: b.decisionVersionId as string | null,
  };
}

const day = (d: Date): CalendarDate => d.toISOString().slice(0, 10);

/**
 * The view of one finding of the transaction's organisation, its state derived (5.3 item 11) from exactly the rows it is
 * derived from. For a finding just raised those are none, so it is open with no mitigation; a replay reads the same rows
 * and so answers the finding as it stands.
 */
async function teamFindingView(tx: TenantTx, findingId: string): Promise<FindingView> {
  const f = await tx.finding.findUniqueOrThrow({ where: { id: findingId } });
  const [events, versions, risks, people] = await Promise.all([
    tx.findingEvent.findMany({ where: { findingId }, select: { kind: true, findingSeq: true } }),
    tx.mitigationVersion.findMany({ where: { findingId }, select: { mitigationId: true, versionNumber: true, status: true, dueDate: true, findingSeq: true } }),
    tx.acceptedRisk.findMany({ where: { findingId }, select: { findingSeq: true } }),
    userRefs(tx, [f.raisedById]),
  ]);
  const latest = new Map<string, (typeof versions)[number]>();
  for (const v of versions) {
    const seen = latest.get(v.mitigationId);
    if (seen === undefined || v.versionNumber > seen.versionNumber) latest.set(v.mitigationId, v);
  }
  const current = [...latest.values()];
  const state = deriveFindingState({
    source: f.source as FindingSource,
    events: events.map((e) => ({ kind: e.kind as FindingEventKind, findingSeq: e.findingSeq })),
    currentMitigations: current.map((m) => ({ status: m.status as MitigationStatus, findingSeq: m.findingSeq })),
    acceptedRisks: risks,
  });
  const today = eatDate(new Date());
  const open = current.filter((m) => m.status === 'planned' || m.status === 'in_progress');
  const raisedBy = people.get(f.raisedById);
  // Accounts are scrubbed, never deleted (FR-EXP-03), so the person who just raised it has a row; ids only in the message (NFR-PRIV-03).
  if (raisedBy === undefined) throw new Error(`teamFindings: finding ${findingId} names user ${f.raisedById}, which has no account row`);
  return {
    id: f.id, projectId: f.projectId, stage: f.stage as Stage, source: f.source as FindingSource, questionId: f.questionId,
    decisionVersionId: f.decisionVersionId, riskArea: f.riskArea, title: f.title, description: f.description,
    raisedBy, raisedAt: f.raisedAt.toISOString(), state, openMitigations: open.length, hasNoMitigation: open.length === 0,
    overdueMitigations: current.filter((m) => isOverdue({ status: m.status as MitigationStatus, dueDate: day(m.dueDate) }, state, today)).length,
  };
}

/** The links the request names, checked inside the transaction: every refusal is one of three fixed field texts (no id echoed). */
async function checkLinks(tx: TenantTx, projectId: string, req: RaiseTeamFindingRequest): Promise<void> {
  const content = runningContent();
  const errors: FieldError[] = [];
  if (req.questionId !== null && content.questions.get(req.questionId)?.stage !== req.stage) {
    errors.push({ field: 'questionId', message: TEAM_FINDING_MESSAGES.questionId });
  }
  if (req.riskArea !== null && content.areas.get(req.riskArea)?.stage !== req.stage) {
    errors.push({ field: 'riskArea', message: TEAM_FINDING_MESSAGES.riskArea });
  }
  if (req.decisionVersionId !== null) {
    // A version needs its question, and is a version of that question in this project (a project of another organisation is invisible under RLS).
    const version = req.questionId === null ? null : await tx.decisionVersion.findFirst({
      where: { id: req.decisionVersionId, projectId, questionId: req.questionId }, select: { id: true },
    });
    if (version === null) errors.push({ field: 'decisionVersionId', message: TEAM_FINDING_MESSAGES.decisionVersionId });
  }
  if (errors.length > 0) throw new ValidationFailed(errors);
}

/**
 * Raise a team finding (FR-FND-02; contract Services row), retry-safe by request id and digest (`idempotentWrite` on
 * `findings`). In one transaction: the project is writable (else 404, or 409 `project_archived`, FR-PRJ-03), the request is
 * valid (title 1 to 200, description 1 to 4,000, a stage, and any question, version and area linked as above, else 422), and
 * the finding is inserted with source `team`, raised by the acting account. `FINDING_RAISED` is logged after the commit,
 * never for a replay, with ids only (NFR-OBS-01, NFR-PRIV-03).
 */
export async function raiseTeamFinding(
  ctx: OrgContext, actor: Actor, a: RaiseTeamFindingRequest & { projectId: string }, digest: string,
): Promise<WriteOutcome<FindingView>> {
  assertCan(ctx, 'finding:raise');
  const req = parseRaiseTeamFinding(a);
  const outcome = await idempotentWrite(ctx, {
    table: 'findings', requestId: req.requestId, digest, actorUserId: actor.userId, replay: teamFindingView,
    write: async (tx) => {
      await assertProjectWritable(tx, a.projectId);
      await checkLinks(tx, a.projectId, req);
      const data: Prisma.FindingUncheckedCreateInput = {
        orgId: ctx.orgId, projectId: a.projectId, stage: req.stage, source: 'team', questionId: req.questionId,
        decisionVersionId: req.decisionVersionId, riskArea: req.riskArea, title: req.title, description: req.description,
        raisedById: actor.userId, requestId: req.requestId, requestDigest: digest,
      };
      const created = await tx.finding.create({ data, select: { id: true } });
      return teamFindingView(tx, created.id);
    },
  });
  if (!outcome.replayed) {
    logSecurityEvent('FINDING_RAISED', 'info', {
      userId: actor.userId, details: { orgId: ctx.orgId, projectId: a.projectId, findingId: outcome.value.id, source: 'team' },
    });
  }
  return outcome;
}
