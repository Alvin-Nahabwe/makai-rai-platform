import type { OrgContext, TenantTx } from '@/lib/data/tenant';
import { STAGES, type Actor, type CalendarDate, type DecisionStatus, type ScopeAnswer, type Stage } from '@/types/record';
import type { OrgRole } from '@prisma/client';
import type { FollowUpItem, StageCounts, StageReviewView } from '@/types/api';
import { can } from '@/lib/authz/policy';
import { descriptiveLine } from '@/lib/projects/metadataValues';
import { projectActions, type ProjectActions } from '@/lib/projects/can';
import { listStageReviews } from '@/lib/data/reviews';
import { ConflictError } from '@/lib/http/errors';
import { NotFoundError, withOrg } from '@/lib/data/tenant';
import { questionApplies, questionsInStage, runningContent } from '@/lib/content/loader';
import { currentDecisionRows } from '@/lib/data/decisions';
import { listFindings } from '@/lib/data/findings';
import { myMitigations, projectFollowUp, projectFollowUpCounts, type StageFollowUpCounts } from '@/lib/data/followup';

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
 *
 * `opts.followUp` lets S-10 pass the follow-up it has already read, so the rows are read once (NFR-PERF-04, FIX-12). It
 * must be `projectFollowUp` of this project read with `{ includeArchived: true }` and the same `today`, as stageView reads
 * it itself when none is given: rows read without it leave an archived project's mitigations out of these counts.
 */
export async function stageView(
  ctx: OrgContext, projectId: string, today: CalendarDate,
  opts: { followUp?: { open: Record<Stage, FollowUpItem[]>; counts: StageFollowUpCounts } } = {},
): Promise<Record<Stage, StageCounts>> {
  const content = runningContent();
  const { decisions, documents } = await withOrg(ctx, async (tx) => {
    // A project the caller cannot see (another organisation's, or none) is not found, not an empty stage (F10).
    const found = await tx.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (found === null) throw new NotFoundError();
    return {
      decisions: Object.fromEntries(await Promise.all(STAGES.map(async (s) => [s, await currentDecisionRows(tx, projectId, s)] as const))),
      documents: await documentsIssuedByStage(tx, projectId),
    };
  }) as { decisions: Record<Stage, Awaited<ReturnType<typeof currentDecisionRows>>>; documents: Record<Stage, number> };
  // S-10 shows the open and overdue mitigations of an archived project too; reminders and S-08 do not (FR-PRJ-03).
  const kept = { includeArchived: true };
  // One read each for the three stages, not one per stage (NFR-PERF-04, FIX-12): the follow-up rows, and the findings.
  const [{ open, counts: followUp }, allFindings] = await Promise.all([
    opts.followUp ?? projectFollowUp(ctx, projectId, today, kept), listFindings(ctx, projectId, undefined, today),
  ]);
  const findingsByStage = Map.groupBy(allFindings, (f) => f.stage);

  const out = {} as Record<Stage, StageCounts>;
  for (const stage of STAGES) {
    const rows = decisions[stage];
    const current = new Map(rows.map((r) => [r.questionId, r]));
    const questions = questionsInStage(content, stage);
    const inContent = new Set(questions.map((q) => q.id));

    // Which questions the gate makes not apply: they count only in notApplicableByGate (FR-CNT-04).
    const gated = new Set<string>();
    for (const q of questions) {
      if (q.condition === undefined) continue;
      const gate: ScopeAnswer | null = current.get(q.condition.questionId)?.scopeAnswer ?? null;
      if (!questionApplies(content, q.id, gate)) gated.add(q.id);
    }
    // The decisions that count: a question of the running content that applies. A decision on a question the content
    // dropped, or on one the gate now excludes, counts nowhere.
    const counted = rows.filter((r) => inContent.has(r.questionId) && !gated.has(r.questionId));
    const byStatus = Object.fromEntries(DECISION_STATUSES.map((st) => [st, 0])) as Record<DecisionStatus, number>;
    for (const r of counted) if (r.status !== null && r.status !== 'withdrawn') byStatus[r.status] += 1;

    let noDecision = 0;
    for (const q of questions) {
      if (gated.has(q.id)) continue;
      const row = current.get(q.id);
      if (row !== undefined && row.scopeAnswer !== null) continue;   // an answered gate is decided
      if (row === undefined || row.status === 'withdrawn' || row.status === null) noDecision += 1;
    }

    const counts = followUp[stage];
    const findings = findingsByStage.get(stage) ?? [];
    out[stage] = {
      questions: questions.length, noDecision, byStatus,
      doneWithoutEvidence: counted.filter((r) => r.status === 'done' && r.evidenceIds.length === 0).length,
      openFindings: counts.openFindings,
      openFindingsWithoutMitigation: findings.filter((f) => f.state === 'open' && f.hasNoMitigation).length,
      openMitigations: open[stage].length, overdueMitigations: counts.overdueMitigations,
      acceptedRisks: findings.filter((f) => f.state === 'closed_accepted_risk').length,
      documentsIssued: documents[stage], notApplicableByGate: gated.size,
    };
  }
  return out;
}

