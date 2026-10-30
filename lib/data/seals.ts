/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producer replaces the file's bodies. */
import type { OrgContext } from '@/lib/data/tenant';
import type { Actor, WriteOutcome } from '@/types/record';
import type { SealRequest, SealView } from '@/types/api';
import type { SealCheckResult, SealRef } from '@/types/seal';
import { NotImplementedError } from '@/lib/http/errors';

/** Seal builder, seal check and seal lists (FR-REV-03, 04, 06). Typed stubs until the producer merges. */

// CONTRACT_STUB: REV-a
export async function sealStageReview(
  ctx: OrgContext, actor: Actor, a: SealRequest & { projectId: string; reviewId: string }, digest: string,
): Promise<WriteOutcome<SealView>> {
  throw new NotImplementedError('REV-a');
}

// CONTRACT_STUB: REV-a
export async function checkSeal(ctx: OrgContext, sealId: string): Promise<SealCheckResult> {
  throw new NotImplementedError('REV-a');
}

// CONTRACT_STUB: REV-a
export async function listSeals(ctx: OrgContext, reviewId: string): Promise<SealView[]> {
  return [];
}

/** `rowIds`: decision version, finding, mitigation version or accepted risk ids. */
// CONTRACT_STUB: REV-a
export async function sealsIncludingRows(
  ctx: OrgContext, rowIds: readonly string[],
): Promise<Map<string, SealRef[]>> {
  return new Map();
}
