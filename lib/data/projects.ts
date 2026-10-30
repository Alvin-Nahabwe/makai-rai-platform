/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producer replaces the file's bodies. */
import type { OrgContext, TenantTx } from '@/lib/data/tenant';
import type { Actor, CalendarDate, Stage } from '@/types/record';
import type { StageCounts } from '@/types/api';
import { NotImplementedError } from '@/lib/http/errors';

/** Projects, archive, stage view and dashboard (FR-PRJ). Typed stubs until the producer merges. */

const ZERO_COUNTS: StageCounts = {
  questions: 0, noDecision: 0, byStatus: { done: 0, partly: 0, not_yet: 0, not_applicable: 0 },
  doneWithoutEvidence: 0, openFindings: 0, openFindingsWithoutMitigation: 0, openMitigations: 0,
  overdueMitigations: 0, acceptedRisks: 0, documentsIssued: 0, notApplicableByGate: 0,
};

/** Zero counts for each stage. */
// CONTRACT_STUB: PRJ
export async function stageView(
  ctx: OrgContext, projectId: string, today: CalendarDate,
): Promise<Record<Stage, StageCounts>> {
  return {
    'pre-processing': { ...ZERO_COUNTS, byStatus: { ...ZERO_COUNTS.byStatus } },
    'in-processing': { ...ZERO_COUNTS, byStatus: { ...ZERO_COUNTS.byStatus } },
    'post-processing': { ...ZERO_COUNTS, byStatus: { ...ZERO_COUNTS.byStatus } },
  };
}

// CONTRACT_STUB: PRJ
export async function archiveProject(ctx: OrgContext, actor: Actor, projectId: string): Promise<void> {
  throw new NotImplementedError('PRJ');
}

// CONTRACT_STUB: PRJ
export async function unarchiveProject(ctx: OrgContext, actor: Actor, projectId: string): Promise<void> {
  throw new NotImplementedError('PRJ');
}

/** A guard: it throws, because an empty answer would read as "no records". */
// CONTRACT_STUB: PRJ
export async function projectHasRecords(tx: TenantTx, projectId: string): Promise<boolean> {
  throw new NotImplementedError('PRJ');
}
