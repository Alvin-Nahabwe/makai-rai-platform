import { randomUUID } from 'node:crypto';
import type { OrgRole, Prisma } from '@prisma/client';
import { assertCan, withOrg, ForbiddenError, NotFoundError, type OrgContext, type TenantTx } from '@/lib/data/tenant';
import type {
  Actor, CalendarDate, FieldError, FindingEventKind, FindingSource, FindingState, MitigationKind, MitigationStatus, OutsideRole, Stage,
  StoredDecisionStatus, WriteOutcome,
} from '@/types/record';
import type {
  AcceptedRiskView, AcceptRiskRequest, AddMitigationRequest, CloseByDecisionRequest, DeciderView, FindingClosedConflict,
  FindingDetailView, FindingEventRequest, FindingEventView, FindingView, MitigationVersionView, UpdateMitigationRequest, UserRef,
} from '@/types/api';
import { AppError, ConflictError, ValidationFailed } from '@/lib/http/errors';
import { can } from '@/lib/authz/policy';
import { derivedRequestId, idempotentWrite } from '@/lib/data/idempotency';
import { isUniqueViolation, uniqueViolationIndex } from '@/lib/data/pgErrors';
import { assertProjectWritable } from '@/lib/data/projectGuard';
import { assertEvidenceAttachable } from '@/lib/data/evidenceGuard';
import { erasedFields, evidenceViews, userRefs } from '@/lib/data/views';
import { sealsIncludingRows } from '@/lib/data/seals';
import { runningContent } from '@/lib/content/loader';
import { deriveFindingState } from '@/lib/findings/state';
import { FINDING_MESSAGES, parseAcceptRisk, parseAddMitigation, parseCloseByDecision, parseFindingEvent, parseUpdateMitigation } from '@/lib/findings/validate';
import { eatDate, isOverdue } from '@/lib/followup/overdue';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * Findings service (SRS 9.4 "Findings service" row, line 3521; FR-FND-01, 03 to 07): shortfall findings, mitigation
 * versions, accepted risks and finding events, and each finding's state derived by 5.3 item 11 (K0b's
 * `deriveFindingState`) from exactly those rows. Every read and write runs inside `withOrg`, so row-level security
 * scopes it to the context's organisation, and every lookup is also scoped to the route's project, so a finding of
 * another project or organisation is not found (NFR-SEC-02). Rows are only ever inserted (append-only, K0a).
 *
 * Every write to an existing finding first takes the per-finding transaction lock (`lockFinding`), the same key K0a's
 * `finding_seq_assign()` trigger takes (prisma/migrations/20261030000300_v060_03_tenant/migration.sql:347), so the
 * state a write checks is the state its insert lands on, and two writes to one finding never interleave.
 */

// ─── Rows and state ──────────────────────────────────────────────────────────────────────────────

const FINDING_SELECT = {
  id: true, projectId: true, stage: true, source: true, questionId: true, decisionVersionId: true, riskArea: true, title: true,
  description: true, raisedById: true, raisedAt: true,
} satisfies Prisma.FindingSelect;
const EVENT_SELECT = {
  id: true, findingId: true, kind: true, eventCode: true, reason: true, byId: true, at: true, findingSeq: true,
} satisfies Prisma.FindingEventSelect;
const MITIGATION_SELECT = {
  id: true, findingId: true, mitigationId: true, versionNumber: true, baseVersionNumber: true, what: true, changeNote: true,
  ownerUserId: true, dueDate: true, status: true, kind: true, followsControl: true, closureNote: true, closureDecisionVersionId: true,
  cancelReason: true, enteredById: true, enteredByRole: true, findingSeq: true, receivedAt: true, evidence: { select: { evidenceId: true } },
} satisfies Prisma.MitigationVersionSelect;
const RISK_SELECT = {
  id: true, findingId: true, acceptedByUserId: true, acceptedByRole: true, accepterRole: true, reason: true, lookAgainNote: true,
  lookAgainOn: true, enteredById: true, enteredByRole: true, findingSeq: true, receivedAt: true,
} satisfies Prisma.AcceptedRiskSelect;

type FindingRow = Prisma.FindingGetPayload<{ select: typeof FINDING_SELECT }>;
type EventRow = Prisma.FindingEventGetPayload<{ select: typeof EVENT_SELECT }>;
type MitigationRow = Prisma.MitigationVersionGetPayload<{ select: typeof MITIGATION_SELECT }>;
type RiskRow = Prisma.AcceptedRiskGetPayload<{ select: typeof RISK_SELECT }>;

/** A finding with every row its state is computed from, and the state (5.3 item 11). */
interface FindingRecord {
  finding: FindingRow;
  events: EventRow[];                       // by findingSeq
  versions: MitigationRow[];                // every mitigation version, by findingSeq
  current: MitigationRow[];                 // the highest-numbered version of each mitigation, by first findingSeq
  risks: RiskRow[];                         // by findingSeq
  state: FindingState;
}

/**
 * SELECT pg_advisory_xact_lock(hashtextextended('finding:' || id, 0)): held to the end of the transaction. A row lock
 * is not available: the app role holds only SELECT and INSERT on these append-only tables, and FOR UPDATE needs UPDATE.
 */