/**
 * Sets `archivedAt` inside the caller's transaction (FR-PRJ-03). The row is locked first (`FOR UPDATE`), which waits for
 * every write already in flight (they read the row `FOR SHARE` in `assertProjectWritable` and hold it to their commit),
 * and the time is read after that wait with `clock_timestamp()`. `now()` would be the time the transaction began, which can
 * be earlier than a save that committed before this archive and so would date the archive before a version it follows.
 * A project not visible under row-level security is not found; an archived one answers 409 `already_archived`.
 */
export async function archiveProjectIn(tx: TenantTx, projectId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ archivedAt: Date | null }[]>`SELECT "archivedAt" FROM "projects" WHERE "id" = ${projectId} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError();
  if (rows[0].archivedAt !== null) throw new ConflictError('already_archived');
  await tx.$executeRaw`UPDATE "projects" SET "archivedAt" = clock_timestamp() WHERE "id" = ${projectId}`;
}

/** Clears `archivedAt` inside the caller's transaction; 409 `not_archived` when it is not set. */
export async function unarchiveProjectIn(tx: TenantTx, projectId: string): Promise<void> {
  const changed = await tx.$executeRaw`UPDATE "projects" SET "archivedAt" = NULL WHERE "id" = ${projectId} AND "archivedAt" IS NOT NULL`;
  if (changed === 1) return;
  // The UPDATE changed no row: the project is not visible (404) or is not archived (409).
  const found = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "projects" WHERE "id" = ${projectId}`;
  if (found.length === 0) throw new NotFoundError();
  throw new ConflictError('not_archived');
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

/**
 * True when any record table holds a row of the project. Controller ruling, 5 Nov: the frozen `assessments` table is
 * read here on purpose. Refusing to delete a project that still holds legacy rows protects data (the foreign key would
 * otherwise cascade them away), and that outweighs SRS 11.2's "no code reads it".
 * Asks inside the caller's `tx`; an error is thrown, never read as "empty".
 */
