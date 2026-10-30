/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producer replaces the file's bodies. */
import type { OrgRole } from '@prisma/client';
import type { OrgContext } from '@/lib/data/tenant';
import type { Actor, DecisionStatus, ScopeAnswer, Stage, WriteOutcome } from '@/types/record';
import type { ChangedSinceSeal, OpenReviewRequest, StageReviewView } from '@/types/api';
import { NotImplementedError } from '@/lib/http/errors';

/** Open a review, list reviews, changed since seal, seal preview (FR-REV-01, 02, 05). Typed stubs until the producer merges. */

export type SealPreview = {
  byStatus: Record<DecisionStatus, number>; byReasonCode: Record<string, number>; noDecision: string[];
  doneWithoutEvidence: number; openFindings: number; openMitigations: number; enteredByPeople: number;
  sealer: { name: string; role: OrgRole }; rewordedSinceDecision: number;
  scopeAnswer: { questionId: string; versionNumber: number; answer: ScopeAnswer } | null;
  evidence: { files: number; links: number };
};

// CONTRACT_STUB: REV-b
export async function openStageReview(
  ctx: OrgContext, actor: Actor, a: OpenReviewRequest & { projectId: string }, digest: string,
): Promise<WriteOutcome<StageReviewView>> {
  throw new NotImplementedError('REV-b');
}

// CONTRACT_STUB: REV-b
export async function listStageReviews(ctx: OrgContext, projectId: string, stage?: Stage): Promise<StageReviewView[]> {
  return [];
}

// CONTRACT_STUB: REV-b
export async function changedSinceSeal(ctx: OrgContext, reviewId: string): Promise<ChangedSinceSeal | null> {
  return null;
}

// CONTRACT_STUB: REV-b
export async function sealPreview(ctx: OrgContext, reviewId: string): Promise<SealPreview> {
  throw new NotImplementedError('REV-b');
}