async function lockFinding(tx: TenantTx, findingId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('finding:' || ${findingId}, 0))`;
}

/**
 * The finding's lock and, for a shortfall finding, the lock of every shortfall finding of its question, in id order: the
 * set and order onShortfallSaved takes, so a reopen and a save on one question serialise and never deadlock, and the
 * reopen's check that no other shortfall of the question is open holds until it commits. A finding of another project
 * reads as none here; loadFinding then answers 404.
 */
async function lockFindingAndQuestion(tx: TenantTx, projectId: string, findingId: string): Promise<void> {
  const f = await tx.finding.findFirst({ where: { id: findingId, projectId }, select: { source: true, questionId: true } });
  if (f === null || f.source !== 'shortfall' || f.questionId === null) {
    await lockFinding(tx, findingId);
    return;
  }
  const ids = await tx.finding.findMany({ where: { projectId, questionId: f.questionId, source: 'shortfall' }, select: { id: true }, orderBy: { id: 'asc' } });
  for (const { id } of ids) await lockFinding(tx, id);
}

/** The findings `where` selects, each with its rows and state, in the order of `orderBy`. */
async function loadRecords(
  tx: TenantTx, where: Prisma.FindingWhereInput, orderBy: Prisma.FindingOrderByWithRelationInput[] = [{ raisedAt: 'asc' }, { id: 'asc' }],
): Promise<FindingRecord[]> {
  const findings = await tx.finding.findMany({ where, select: FINDING_SELECT, orderBy });
  if (findings.length === 0) return [];
  const ids = findings.map((f) => f.id);
  const [events, versions, risks] = await Promise.all([
    tx.findingEvent.findMany({ where: { findingId: { in: ids } }, select: EVENT_SELECT, orderBy: { findingSeq: 'asc' } }),
    tx.mitigationVersion.findMany({ where: { findingId: { in: ids } }, select: MITIGATION_SELECT, orderBy: { findingSeq: 'asc' } }),
    tx.acceptedRisk.findMany({ where: { findingId: { in: ids } }, select: RISK_SELECT, orderBy: { findingSeq: 'asc' } }),
  ]);
  const group = <T extends { findingId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>(ids.map((id) => [id, []]));
    for (const r of rows) m.get(r.findingId)?.push(r);
    return m;
  };
  const [ev, mv, ar] = [group(events), group(versions), group(risks)];
  return findings.map((finding) => {
    const vs = mv.get(finding.id) ?? [];
    const latest = new Map<string, MitigationRow>();
    for (const v of vs) {
      const seen = latest.get(v.mitigationId);
      if (seen === undefined || v.versionNumber > seen.versionNumber) latest.set(v.mitigationId, v);
    }
    const current = [...latest.values()];
    const evs = ev.get(finding.id) ?? [];
    const rs = ar.get(finding.id) ?? [];
    const state = deriveFindingState({
      source: finding.source as FindingSource,
      events: evs.map((e) => ({ kind: e.kind as FindingEventKind, findingSeq: e.findingSeq })),
      currentMitigations: current.map((m) => ({ status: m.status as MitigationStatus, findingSeq: m.findingSeq })),
      acceptedRisks: rs.map((r) => ({ findingSeq: r.findingSeq })),
    });
    return { finding, events: evs, versions: vs, current, risks: rs, state };
  });
}

/** The `findingSeq` of the finding's latest reopen, or 0 (5.3 item 11's R). */
const reopenedAt = (r: FindingRecord) => Math.max(0, ...r.events.filter((e) => e.kind === 'reopened').map((e) => e.findingSeq));

/** The current accepted risk: the one with the highest findingSeq above the latest reopen (5.3 item 11 rule 2), or null. */
function currentRisk(r: FindingRecord): RiskRow | null {
  const after = r.risks.filter((a) => a.findingSeq > reopenedAt(r));
  return after.length === 0 ? null : after[after.length - 1];
}

// ─── Views ───────────────────────────────────────────────────────────────────────────────────────

const iso = (d: Date) => d.toISOString();
const day = (d: Date): CalendarDate => d.toISOString().slice(0, 10);

/** The one element of a result that must hold exactly one: a row just inserted or found in the same transaction. */
function one<T>(xs: readonly T[], what: string): T {
  if (xs.length !== 1) throw new Error(`findings: expected exactly one ${what}, got ${xs.length}`);
  return xs[0];
}

/** The `UserRef` of every id, read once; an id with no account row is an integrity fault (accounts are scrubbed, never deleted, FR-EXP-03). */
async function people(tx: TenantTx, ids: readonly string[]): Promise<(rowId: string, userId: string) => UserRef> {
  const refs = await userRefs(tx, ids);
  return (rowId, userId) => {
    const ref = refs.get(userId);
    // Ids only in the message (NFR-PRIV-03), so the row can be found.
    if (ref === undefined) throw new Error(`findings view: row ${rowId} names user ${userId}, which has no account row`);
    return ref;
  };
}

/** Every mitigation version view: names with the former-member mark, evidence with its erased mark, erased fields (FR-REV-08). */
async function mitigationViews(tx: TenantTx, rows: readonly MitigationRow[]): Promise<MitigationVersionView[]> {
  if (rows.length === 0) return [];
  const [person, evidence, erased] = await Promise.all([
    people(tx, rows.flatMap((r) => [r.ownerUserId, r.enteredById])),
    evidenceViews(tx, rows.flatMap((r) => r.evidence.map((e) => e.evidenceId))),
    erasedFields(tx, 'mitigation_versions', rows.map((r) => r.id)),
  ]);
  const item = (r: MitigationRow, id: string) => {
    const v = evidence.get(id);
    // mitigation_evidence holds a foreign key to evidence, whose rows are never deleted (5.3 item 8).
    if (v === undefined) throw new Error(`findings view: mitigation version ${r.id} attaches evidence ${id}, which has no evidence row`);
    return v;
  };
  return rows.map((r): MitigationVersionView => ({
    id: r.id, findingId: r.findingId, mitigationId: r.mitigationId, versionNumber: r.versionNumber, baseVersionNumber: r.baseVersionNumber,
    what: r.what, changeNote: r.changeNote, owner: person(r.id, r.ownerUserId), dueDate: day(r.dueDate),
    status: r.status as MitigationStatus, kind: r.kind as MitigationKind, followsControl: r.followsControl, closureNote: r.closureNote,
    closureDecisionVersionId: r.closureDecisionVersionId, cancelReason: r.cancelReason, enteredBy: person(r.id, r.enteredById),
    enteredByRole: r.enteredByRole, findingSeq: r.findingSeq, receivedAt: iso(r.receivedAt),
    evidence: r.evidence.map((e) => item(r, e.evidenceId)).sort((x, y) => x.uploadedAt.localeCompare(y.uploadedAt) || x.id.localeCompare(y.id)),
    erasedFields: erased.get(r.id)?.fields ?? [],
  }));
}

async function riskViews(tx: TenantTx, rows: readonly RiskRow[]): Promise<AcceptedRiskView[]> {
  if (rows.length === 0) return [];
  const [person, erased] = await Promise.all([
    people(tx, rows.flatMap((r) => (r.acceptedByUserId ? [r.enteredById, r.acceptedByUserId] : [r.enteredById]))),
    erasedFields(tx, 'accepted_risks', rows.map((r) => r.id)),
  ]);
  return rows.map((r): AcceptedRiskView => {
    let acceptedBy: DeciderView;
    if (r.acceptedByUserId !== null) acceptedBy = { kind: 'member', user: person(r.id, r.acceptedByUserId) };
    else if (r.acceptedByRole !== null) acceptedBy = { kind: 'outside_role', role: r.acceptedByRole as OutsideRole };
    // acceptRisk always stores one of the two (accepted_risks_accepted_by_check allows none, so the rule is the writer's).
    else throw new Error(`findings view: accepted risk ${r.id} names nobody who accepted it`);
    return {
      id: r.id, findingId: r.findingId, acceptedBy, accepterRole: r.accepterRole, reason: r.reason, lookAgainNote: r.lookAgainNote,
      lookAgainOn: r.lookAgainOn === null ? null : day(r.lookAgainOn), enteredBy: person(r.id, r.enteredById), enteredByRole: r.enteredByRole,
      findingSeq: r.findingSeq, receivedAt: iso(r.receivedAt), erasedFields: erased.get(r.id)?.fields ?? [],
    };
  });
}

async function eventViews(tx: TenantTx, rows: readonly EventRow[]): Promise<FindingEventView[]> {
  if (rows.length === 0) return [];
  const person = await people(tx, rows.map((r) => r.byId));
  return rows.map((r): FindingEventView => ({
    id: r.id, findingId: r.findingId, kind: r.kind as FindingEventKind, eventCode: r.eventCode, reason: r.reason,
    by: person(r.id, r.byId), at: iso(r.at), findingSeq: r.findingSeq,
  }));
}

/** The cancel reason of the versions an acceptance saves (FR-FND-05, 5.3 item 11 rule 2). */
const RISK_ACCEPTED_REASON = 'risk accepted';

const isOpenWork = (m: { status: string }) => m.status === 'planned' || m.status === 'in_progress';

/** The list views of the records, with `overdueMitigations` counted against `today` (FR-FUP-02's rule, K0b's `isOverdue`). */
async function findingViews(tx: TenantTx, records: readonly FindingRecord[], today: CalendarDate): Promise<FindingView[]> {
  if (records.length === 0) return [];
  const person = await people(tx, records.map((r) => r.finding.raisedById));
  return records.map(({ finding: f, current, state }): FindingView => {
    const open = current.filter(isOpenWork);
    return {
      id: f.id, projectId: f.projectId, stage: f.stage as Stage, source: f.source as FindingSource, questionId: f.questionId,
      decisionVersionId: f.decisionVersionId, riskArea: f.riskArea, title: f.title, description: f.description,
      raisedBy: person(f.id, f.raisedById), raisedAt: iso(f.raisedAt), state,
      openMitigations: open.length, hasNoMitigation: open.length === 0,
      overdueMitigations: current.filter((m) => isOverdue({ status: m.status as MitigationStatus, dueDate: day(m.dueDate) }, state, today)).length,
    };
  });
}

/** The finding of the project with its rows, or `NotFoundError` (a finding of another project or organisation is not found, NFR-SEC-02). */
async function loadFinding(tx: TenantTx, projectId: string, findingId: string): Promise<FindingRecord> {
  const [record] = await loadRecords(tx, { id: findingId, projectId });
  if (record === undefined) throw new NotFoundError();
  return record;
}

/**
 * Who closed the finding and when (`FindingClosedConflict`, the `current` of 409 `finding_not_open`; 7.4.4, SRS line 2435,
 * "This finding was closed by <who> at <time>."): the withdrawal event, the current accepted risk's entry, or the latest
 * done version counted since the last reopen.
 */
async function closedConflict(tx: TenantTx, r: FindingRecord): Promise<FindingClosedConflict> {
  let by: string;
  let at: Date;
  if (r.state === 'withdrawn') {
    const e = r.events.findLast((x) => x.kind === 'withdrawn');
    if (e === undefined) throw new Error(`findings: withdrawn finding ${r.finding.id} has no withdrawal event`);
    [by, at] = [e.byId, e.at];
  } else if (r.state === 'closed_accepted_risk') {
    const a = currentRisk(r);
    if (a === null) throw new Error(`findings: finding ${r.finding.id} is closed by an accepted risk it does not hold`);
    [by, at] = [a.enteredById, a.receivedAt];
  } else if (r.state === 'closed_mitigation') {
    const done = r.current.filter((m) => m.status === 'done' && m.findingSeq > reopenedAt(r)).sort((x, y) => x.findingSeq - y.findingSeq).at(-1);
    if (done === undefined) throw new Error(`findings: finding ${r.finding.id} is closed by a mitigation it does not hold`);
    [by, at] = [done.enteredById, done.receivedAt];
  } else {
    throw new Error(`findings: closedConflict asked of open finding ${r.finding.id}`);
  }
  const person = await people(tx, [by]);
  return { state: r.state, by: person(r.finding.id, by), at: iso(at) };
}

/** 1 + the largest findingSeq of the finding's events, mitigation versions and accepted risks; read under `lockFinding`, checked by K0a's trigger. */
async function nextFindingSeq(tx: TenantTx, findingId: string): Promise<number> {
  const [{ n }] = await tx.$queryRaw<{ n: number }[]>`SELECT (coalesce(max(s), 0) + 1)::int AS n FROM (
    SELECT "findingSeq" AS s FROM "finding_events" WHERE "findingId" = ${findingId}
    UNION ALL SELECT "findingSeq" FROM "mitigation_versions" WHERE "findingId" = ${findingId}
    UNION ALL SELECT "findingSeq" FROM "accepted_risks" WHERE "findingId" = ${findingId}) AS x`;
  return n;
}

/** NFR-OBS-01: FINDING_CLOSED after the transaction committed, never for a replay, ids only (NFR-PRIV-03). */
function logClosed(ctx: OrgContext, actor: Actor, findingId: string, state: FindingState): void {
  logSecurityEvent('FINDING_CLOSED', 'info', { userId: actor.userId, details: { orgId: ctx.orgId, findingId, state } });
}

// ─── Shortfall findings (FR-FND-01) ──────────────────────────────────────────────────────────────

/** A question's shortfall findings in the order they were raised: by the number of the version that raised each, never by a time. */
const BY_RAISING_VERSION: Prisma.FindingOrderByWithRelationInput[] = [{ decisionVersion: { versionNumber: 'asc' } }, { id: 'asc' }];

/** not_yet is worse than partly (FR-FND-01); no other status is ranked against them. */
const SHORTFALL_RANK: Partial<Record<string, number>> = { partly: 1, not_yet: 2 };

/**
 * Called by the decision service inside its save transaction, after the version insert (SRS 9.4 sequence, line 3619).
 * FR-FND-01 (SRS line 881): only a `partly` or `not_yet` version raises a finding, and only when the question has no
 * open shortfall finding (team findings never count, FR-FND-02). When the question's latest shortfall finding L is
 * closed by an accepted risk A, a new one is raised only if a version numbered above V_A and below this one has status
 * `done` or `not_applicable`, or this status is worse than V_A's, where V_A is the question's highest-numbered version
 * below this one received at or before A. V_A excludes this version itself: a save that waited on L's lock behind
 * an acceptance would otherwise compare its status with itself. Only `partly` and `not_yet` are ranked, so a V_A of
 * any other status (done, a withdrawal) opens a new finding: the rule never hides a shortfall it cannot rank.
 *
 * The question's shortfall findings are locked (in id order) before their state is read, so an acceptance or a reopen
 * in flight is either seen committed or waits for this save. Returns `null`, not a throw, when nothing is raised. The
 * new finding carries `derivedRequestId(request.requestId, 'findings:' + version.id)` and `request.digest`. No log
 * line here: DEC-a logs `FINDING_RAISED` after its save commits (contract `FINDING_RAISED` row, gap G040).
 */
export async function onShortfallSaved(
  tx: TenantTx,
  ctx: OrgContext,
  version: { id: string; projectId: string; stage: Stage; questionId: string; status: StoredDecisionStatus | null; enteredById: string },
  request: { requestId: string; digest: string },
): Promise<{ findingId: string } | null> {
  if (version.status !== 'partly' && version.status !== 'not_yet') return null;
  const where = { projectId: version.projectId, questionId: version.questionId, source: 'shortfall' };
  const ids = (await tx.finding.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } })).map((f) => f.id);
  for (const id of ids) await lockFinding(tx, id);
  const records = await loadRecords(tx, where, BY_RAISING_VERSION);
  if (records.some((r) => r.state === 'open')) return null;
  const latest = records.at(-1);
  if (latest !== undefined && latest.state === 'closed_accepted_risk' && !(await raisesAfterAcceptance(tx, version, latest))) return null;
  const created = await tx.finding.create({
    data: {
      orgId: ctx.orgId, projectId: version.projectId, stage: version.stage, source: 'shortfall', questionId: version.questionId,
      decisionVersionId: version.id, riskArea: null, title: null, description: null, raisedById: version.enteredById,
      requestId: derivedRequestId(request.requestId, 'findings:' + version.id), requestDigest: request.digest,
    },
    select: { id: true },
  });
  return { findingId: created.id };
}

/** FR-FND-01's exception, read on L closed by its current accepted risk A: true when this version raises a new finding. */
async function raisesAfterAcceptance(
  tx: TenantTx, version: { id: string; projectId: string; questionId: string; status: StoredDecisionStatus | null }, latest: FindingRecord,
): Promise<boolean> {
  const risk = currentRisk(latest);
  // closed_accepted_risk is derived from exactly such a risk (5.3 item 11 rule 2), so none is a state-rule fault.
  if (risk === null) throw new Error(`findings: finding ${latest.finding.id} is closed by an accepted risk it does not hold`);
  const own = await tx.decisionVersion.findUniqueOrThrow({ where: { id: version.id }, select: { versionNumber: true } });
  const at = { projectId: version.projectId, questionId: version.questionId };
  const accepted = await tx.decisionVersion.findFirst({
    where: { ...at, versionNumber: { lt: own.versionNumber }, receivedAt: { lte: risk.receivedAt } },
    select: { versionNumber: true, status: true }, orderBy: { versionNumber: 'desc' },
  });
  // L was raised by a version of this question below this one, received before A was recorded: none is an integrity fault.
  if (accepted === null) throw new Error(`findings: no decision version of finding ${latest.finding.id}'s question precedes its accepted risk ${risk.id}`);
  const fixedSince = await tx.decisionVersion.count({
    where: { ...at, versionNumber: { gt: accepted.versionNumber, lt: own.versionNumber }, status: { in: ['done', 'not_applicable'] } },
  });
  if (fixedSince > 0) return true;
  const was = accepted.status === null ? undefined : SHORTFALL_RANK[accepted.status];
  const now = version.status === null ? undefined : SHORTFALL_RANK[version.status];
  return was === undefined || now === undefined || now > was;
}