export async function projectHasRecords(tx: TenantTx, projectId: string): Promise<boolean> {
  for (const table of TABLES_WITH_RECORDS) {
    // The table name comes from the closed list above, never from input.
    const rows = await tx.$queryRawUnsafe<{ present: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM "${table}" WHERE "projectId" = $1) AS "present"`, projectId);
    if (rows[0].present) return true;
  }
  return false;
}

// ─── Reads for the project screens (S-08, S-10, S-32) ────────────────────────────────────────────────────────────

/** A project as a list shows it: its name and the one descriptive line. */
export type ProjectRow = { id: string; name: string; descriptiveLine: string };

type StageFollowUps = Record<Stage, { items: FollowUpItem[]; cannotAct: FollowUpItem[] }>;
export type ProjectOverviewData = {
  orgSlug: string; orgName: string;
  project: { id: string; name: string; descriptiveLine: string; archived: boolean };
  counts: Record<Stage, StageCounts>;
  followUp: StageFollowUps;
  reviews: Record<Stage, StageReviewView[]>;
  can: ProjectActions;
};
export type DashboardData = {
  orgSlug: string; orgName: string; role: OrgRole; welcome: boolean; canCreate: boolean;
  projects: Array<{ project: ProjectRow; counts: Record<Stage, { openFindings: number; overdueMitigations: number }> }>;
  mine: FollowUpItem[]; projectNames: Map<string, string>;
  /** Archived projects of the organisation, so an empty active list can say there are none active, not none at all. */
  archivedCount: number;
};

/** Active and archived projects of the organisation, most recently updated first (row-level security scopes them). */
export async function listProjectRows(ctx: OrgContext): Promise<{ active: ProjectRow[]; archived: ProjectRow[] }> {
  const rows = await withOrg(ctx, (tx) => tx.project.findMany({ include: { metadata: true }, orderBy: { updatedAt: 'desc' } }));
  const active: ProjectRow[] = [];
  const archived: ProjectRow[] = [];
  for (const p of rows) (p.archivedAt === null ? active : archived).push({ id: p.id, name: p.name, descriptiveLine: descriptiveLine(p.metadata) });
  return { active, archived };
}

/** S-08 (FR-PRJ-04): every active project with its per-stage open findings and overdue mitigations, and the person's own open mitigations. */
export async function loadDashboard(
  ctx: OrgContext, identity: { userId: string }, opts: { orgSlug: string; welcome: boolean; today: CalendarDate },
): Promise<DashboardData> {
  const [{ active, archived }, org, mine] = await Promise.all([
    listProjectRows(ctx),
    withOrg(ctx, (tx) => tx.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true } })),
    myMitigations(ctx, identity.userId, opts.today),
  ]);
  // Every stage's counts of a project from one read of its follow-up rows, not one read per stage (C4 SI-3).
  const projects = await Promise.all(active.map(async (project) => ({ project, counts: await projectFollowUpCounts(ctx, project.id, opts.today) })));
  return {
    orgSlug: opts.orgSlug, orgName: org.name, role: ctx.role, welcome: opts.welcome, canCreate: can(ctx.role, 'project:create'),
    projects, mine, projectNames: new Map([...active, ...archived].map((p) => [p.id, p.name])), archivedCount: archived.length,
  };
}

/**
 * S-10 (FR-PRJ-02): the project, read first inside `withOrg` so a project the caller cannot see (another organisation's,
 * or none) is `null` before any other read (SEC-06). The follow-up slot gets the items whose owner can act and, apart,
 * those whose owner cannot (FR-FUP-05).
 */
export async function loadProjectOverview(
  ctx: OrgContext, opts: { orgSlug: string; projectId: string; today: CalendarDate },
): Promise<ProjectOverviewData | null> {
  const found = await withOrg(ctx, async (tx) => ({
    project: await tx.project.findUnique({ where: { id: opts.projectId }, include: { metadata: true } }),
    org: await tx.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true } }),
  }));
  if (found.project === null) return null;
  const kept = { includeArchived: true };   // S-10 follows up an archived project's open mitigations too (FR-PRJ-03)
  const projectFollowUps = await projectFollowUp(ctx, opts.projectId, opts.today, kept);
  const byStage = projectFollowUps.open;
  const [counts, reviews] = await Promise.all([
    stageView(ctx, opts.projectId, opts.today, { followUp: projectFollowUps }),
    listStageReviews(ctx, opts.projectId),
  ]);
  // `openMitigationsByStage` holds the cannot-act items too, with `ownerCanAct: false`, in the same order, so they are
  // `ownerCannotAct`'s list without a second read of the same rows (NFR-PERF-04, FIX-12).
  const followUp = Object.fromEntries(STAGES.map((s) => [s, {
    items: byStage[s].filter((i) => i.ownerCanAct), cannotAct: byStage[s].filter((i) => !i.ownerCanAct),
  }])) as StageFollowUps;
  const reviewsByStage = Object.fromEntries(STAGES.map((s) => [s, reviews.filter((r) => r.stage === s)])) as Record<Stage, StageReviewView[]>;
  const archived = found.project.archivedAt !== null;
  return {
    orgSlug: opts.orgSlug, orgName: found.org.name,
    project: { id: found.project.id, name: found.project.name, descriptiveLine: descriptiveLine(found.project.metadata), archived },
    counts, followUp, reviews: reviewsByStage, can: projectActions(ctx.role, archived),
  };
}
