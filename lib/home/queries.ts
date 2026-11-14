import { Prisma } from '@prisma/client';
import { withOrg, type OrgContext } from '@/lib/data/tenant';
import type { Stage } from '@/types/record';
import type { SavedRef } from '@/lib/home/types';

/**
 * Home's reads (plan 1B Task 9), server only. Each runs inside `withOrg`, so forced row-level security scopes every table
 * it touches to the organisation (T9.1); values reach SQL only through Prisma's tagged template (T9.6). No error is
 * caught: a failed read is an error, never "nothing to show" (T9.7).
 */

/**
 * The person's newest saved entry in an active project of the organisation (rule C2): any version they entered, a
 * withdrawal included, newest received first, then the highest version number. Archived projects never supply it (T9.4).
 * `null` when they have saved nothing in an active project here.
 */
export async function lastSavedBy(ctx: OrgContext, userId: string): Promise<SavedRef | null> {
  const rows = await withOrg(ctx, (tx) => tx.$queryRaw<Array<{ projectId: string; projectName: string; stage: Stage; questionId: string; at: Date }>>(lastSavedSql(userId)));
  const row = rows[0];
  if (row === undefined) return null;
  return { projectId: row.projectId, projectName: row.projectName, stage: row.stage, questionId: row.questionId, at: row.at.toISOString() };
}

/**
 * `lastSavedBy`'s one statement, a tagged template so `userId` is a bound parameter. Exported only so the query-plan probe
 * can EXPLAIN the very statement that runs; it must be run inside `withOrg`.
 */
export function lastSavedSql(userId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT v."projectId" AS "projectId", p."name" AS "projectName", v."stage" AS "stage", v."questionId" AS "questionId", v."receivedAt" AS "at"
    FROM "decision_versions" v
    JOIN "projects" p ON p."orgId" = v."orgId" AND p."id" = v."projectId"
    WHERE v."enteredById" = ${userId} AND p."archivedAt" IS NULL
    ORDER BY v."receivedAt" DESC, v."versionNumber" DESC
    LIMIT 1`;
}

/**
 * Whether the person has entered any decision version in this organisation, in any project, archived or not, a withdrawal
 * included (fix round 1, review F1). Home asks it only when `lastSavedBy` finds nothing, so a person whose saves are all
 * in projects archived since is not told they never saved.
 */
export async function hasSavedAny(ctx: OrgContext, userId: string): Promise<boolean> {
  const rows = await withOrg(ctx, (tx) => tx.$queryRaw<Array<{ any: boolean }>>(hasSavedAnySql(userId)));
  return rows[0].any;
}

/** `hasSavedAny`'s one statement, a tagged template; exported only so the query-plan probe can EXPLAIN it. Run inside `withOrg`. */
export function hasSavedAnySql(userId: string): Prisma.Sql {
  return Prisma.sql`SELECT EXISTS (SELECT 1 FROM "decision_versions" WHERE "enteredById" = ${userId}) AS "any"`;
}