// ─── Mitigations (FR-FND-03, FR-FND-04) ──────────────────────────────────────────────────────────

/** The unique index that numbers a mitigation's versions (5.3 item 3): the backstop behind the finding lock. */
const MITIGATION_VERSION_INDEX = 'mitigation_versions_orgId_mitigationId_versionNumber_key';

/** True when the account is an active member of the transaction's organisation whose role holds `mitigation:write` (FR-FND-03). */
async function mayOwnMitigation(tx: TenantTx, userId: string): Promise<boolean> {
  const m = await tx.membership.findFirst({ where: { userId, status: 'active' }, select: { role: true } });
  return m !== null && can(m.role, 'mitigation:write');
}

/** The view of one stored mitigation version, by id (the replay of `idempotentWrite`). */
async function mitigationViewById(tx: TenantTx, id: string): Promise<MitigationVersionView> {
  return one(await mitigationViews(tx, await tx.mitigationVersion.findMany({ where: { id }, select: MITIGATION_SELECT })), `mitigation version ${id}`);
}

type MitigationWrite = {
  projectId: string; findingId: string;
  /** null: a new mitigation (route 6); otherwise the mitigation updated (route 7) with the base the person saw. */
  update: { mitigationId: string; baseVersionNumber: number; changeNote: string | null } | null;
  req: AddMitigationRequest;
};

