/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producer replaces the file's bodies. */
import type { OrgContext, TenantTx } from '@/lib/data/tenant';
import type { Actor, CalendarDate, Stage, StoredDecisionStatus, WriteOutcome } from '@/types/record';
import type {
  AcceptedRiskView, AcceptRiskRequest, AddMitigationRequest, CloseByDecisionRequest, FindingDetailView,
  FindingEventRequest, FindingEventView, FindingView, MitigationVersionView, UpdateMitigationRequest, UserRef,
} from '@/types/api';
import { NotImplementedError } from '@/lib/http/errors';

/** Findings rules, mitigations, accepted risks, events and lists (FR-FND-01, 03 to 07). Typed stubs until the producer merges. */

/**
 * Called by the decision service inside its save transaction (SRS 9.4). A finding it creates carries
 * `derivedRequestId(request.requestId, 'findings:' + version.id)` and `request.digest`. Returns `null`, not
 * a throw: decision saves must work before the producer merges.
 */
// CONTRACT_STUB: FND-a
export async function onShortfallSaved(
  tx: TenantTx,
  ctx: OrgContext,
  version: { id: string; projectId: string; stage: Stage; questionId: string; status: StoredDecisionStatus | null; enteredById: string },
  request: { requestId: string; digest: string },
): Promise<{ findingId: string } | null> {
  return null;
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

// CONTRACT_STUB: FND-a
export async function openShortfallForQuestion(
  ctx: OrgContext, projectId: string, questionId: string,
): Promise<{ findingId: string } | null> {
  return null;
}
