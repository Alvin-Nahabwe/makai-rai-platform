/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producer replaces the file's bodies. */
import type { OrgContext, TenantTx } from '@/lib/data/tenant';
import type { Actor, DecisionVersionRow, Stage, WriteOutcome } from '@/types/record';
import type { DecisionVersionView, SaveDecisionRequest, WithdrawDecisionRequest } from '@/types/api';
import { NotImplementedError } from '@/lib/http/errors';

/** Decision service (FR-DEC-01 to 05, 07 to 09). Typed stubs until the producer merges (contract, "Typed stubs"). */

// CONTRACT_STUB: DEC-a
export async function saveDecision(
  ctx: OrgContext, actor: Actor, a: SaveDecisionRequest & { projectId: string }, digest: string,
): Promise<WriteOutcome<DecisionVersionView>> {
  throw new NotImplementedError('DEC-a');
}

// CONTRACT_STUB: DEC-a
export async function withdrawDecision(
  ctx: OrgContext, actor: Actor, a: WithdrawDecisionRequest & { projectId: string; questionId: string }, digest: string,
): Promise<WriteOutcome<DecisionVersionView>> {
  throw new NotImplementedError('DEC-a');
}

/** Key: question id. A withdrawal is a current version. */
// CONTRACT_STUB: DEC-a
export async function currentDecisions(
  ctx: OrgContext, projectId: string, stage: Stage,
): Promise<Map<string, DecisionVersionView>> {
  return new Map();
}

/** Newest first. */
// CONTRACT_STUB: DEC-a
export async function decisionHistory(
  ctx: OrgContext, projectId: string, questionId: string,
): Promise<DecisionVersionView[]> {
  return [];
}

// CONTRACT_STUB: DEC-a
export async function currentDecisionRows(
  tx: TenantTx, projectId: string, stage: Stage,
): Promise<DecisionVersionRow[]> {
  return [];
}