/**
 * One mitigation version, retry-safe by request id and digest (`idempotentWrite`, 5.3 item 4), inside one transaction in
 * this order: the project is writable; the finding lock; the finding of this project (else 404) and, for an update, the
 * mitigation of this finding (else 404); the finding is open (else 409 `finding_not_open` with who closed it and when);
 * for an update, the current version is not cancelled (cancelled is final, 5.3 item 11) and is the base (else 409
 * `base_version_moved` with the current version, FR-FND-03); the owner is an active member whose role holds
 * `mitigation:write`, one text for a viewer, a former member and a stranger alike, so the answer does not reveal
 * membership; `followsControl` is a control of the running content; a due date moved later carries a change note; the
 * evidence is of this project. The version is entered by the session's account and role; the database sets the
 * received time. FINDING_CLOSED is logged after the commit when the version closed the finding.
 */
async function writeMitigation(ctx: OrgContext, actor: Actor, w: MitigationWrite, digest: string): Promise<WriteOutcome<MitigationVersionView>> {
  const { req } = w;
  let closed = false;
  let outcome: WriteOutcome<MitigationVersionView>;
  try {
    outcome = await idempotentWrite(ctx, {
      table: 'mitigation_versions', requestId: req.requestId, digest, actorUserId: actor.userId, replay: mitigationViewById,
      write: async (tx) => {
        await assertProjectWritable(tx, w.projectId);
        await lockFinding(tx, w.findingId);
        const record = await loadFinding(tx, w.projectId, w.findingId);
        let current: MitigationRow | null = null;
        if (w.update !== null) {
          const mitigationId = w.update.mitigationId;
          current = record.current.find((m) => m.mitigationId === mitigationId) ?? null;
          if (current === null) throw new NotFoundError();
        }
        if (record.state !== 'open') throw new ConflictError('finding_not_open', await closedConflict(tx, record));
        if (w.update !== null && current !== null) {
          if (current.status === 'cancelled') throw new ValidationFailed([{ field: 'status', message: FINDING_MESSAGES.cancelledFinal }]);
          if (w.update.baseVersionNumber !== current.versionNumber) {
            throw new ConflictError('base_version_moved', one(await mitigationViews(tx, [current]), `mitigation version ${current.id}`));
          }
        }
        const errors: FieldError[] = [];
        if (!(await mayOwnMitigation(tx, req.ownerUserId))) errors.push({ field: 'ownerUserId', message: FINDING_MESSAGES.ownerUserId });
        if (req.followsControl !== null && !runningContent().controls.has(req.followsControl)) {
          errors.push({ field: 'followsControl', message: FINDING_MESSAGES.followsControl });
        }
        if (current !== null && w.update !== null && w.update.changeNote === null && req.dueDate > day(current.dueDate)) {
          errors.push({ field: 'changeNote', message: FINDING_MESSAGES.changeNote });
        }
        if (errors.length > 0) throw new ValidationFailed(errors);
        await assertEvidenceAttachable(tx, w.projectId, req.evidenceIds);
        const created = await tx.mitigationVersion.create({
          data: {
            orgId: ctx.orgId, findingId: w.findingId, mitigationId: w.update?.mitigationId ?? randomUUID(),
            versionNumber: (current?.versionNumber ?? 0) + 1, baseVersionNumber: w.update?.baseVersionNumber ?? null,
            what: req.what, changeNote: w.update?.changeNote ?? null, ownerUserId: req.ownerUserId,
            dueDate: new Date(`${req.dueDate}T00:00:00.000Z`), status: req.status,
            // An update keeps the mitigation's kind, as acceptRisk's cancelled versions do, so a decision closure is not relabelled.
            kind: current?.kind ?? 'action', followsControl: req.followsControl,
            closureNote: req.closureNote, closureDecisionVersionId: null, cancelReason: req.cancelReason,
            enteredById: actor.userId, enteredByRole: actor.role, findingSeq: await nextFindingSeq(tx, w.findingId),
            requestId: req.requestId, requestDigest: digest,
          },
          select: { id: true },
        });
        if (req.evidenceIds.length > 0) {
          await tx.mitigationEvidence.createMany({ data: req.evidenceIds.map((evidenceId) => ({ orgId: ctx.orgId, versionId: created.id, evidenceId })) });
        }
        closed = (await loadFinding(tx, w.projectId, w.findingId)).state === 'closed_mitigation';
        return mitigationViewById(tx, created.id);
      },
    });
  } catch (e) {
    // idempotentWrite rethrows an attempt's own error only when no row holds this request id, so a violation of the
    // numbering index here is another write that took the number first (5.3 item 3): the conflict it is, with the current version.
    if (w.update !== null && isUniqueViolation(e) && uniqueViolationIndex(e) === MITIGATION_VERSION_INDEX) {
      throw await mitigationMoved(ctx, w, e);
    }
    throw e;
  }
  if (!outcome.replayed && closed) logClosed(ctx, actor, w.findingId, 'closed_mitigation');
  return outcome;
}

