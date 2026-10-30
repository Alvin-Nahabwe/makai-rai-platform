/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producer replaces the file's bodies. */
import type { OrgContext } from '@/lib/data/tenant';
import type { CalendarDate, Stage } from '@/types/record';
import type { FollowUpItem } from '@/types/api';

/** Follow-up lists (FR-FUP-01, 02, 05). Typed stubs until the producer merges; the lists are empty. */

// CONTRACT_STUB: FUP
export async function openMitigationsByStage(
  ctx: OrgContext, projectId: string, today: CalendarDate,
): Promise<Record<Stage, FollowUpItem[]>> {
  return { 'pre-processing': [], 'in-processing': [], 'post-processing': [] };
}

// CONTRACT_STUB: FUP
export async function myMitigations(
  ctx: OrgContext, userId: string, today: CalendarDate,
): Promise<FollowUpItem[]> {
  return [];
}

// CONTRACT_STUB: FUP
export async function ownerCannotAct(ctx: OrgContext, projectId: string): Promise<FollowUpItem[]> {
  return [];
}

// CONTRACT_STUB: FUP
export async function stageFollowUpCounts(
  ctx: OrgContext, projectId: string, stage: Stage, today: CalendarDate,
): Promise<{ openFindings: number; overdueMitigations: number }> {
  return { openFindings: 0, overdueMitigations: 0 };
}
