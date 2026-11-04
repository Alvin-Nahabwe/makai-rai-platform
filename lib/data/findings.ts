/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producer replaces the file's bodies. */
import type { Prisma } from '@prisma/client';
import { withOrg, NotFoundError, type OrgContext, type TenantTx } from '@/lib/data/tenant';
import type {
  Actor, CalendarDate, FindingEventKind, FindingSource, FindingState, MitigationKind, MitigationStatus, Stage, StoredDecisionStatus,
  WriteOutcome,
} from '@/types/record';
import type {
  AcceptedRiskView, AcceptRiskRequest, AddMitigationRequest, CloseByDecisionRequest, FindingDetailView,
  FindingEventRequest, FindingEventView, FindingView, MitigationVersionView, UpdateMitigationRequest, UserRef,
} from '@/types/api';
import { NotImplementedError } from '@/lib/http/errors';
import { derivedRequestId } from '@/lib/data/idempotency';
import { deriveFindingState } from '@/lib/findings/state';

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
  if (accepted === null) return true;
  const fixedSince = await tx.decisionVersion.count({
    where: { ...at, versionNumber: { gt: accepted.versionNumber, lt: own.versionNumber }, status: { in: ['done', 'not_applicable'] } },
  });
  if (fixedSince > 0) return true;
  const was = accepted.status === null ? undefined : SHORTFALL_RANK[accepted.status];
  const now = version.status === null ? undefined : SHORTFALL_RANK[version.status];
  return was === undefined || now === undefined || now > was;
}

// CONTRACT_STUB: FND-a
export async function addMitigation(
  ctx: OrgContext, actor: Actor, a: AddMitigationRequest & { projectId: string; findingId: string }, digest: string,
): Promise<WriteOutcome<MitigationVersionView>> {
  throw new NotImplementedError('FND-a');
}

// CONTRACT_STUB: FND-a
export async function updateMitigation(
  ctx: OrgContext, actor: Actor,
  a: UpdateMitigationRequest & { projectId: string; findingId: string; mitigationId: string }, digest: string,
): Promise<WriteOutcome<MitigationVersionView>> {
  throw new NotImplementedError('FND-a');
}

/** Each mitigation version it cancels carries `derivedRequestId(requestId, 'mitigation_versions:' + mitigationId)`. */
// CONTRACT_STUB: FND-a
export async function acceptRisk(
  ctx: OrgContext, actor: Actor, a: AcceptRiskRequest & { projectId: string; findingId: string }, digest: string,
): Promise<WriteOutcome<AcceptedRiskView>> {
  throw new NotImplementedError('FND-a');
}

// CONTRACT_STUB: FND-a
export async function reopenFinding(
  ctx: OrgContext, actor: Actor, a: FindingEventRequest & { projectId: string; findingId: string }, digest: string,
): Promise<WriteOutcome<FindingEventView>> {
  throw new NotImplementedError('FND-a');
}

// CONTRACT_STUB: FND-a
export async function withdrawFinding(
  ctx: OrgContext, actor: Actor, a: FindingEventRequest & { projectId: string; findingId: string }, digest: string,
): Promise<WriteOutcome<FindingEventView>> {
  throw new NotImplementedError('FND-a');
}

// CONTRACT_STUB: FND-a
export async function closeByDecision(
  ctx: OrgContext, actor: Actor, a: CloseByDecisionRequest & { projectId: string; findingId: string }, digest: string,
): Promise<WriteOutcome<MitigationVersionView>> {
  throw new NotImplementedError('FND-a');
}

/** `today` sets `overdueMitigations`; the default is `eatDate(new Date())`. */
// CONTRACT_STUB: FND-a
export async function listFindings(
  ctx: OrgContext, projectId: string, stage?: Stage, today?: CalendarDate,
): Promise<FindingView[]> {
  return [];
}

/** Current members whose role holds `mitigation:write`, sorted by name (UX-16). */
// CONTRACT_STUB: FND-a
export async function mitigationOwnerCandidates(ctx: OrgContext): Promise<UserRef[]> {
  return [];
}

// CONTRACT_STUB: FND-a
export async function findingDetail(
  ctx: OrgContext, projectId: string, findingId: string,
): Promise<FindingDetailView> {
  throw new NotImplementedError('FND-a');
}

/** Every version, newest first, with change notes. */
// CONTRACT_STUB: FND-a
export async function mitigationHistory(
  ctx: OrgContext, projectId: string, mitigationId: string,
): Promise<MitigationVersionView[]> {
  return [];
}

// CONTRACT_STUB: FND-a
export async function findingsToCloseByDecision(
  ctx: OrgContext, projectId: string,
): Promise<Array<FindingView & { reason: 'decision_done' | 'decision_withdrawn' | 'gate_no'; decisionVersionId: string }>> {
  return [];
}

// CONTRACT_STUB: FND-a
export async function acceptedRisksToLookAgain(
  ctx: OrgContext, projectId: string, today: CalendarDate,
): Promise<FindingView[]> {
  return [];
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