/**
 * The 409 for a base that is not the current version, carrying the mitigation's current version read anew, of this
 * finding and project. Every writer takes the finding lock, so this backstop fires only for a writer that did not.
 * With no version past the base to show, the violation is not a lost race, and is rethrown unchanged.
 */
async function mitigationMoved(ctx: OrgContext, w: MitigationWrite, violation: unknown): Promise<unknown> {
  const update = w.update as NonNullable<MitigationWrite['update']>;
  const cur = await withOrg(ctx, async (tx) => {
    const row = await tx.mitigationVersion.findFirst({
      where: { mitigationId: update.mitigationId, findingId: w.findingId, finding: { projectId: w.projectId } },
      select: MITIGATION_SELECT, orderBy: { versionNumber: 'desc' },
    });
    return row === null || row.versionNumber <= update.baseVersionNumber ? null : one(await mitigationViews(tx, [row]), `mitigation ${update.mitigationId}`);
  });
  if (cur === null) return violation;
  return new ConflictError('base_version_moved', cur);
}

/** Route 6: version 1 of a new mitigation of an open finding (FR-FND-03, FR-FND-04). */
export async function addMitigation(
  ctx: OrgContext, actor: Actor, a: AddMitigationRequest & { projectId: string; findingId: string }, digest: string,
): Promise<WriteOutcome<MitigationVersionView>> {
  assertCan(ctx, 'mitigation:write');
  return writeMitigation(ctx, actor, { projectId: a.projectId, findingId: a.findingId, update: null, req: parseAddMitigation(a) }, digest);
}

/** Route 7: the next version of a mitigation, based on the version the person last saw (FR-FND-03, IC-7). */
export async function updateMitigation(
  ctx: OrgContext, actor: Actor,
  a: UpdateMitigationRequest & { projectId: string; findingId: string; mitigationId: string }, digest: string,
): Promise<WriteOutcome<MitigationVersionView>> {
  assertCan(ctx, 'mitigation:write');
  const req = parseUpdateMitigation(a);
  return writeMitigation(ctx, actor, {
    projectId: a.projectId, findingId: a.findingId, req,
    update: { mitigationId: a.mitigationId, baseVersionNumber: req.baseVersionNumber, changeNote: req.changeNote },
  }, digest);
}

// ─── Accepted risks (FR-FND-05) ──────────────────────────────────────────────────────────────────

async function riskViewById(tx: TenantTx, id: string): Promise<AcceptedRiskView> {
  return one(await riskViews(tx, await tx.acceptedRisk.findMany({ where: { id }, select: RISK_SELECT })), `accepted risk ${id}`);
}

/**
 * Route 8 (FR-FND-05): `accept` closes an open finding as an accepted risk; `keep_accepted` records "Looked at again: keep
 * accepted" on a finding closed by one, a new accepted risk that becomes the current one. Any other state answers 409
 * `finding_not_open` with who closed it and when (7.4.4), or `finding_already_open` for `keep_accepted` on an open
 * finding. Under the finding lock, in one transaction: the accepted risk, entered by the session's account and role,
 * with `accepterRole` the role at the time of a member who accepted (a current member, else 422; an outside role is
 * stored as itself); then, for every mitigation whose current version is planned or in progress, a cancelled version
 * with reason "risk accepted" based on it (5.3 item 11 rule 2), whose request id is
 * `derivedRequestId(requestId, 'mitigation_versions:' + mitigationId)`. RISK_ACCEPTED, and for `accept` FINDING_CLOSED,
 * are logged after the commit.
 */
