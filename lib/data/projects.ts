/* eslint-disable @typescript-eslint/no-unused-vars -- the contract's parameter names stay: `actor` (the SRS asks for no event on archive, NFR-OBS-01, so `archivedAt` alone says when) and the stageView stub's. */
import type { OrgContext, TenantTx } from '@/lib/data/tenant';
import type { Actor, CalendarDate, Stage } from '@/types/record';
import type { StageCounts } from '@/types/api';
import { ConflictError } from '@/lib/http/errors';
import { NotFoundError, withOrg } from '@/lib/data/tenant';

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

/**
 * Sets `archivedAt` to the database's `now()` inside the caller's transaction (FR-PRJ-03). The UPDATE takes the row
 * lock, so it waits for a write already in flight (those read the row `FOR SHARE` in `assertProjectWritable`), and a
 * write that starts after it commits sees the archive. A project not visible under row-level security is not found;
 * an archived one answers 409 `already_archived`.
 */
export async function archiveProjectIn(tx: TenantTx, projectId: string): Promise<void> {
  const changed = await tx.$executeRaw`UPDATE "projects" SET "archivedAt" = now() WHERE "id" = ${projectId} AND "archivedAt" IS NULL`;
  if (changed === 1) return;
  await refuseUnchanged(tx, projectId, 'already_archived');
}

/** Clears `archivedAt` inside the caller's transaction; 409 `not_archived` when it is not set. */
export async function unarchiveProjectIn(tx: TenantTx, projectId: string): Promise<void> {
  const changed = await tx.$executeRaw`UPDATE "projects" SET "archivedAt" = NULL WHERE "id" = ${projectId} AND "archivedAt" IS NOT NULL`;
  if (changed === 1) return;
  await refuseUnchanged(tx, projectId, 'not_archived');
}

/** An UPDATE that changed no row: the project is not visible (404) or already in the wanted state (409). */
async function refuseUnchanged(tx: TenantTx, projectId: string, code: 'already_archived' | 'not_archived'): Promise<never> {
  const found = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "projects" WHERE "id" = ${projectId}`;
  if (found.length === 0) throw new NotFoundError();
  throw new ConflictError(code);
}

export async function archiveProject(ctx: OrgContext, actor: Actor, projectId: string): Promise<void> {
  await withOrg(ctx, (tx) => archiveProjectIn(tx, projectId));
}

export async function unarchiveProject(ctx: OrgContext, actor: Actor, projectId: string): Promise<void> {
  await withOrg(ctx, (tx) => unarchiveProjectIn(tx, projectId));
}

/**
 * Every table with a foreign key to `projects`, other than `project_metadata` (which is part of the project and goes
 * with it). A row in any of them makes the project a container of records, and DELETE answers 409
 * `project_has_records` (FR-PRJ-03). The list is pinned to the catalogue by `__tests__/integration/prj-archive.test.ts`.
 */
const TABLES_WITH_RECORDS = [
  'assessments', 'decision_versions', 'document_draft_fields', 'evidence', 'findings', 'issued_documents', 'stage_reviews',
] as const;

/** True when any record table holds a row of the project. Asks inside the caller's `tx`; an error is thrown, never read as "empty". */
export async function projectHasRecords(tx: TenantTx, projectId: string): Promise<boolean> {
  for (const table of TABLES_WITH_RECORDS) {
    // The table name comes from the closed list above, never from input.
    const rows = await tx.$queryRawUnsafe<{ present: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM "${table}" WHERE "projectId" = $1) AS "present"`, projectId);
    if (rows[0].present) return true;
  }
  return false;
}
