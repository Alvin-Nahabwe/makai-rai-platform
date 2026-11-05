import type { OrgContext, TenantTx } from '@/lib/data/tenant';
import { STAGES, type Actor, type CalendarDate, type DecisionStatus, type ScopeAnswer, type Stage } from '@/types/record';
import type { StageCounts } from '@/types/api';
import { ConflictError } from '@/lib/http/errors';
import { NotFoundError, withOrg } from '@/lib/data/tenant';
import { questionApplies, questionsInStage, runningContent } from '@/lib/content/loader';
import { currentDecisionRows } from '@/lib/data/decisions';
import { listFindings } from '@/lib/data/findings';
import { openMitigationsByStage, stageFollowUpCounts } from '@/lib/data/followup';

/** Projects, archive, stage view and dashboard (FR-PRJ). */

const DECISION_STATUSES: readonly DecisionStatus[] = ['done', 'partly', 'not_yet', 'not_applicable'];

/** Issued documents of the project, by the stage of the review each belongs to, that have no `withdrawn` event. */
async function documentsIssuedByStage(tx: TenantTx, projectId: string): Promise<Record<Stage, number>> {
  const rows = await tx.$queryRaw<{ stage: Stage; n: number }[]>`
    SELECT r."stage" AS "stage", count(*)::int AS "n"
    FROM "issued_documents" d JOIN "stage_reviews" r ON r."orgId" = d."orgId" AND r."id" = d."stageReviewId"
    WHERE d."projectId" = ${projectId}
      AND NOT EXISTS (SELECT 1 FROM "document_events" e WHERE e."orgId" = d."orgId" AND e."documentId" = d."id" AND e."kind" = 'withdrawn')
    GROUP BY r."stage"`;
  const out = { 'pre-processing': 0, 'in-processing': 0, 'post-processing': 0 } as Record<Stage, number>;
  for (const r of rows) out[r.stage] = r.n;
  return out;
}

/**
 * The counts S-10 shows for each stage (FR-PRJ-02, FR-PRJ-04). The stage of a decision is the stage it was recorded in,
 * so a decision recorded in post-processing first counts there only (SRS line 670). A question whose gate carries a
 * scope answer that makes it not apply counts in `notApplicableByGate`, not in `noDecision`; a gate that carries a scope
 * answer is itself decided. `openFindings` and `overdueMitigations` come from the follow-up service, the one source
 * S-08, S-10 and S-11 share.
 */
export async function stageView(
  ctx: OrgContext, projectId: string, today: CalendarDate,
): Promise<Record<Stage, StageCounts>> {
  const content = runningContent();
  const { decisions, documents } = await withOrg(ctx, async (tx) => ({
    decisions: Object.fromEntries(await Promise.all(STAGES.map(async (s) => [s, await currentDecisionRows(tx, projectId, s)] as const))),
    documents: await documentsIssuedByStage(tx, projectId),
  })) as { decisions: Record<Stage, Awaited<ReturnType<typeof currentDecisionRows>>>; documents: Record<Stage, number> };
  const open = await openMitigationsByStage(ctx, projectId, today);

  const out = {} as Record<Stage, StageCounts>;
  for (const stage of STAGES) {
    const rows = decisions[stage];
    const current = new Map(rows.map((r) => [r.questionId, r]));
    const questions = questionsInStage(content, stage);
    const byStatus = Object.fromEntries(DECISION_STATUSES.map((st) => [st, 0])) as Record<DecisionStatus, number>;
    for (const r of rows) if (r.status !== null && r.status !== 'withdrawn') byStatus[r.status] += 1;

    let noDecision = 0;
    let notApplicableByGate = 0;
    for (const q of questions) {
      if (q.condition !== undefined) {
        const gate: ScopeAnswer | null = current.get(q.condition.questionId)?.scopeAnswer ?? null;
        if (!questionApplies(content, q.id, gate)) { notApplicableByGate += 1; continue; }
      }
      const row = current.get(q.id);
      if (row !== undefined && row.scopeAnswer !== null) continue;   // an answered gate is decided
      if (row === undefined || row.status === 'withdrawn' || row.status === null) noDecision += 1;
    }

    const [counts, findings] = await Promise.all([
      stageFollowUpCounts(ctx, projectId, stage, today),
      listFindings(ctx, projectId, stage, today),
    ]);
    out[stage] = {
      questions: questions.length, noDecision, byStatus,
      doneWithoutEvidence: rows.filter((r) => r.status === 'done' && r.evidenceIds.length === 0).length,
      openFindings: counts.openFindings,
      openFindingsWithoutMitigation: findings.filter((f) => f.state === 'open' && f.hasNoMitigation).length,
      openMitigations: open[stage].length, overdueMitigations: counts.overdueMitigations,
      acceptedRisks: findings.filter((f) => f.state === 'closed_accepted_risk').length,
      documentsIssued: documents[stage], notApplicableByGate,
    };
  }
  return out;
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