export async function acceptRisk(
  ctx: OrgContext, actor: Actor, a: AcceptRiskRequest & { projectId: string; findingId: string }, digest: string,
): Promise<WriteOutcome<AcceptedRiskView>> {
  assertCan(ctx, 'risk:accept');
  const req = parseAcceptRisk(a);
  const outcome = await idempotentWrite(ctx, {
    table: 'accepted_risks', requestId: req.requestId, digest, actorUserId: actor.userId, replay: riskViewById,
    write: async (tx) => {
      await assertProjectWritable(tx, a.projectId);
      await lockFinding(tx, a.findingId);
      const record = await loadFinding(tx, a.projectId, a.findingId);
      const wanted: FindingState = req.mode === 'accept' ? 'open' : 'closed_accepted_risk';
      if (record.state !== wanted) {
        if (record.state === 'open') throw new ConflictError('finding_already_open');
        throw new ConflictError('finding_not_open', await closedConflict(tx, record));
      }
      let accepterRole: OrgRole | null = null;
      if (req.acceptedBy.kind === 'member') {
        const userId = req.acceptedBy.userId;
        const m = await tx.membership.findFirst({ where: { userId }, select: { role: true } });
        if (m === null) throw new ValidationFailed([{ field: 'acceptedBy', message: FINDING_MESSAGES.acceptedBy }]);
        accepterRole = m.role;
      }
      const created = await tx.acceptedRisk.create({
        data: {
          orgId: ctx.orgId, findingId: a.findingId,
          acceptedByUserId: req.acceptedBy.kind === 'member' ? req.acceptedBy.userId : null,
          acceptedByRole: req.acceptedBy.kind === 'outside_role' ? req.acceptedBy.role : null,
          accepterRole, reason: req.reason, lookAgainNote: req.lookAgainNote,
          lookAgainOn: req.lookAgainOn === null ? null : new Date(`${req.lookAgainOn}T00:00:00.000Z`),
          enteredById: actor.userId, enteredByRole: actor.role, findingSeq: await nextFindingSeq(tx, a.findingId),
          requestId: req.requestId, requestDigest: digest,
        },
        select: { id: true },
      });
      for (const m of record.current.filter(isOpenWork)) {
        await tx.mitigationVersion.create({
          data: {
            orgId: ctx.orgId, findingId: a.findingId, mitigationId: m.mitigationId, versionNumber: m.versionNumber + 1,
            baseVersionNumber: m.versionNumber, what: m.what, changeNote: null, ownerUserId: m.ownerUserId, dueDate: m.dueDate,
            status: 'cancelled', kind: m.kind, followsControl: m.followsControl, closureNote: null, closureDecisionVersionId: null,
            cancelReason: RISK_ACCEPTED_REASON, enteredById: actor.userId, enteredByRole: actor.role,
            findingSeq: await nextFindingSeq(tx, a.findingId),
            requestId: derivedRequestId(req.requestId, 'mitigation_versions:' + m.mitigationId), requestDigest: digest,
          },
        });
      }
      return riskViewById(tx, created.id);
    },
  });
  if (!outcome.replayed) {
    logSecurityEvent('RISK_ACCEPTED', 'info', {
      userId: actor.userId, details: { orgId: ctx.orgId, findingId: a.findingId, acceptedRiskId: outcome.value.id },
    });
    if (req.mode === 'accept') logClosed(ctx, actor, a.findingId, 'closed_accepted_risk');
  }
  return outcome;
}

// ─── Finding events (FR-FND-07) ──────────────────────────────────────────────────────────────────

async function eventViewById(tx: TenantTx, id: string): Promise<FindingEventView> {
  return one(await eventViews(tx, await tx.findingEvent.findMany({ where: { id }, select: EVENT_SELECT })), `finding event ${id}`);
}

/**
 * One finding event, retry-safe (`idempotentWrite` on `finding_events`, replayed only as an event of the same kind), under the finding lock: the project is writable,
 * the finding is of this project (else 404), `refuse` passes on the finding as it stands, and the event is recorded with
 * the reason, by the session's account, with the next findingSeq (the database sets the time).
 */
async function writeEvent(
  ctx: OrgContext, actor: Actor, a: FindingEventRequest & { projectId: string; findingId: string }, digest: string,
  kind: FindingEventKind, refuse: (tx: TenantTx, r: FindingRecord) => Promise<void> | void,
): Promise<WriteOutcome<FindingEventView>> {
  const req = parseFindingEvent(a);
  // Routes 9 and 10 take the same body and path, so their digests are equal and both key on finding_events: a request
  // id first used for the other kind is the changed-request refusal, never a replay of the other action (5.3 item 4).
  const replay = async (tx: TenantTx, id: string): Promise<FindingEventView> => {
    const seen = await eventViewById(tx, id);
    if (seen.kind !== kind) throw new AppError(409, 'request_id_reused');
    return seen;
  };
  return idempotentWrite(ctx, {
    table: 'finding_events', requestId: req.requestId, digest, actorUserId: actor.userId, replay,
    write: async (tx) => {
      await assertProjectWritable(tx, a.projectId);
      await lockFindingAndQuestion(tx, a.projectId, a.findingId);
      await refuse(tx, await loadFinding(tx, a.projectId, a.findingId));
      const created = await tx.findingEvent.create({
        data: {
          orgId: ctx.orgId, findingId: a.findingId, kind, eventCode: null, reason: req.reason, byId: actor.userId,
          findingSeq: await nextFindingSeq(tx, a.findingId), requestId: req.requestId, requestDigest: digest,
        },
        select: { id: true },
      });
      return eventViewById(tx, created.id);
    },
  });
}

/**
 * Route 9 (FR-FND-07): reopen a closed finding with a reason. Its earlier accepted risks and done mitigations count no
 * longer (5.3 item 11's R); they stay in its history. A withdrawn finding cannot be reopened (409 `finding_withdrawn`),
 * nor an open one (409 `finding_already_open`, gap G062).
 */
export async function reopenFinding(
  ctx: OrgContext, actor: Actor, a: FindingEventRequest & { projectId: string; findingId: string }, digest: string,
): Promise<WriteOutcome<FindingEventView>> {
  assertCan(ctx, 'finding:reopen');
  return writeEvent(ctx, actor, a, digest, 'reopened', async (tx, r) => {
    if (r.state === 'withdrawn') throw new ConflictError('finding_withdrawn');
    if (r.state === 'open') throw new ConflictError('finding_already_open');
    // FR-FND-01 keeps one open shortfall per question: with another one open, this one stays closed (ruling SFH-3).
    if (r.finding.source === 'shortfall') {
      const others = await loadRecords(tx, {
        projectId: a.projectId, questionId: r.finding.questionId, source: 'shortfall', id: { not: r.finding.id },
      });
      if (others.some((o) => o.state === 'open')) throw new ConflictError('finding_already_open');
    }
  });
}

/**
 * Route 10 (FR-FND-07, R-9): withdraw a team finding raised in error, with a reason. A shortfall finding cannot be
 * withdrawn (409 `cannot_withdraw_shortfall`: its decision is withdrawn instead, FR-DEC-08); a withdrawn one answers 409
 * `finding_withdrawn`. The object rule (S-15 row, SRS line 1608) is judged on the finding read under the lock: its
 * raiser, an owner or an admin may withdraw it; anyone else holding `finding:withdraw` gets 403 `forbidden`. A withdrawn
 * finding never counts as closed (5.3 item 11 rule 1).
 */
export async function withdrawFinding(
  ctx: OrgContext, actor: Actor, a: FindingEventRequest & { projectId: string; findingId: string }, digest: string,
): Promise<WriteOutcome<FindingEventView>> {
  assertCan(ctx, 'finding:withdraw');
  return writeEvent(ctx, actor, a, digest, 'withdrawn', (_tx, r) => {
    if (r.finding.source === 'shortfall') throw new ConflictError('cannot_withdraw_shortfall');
    if (r.state === 'withdrawn') throw new ConflictError('finding_withdrawn');
    if (actor.role !== 'owner' && actor.role !== 'admin' && r.finding.raisedById !== actor.userId) {
      throw new ForbiddenError('finding:withdraw', actor.role);
    }
  });
}

/**
 * Route 11 (FR-FND-06, FR-DEC-08): the one action that closes an open shortfall finding by the decision that resolved it.
 * Under the finding lock: the finding of this project is open (else 409 `finding_not_open`) and the request names the
 * decision version `findingsToCloseByDecision` gives for it, read in the same transaction (else 422 on
 * `decisionVersionId`, one fixed text for a version that does not qualify, is stale or is of another organisation). It
 * inserts version 1 of a new mitigation: kind `decision_withdrawn` for a withdrawal, otherwise `decision_changed`; status
 * done; owned by the person acting; due today (East Africa Time); no `what`; `closureDecisionVersionId` the version.
 * FINDING_CLOSED is logged after the commit when it closed the finding.
 */
export async function closeByDecision(
  ctx: OrgContext, actor: Actor, a: CloseByDecisionRequest & { projectId: string; findingId: string }, digest: string,
): Promise<WriteOutcome<MitigationVersionView>> {
  assertCan(ctx, 'mitigation:write');
  const req = parseCloseByDecision(a);
  let closed = false;
  const outcome = await idempotentWrite(ctx, {
    table: 'mitigation_versions', requestId: req.requestId, digest, actorUserId: actor.userId, replay: mitigationViewById,
    write: async (tx) => {
      await assertProjectWritable(tx, a.projectId);
      await lockFinding(tx, a.findingId);
      const record = await loadFinding(tx, a.projectId, a.findingId);
      if (record.state !== 'open') throw new ConflictError('finding_not_open', await closedConflict(tx, record));
      const closure = (await decisionClosures(tx, a.projectId, [record])).get(a.findingId);
      if (closure === undefined || closure.decisionVersionId !== req.decisionVersionId) {
        throw new ValidationFailed([{ field: 'decisionVersionId', message: FINDING_MESSAGES.decisionVersionId }]);
      }
      const created = await tx.mitigationVersion.create({
        data: {
          orgId: ctx.orgId, findingId: a.findingId, mitigationId: randomUUID(), versionNumber: 1, baseVersionNumber: null,
          what: null, changeNote: null, ownerUserId: actor.userId, dueDate: new Date(`${eatDate(new Date())}T00:00:00.000Z`),
          status: 'done', kind: closure.reason === 'decision_withdrawn' ? 'decision_withdrawn' : 'decision_changed', followsControl: null,
          closureNote: null, closureDecisionVersionId: closure.decisionVersionId, cancelReason: null,
          enteredById: actor.userId, enteredByRole: actor.role, findingSeq: await nextFindingSeq(tx, a.findingId),
          requestId: req.requestId, requestDigest: digest,
        },
        select: { id: true },
      });
      closed = (await loadFinding(tx, a.projectId, a.findingId)).state === 'closed_mitigation';
      return mitigationViewById(tx, created.id);
    },
  });
  if (!outcome.replayed && closed) logClosed(ctx, actor, a.findingId, 'closed_mitigation');
  return outcome;
}

/**
 * S-14's list (UX-15): the project's findings, of one stage when given, oldest raised first, each with its derived state;
 * `today` sets `overdueMitigations` and defaults to `eatDate(new Date())` (overdue is decided in East Africa Time, FR-FUP-02).
 */
export async function listFindings(
  ctx: OrgContext, projectId: string, stage?: Stage, today?: CalendarDate,
): Promise<FindingView[]> {
  return withOrg(ctx, async (tx) => findingViews(
    tx, await loadRecords(tx, stage === undefined ? { projectId } : { projectId, stage }), today ?? eatDate(new Date()),
  ));
}

/** Active members whose current role holds `mitigation:write`, sorted by name (UX-16; gap G059): FND-b's owner select. */
export async function mitigationOwnerCandidates(ctx: OrgContext): Promise<UserRef[]> {
  return withOrg(ctx, async (tx) => {
    const members = await tx.membership.findMany({ where: { status: 'active' }, select: { userId: true, role: true } });
    const owners = members.filter((m) => can(m.role, 'mitigation:write'));
    const person = await people(tx, owners.map((m) => m.userId));
    return owners.map((m) => person(`membership of ${m.userId}`, m.userId))
      .sort((x, y) => x.name.localeCompare(y.name) || x.userId.localeCompare(y.userId));
  });
}

/**
 * S-15's read (FR-FND-03 to 07): the finding, each mitigation's current version and version count, the current accepted
 * risk (null after a reopen) and every accepted risk newest first (gap G058), the events, and the seals that include the
 * finding (REV-a's `sealsIncludingRows`). A finding of another project or organisation is not found.
 */
export async function findingDetail(
  ctx: OrgContext, projectId: string, findingId: string,
): Promise<FindingDetailView> {
  const detail = await withOrg(ctx, async (tx) => {
    const record = await loadFinding(tx, projectId, findingId);
    const [[view], currents, risks, events] = await Promise.all([
      findingViews(tx, [record], eatDate(new Date())),
      mitigationViews(tx, record.current),
      riskViews(tx, [...record.risks].reverse()),
      eventViews(tx, record.events),
    ]);
    const count = (mitigationId: string) => record.versions.filter((v) => v.mitigationId === mitigationId).length;
    const active = currentRisk(record);
    return {
      ...view,
      mitigations: currents.map((current) => ({ mitigationId: current.mitigationId, current, versions: count(current.mitigationId) })),
      acceptedRisk: active === null ? null : one(risks.filter((r) => r.id === active.id), `current accepted risk of finding ${findingId}`),
      acceptedRisks: risks,
      events,
    };
  });
  const seals = (await sealsIncludingRows(ctx, [findingId])).get(findingId) ?? [];
  return { ...detail, seals };
}

/** Every version of the mitigation, newest first, with change notes (5.2 "finding history (S-15)", SRS line 1248); none for a mitigation of another project. */
export async function mitigationHistory(
  ctx: OrgContext, projectId: string, mitigationId: string,
): Promise<MitigationVersionView[]> {
  return withOrg(ctx, async (tx) => mitigationViews(tx, await tx.mitigationVersion.findMany({
    where: { mitigationId, finding: { projectId } }, select: MITIGATION_SELECT, orderBy: { versionNumber: 'desc' },
  })));
}

// ─── Closing by a decision (FR-FND-06, FR-DEC-08) ────────────────────────────────────────────────

type DecisionClosure = { reason: 'decision_done' | 'decision_withdrawn' | 'gate_no'; decisionVersionId: string };

/** The current (highest-numbered) decision version of each question of the project named, a withdrawal included (5.3 item 2). */
async function currentVersions(
  tx: TenantTx, projectId: string, questionIds: readonly string[],
): Promise<Map<string, { id: string; status: string | null; scopeAnswer: string | null; baseVersionNumber: number | null }>> {
  const ids = [...new Set(questionIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx.decisionVersion.findMany({
    where: { projectId, questionId: { in: ids } }, distinct: ['questionId'], orderBy: [{ questionId: 'asc' }, { versionNumber: 'desc' }],
    select: { id: true, questionId: true, status: true, scopeAnswer: true, baseVersionNumber: true },
  });
  return new Map(rows.map((r) => [r.questionId, r]));
}

/**
 * The decision that now closes each open shortfall finding of `records`, by FR-FND-06 and FR-DEC-08, in this order: its
 * question's current version is done or not applicable (`decision_done`, that version); it is a withdrawal of the
 * version that raised the finding (`decision_withdrawn`, the withdrawal); the question carries a condition on a gate (in
 * the running content, FR-CNT-04) whose current version answers "no" (`gate_no`, the gate's version). Others are absent.
 */
async function decisionClosures(tx: TenantTx, projectId: string, records: readonly FindingRecord[]): Promise<Map<string, DecisionClosure>> {
  const open = records.filter((r) => r.state === 'open' && r.finding.source === 'shortfall' && r.finding.questionId !== null);
  const out = new Map<string, DecisionClosure>();
  if (open.length === 0) return out;
  const content = runningContent();
  const gateOf = (questionId: string) => content.questions.get(questionId)?.condition?.questionId ?? null;
  const questions = open.map((r) => r.finding.questionId as string);
  const gates = questions.map(gateOf).filter((g): g is string => g !== null);
  const [current, raising] = await Promise.all([
    currentVersions(tx, projectId, [...questions, ...gates]),
    tx.decisionVersion.findMany({
      where: { id: { in: open.map((r) => r.finding.decisionVersionId as string) } }, select: { id: true, versionNumber: true },
    }),
  ]);
  const raisedBy = new Map(raising.map((v) => [v.id, v.versionNumber]));
  for (const r of open) {
    const questionId = r.finding.questionId as string;
    const cur = current.get(questionId);
    const gate = gateOf(questionId);
    const gateNow = gate === null ? undefined : current.get(gate);
    if (cur !== undefined && (cur.status === 'done' || cur.status === 'not_applicable')) {
      out.set(r.finding.id, { reason: 'decision_done', decisionVersionId: cur.id });
    } else if (cur !== undefined && cur.status === 'withdrawn' && cur.baseVersionNumber !== null
      && cur.baseVersionNumber === raisedBy.get(r.finding.decisionVersionId as string)) {
      out.set(r.finding.id, { reason: 'decision_withdrawn', decisionVersionId: cur.id });
    } else if (gateNow !== undefined && gateNow.scopeAnswer === 'no') {
      out.set(r.finding.id, { reason: 'gate_no', decisionVersionId: gateNow.id });
    }
  }
  return out;
}

/**
 * S-14's "Decision now done: close it" and "Decision withdrawn: close it" (FR-FND-06, FR-DEC-08, UX-15): the open shortfall
 * findings of the project that a decision now closes, each with the reason and the decision version that closes it.
 * Nothing closes automatically: a person acts on each with `closeByDecision`.
 */
export async function findingsToCloseByDecision(
  ctx: OrgContext, projectId: string,
): Promise<Array<FindingView & DecisionClosure>> {
  return withOrg(ctx, async (tx) => {
    const records = await loadRecords(tx, { projectId, source: 'shortfall' });
    const closures = await decisionClosures(tx, projectId, records);
    const listed = records.filter((r) => closures.has(r.finding.id));
    const views = await findingViews(tx, listed, eatDate(new Date()));
    return views.map((v) => ({ ...v, ...(closures.get(v.id) as DecisionClosure) }));
  });
}

/**
 * S-14's "Accepted risks to look at again" (FR-FND-05, UX-15): findings of the project closed by an accepted risk whose
 * current accepted risk has a look-again date of `today` or earlier. A "keep accepted" with a later date takes the
 * finding off the list until then; a reopen makes the earlier acceptance count no longer (FR-FND-07).
 */
export async function acceptedRisksToLookAgain(
  ctx: OrgContext, projectId: string, today: CalendarDate,
): Promise<FindingView[]> {
  return withOrg(ctx, async (tx) => {
    const due = (await loadRecords(tx, { projectId })).filter((r) => {
      const risk = r.state === 'closed_accepted_risk' ? currentRisk(r) : null;
      return risk !== null && risk.lookAgainOn !== null && day(risk.lookAgainOn) <= today;
    });
    return findingViews(tx, due, today);
  });
}

/** The question's open shortfall finding, or null; team findings never count (FR-FND-02). S-12 links to it (UX-09). */
export async function openShortfallForQuestion(
  ctx: OrgContext, projectId: string, questionId: string,
): Promise<{ findingId: string } | null> {
  return withOrg(ctx, async (tx) => {
    const records = await loadRecords(tx, { projectId, questionId, source: 'shortfall' }, BY_RAISING_VERSION);
    const open = records.filter((r) => r.state === 'open');
    // The latest raised, should a reopen of an older one have left two open.
    const last = open.at(-1);
    return last === undefined ? null : { findingId: last.finding.id };
  });
}
