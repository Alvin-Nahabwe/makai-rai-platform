import { Prisma } from '@prisma/client';
import { withOrg, type OrgContext } from '@/lib/data/tenant';
import { userRefs } from '@/lib/data/views';
import type { Stage } from '@/types/record';
import type { ChangeGroup, SavedRef } from '@/lib/home/types';

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

/**
 * The person's newest saved entry in THIS project (plan 1C C11): `lastSavedBy`'s rule for one project, a withdrawal
 * included. Runs inside `withOrg`, so another organisation's project id finds no row. `null` when they saved nothing here.
 */
export async function lastSavedIn(ctx: OrgContext, projectId: string, userId: string): Promise<{ stage: Stage; questionId: string } | null> {
  const rows = await withOrg(ctx, (tx) => tx.$queryRaw<Array<{ stage: Stage; questionId: string }>>(lastSavedInSql(projectId, userId)));
  const row = rows[0];
  if (row === undefined) return null;
  return { stage: row.stage, questionId: row.questionId };
}

/** `lastSavedIn`'s one statement, a tagged template; exported only so the query-plan probe can EXPLAIN it. Run inside `withOrg`. */
export function lastSavedInSql(projectId: string, userId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT v."stage" AS "stage", v."questionId" AS "questionId"
    FROM "decision_versions" v
    WHERE v."projectId" = ${projectId} AND v."enteredById" = ${userId}
    ORDER BY v."receivedAt" DESC, v."versionNumber" DESC
    LIMIT 1`;
}

/**
 * The organisation's saved changes after `since` (spec 9.1's "Since your last saved change" and the Viewer's last 14 days):
 * decision versions entered (a withdrawal included), findings raised and seals made, grouped by day, person, kind,
 * project and stage, newest first, at most `limitGroups` groups, with `more` when there are others. `excludeUserId` leaves
 * that person's own changes out (the reader's); `null` leaves nobody out. Archived projects never supply a change (T9.4).
 * Names come from `userRefs` inside the same transaction, for the ids of this organisation's rows only (T9.3), so a
 * former member carries the mark. An id with no account row is an error: accounts are scrubbed, never deleted (FR-EXP-03).
 */
export async function changesSince(
  ctx: OrgContext, opts: { since: Date; excludeUserId: string | null; limitGroups: number },
): Promise<{ groups: ChangeGroup[]; more: boolean }> {
  if (!Number.isInteger(opts.limitGroups) || opts.limitGroups < 1) throw new RangeError(`changesSince: limitGroups must be a whole number from 1, not ${opts.limitGroups}`);
  if (Number.isNaN(opts.since.getTime())) throw new RangeError('changesSince: since is not a time');
  return withOrg(ctx, async (tx) => {
    const rows = await tx.$queryRaw<ChangeRow[]>(changesSinceSql(opts));
    const kept = rows.slice(0, opts.limitGroups);
    const refs = await userRefs(tx, kept.map((r) => r.who));
    const groups = kept.map(({ who, latestAt, ...rest }): ChangeGroup => {
      const ref = refs.get(who);
      if (ref === undefined) throw new Error(`changesSince: ${who}, who made a change in project ${rest.projectId}, has no account row`);
      return { ...rest, latestAt: latestAt.toISOString(), who: ref };
    });
    return { groups, more: rows.length > opts.limitGroups };
  });
}

type ChangeRow = Omit<ChangeGroup, 'who' | 'latestAt'> & { who: string; latestAt: Date };

/**
 * `changesSince`'s one statement, a tagged template so every value is a bound parameter (T9.6); exported only so the
 * query-plan probe can EXPLAIN the very statement that runs. Run inside `withOrg`: row-level security on every table it
 * reads is the organisation filter. A change's day is its date in East Africa Time, UTC+3 with no daylight saving, the
 * zone `eatDate` gives "today" in (D5). One row past the cap is read, so `more` needs no second count.
 */
export function changesSinceSql(opts: { since: Date; excludeUserId: string | null; limitGroups: number }): Prisma.Sql {
  const since = opts.since.toISOString();
  return Prisma.sql`
    WITH "changes" AS (
      SELECT v."orgId", v."projectId", v."stage", v."enteredById" AS "who", 'decisions' AS "kind", v."questionId" AS "item", v."receivedAt" AS "at"
      FROM "decision_versions" v WHERE v."receivedAt" > ${since}::timestamptz
      UNION ALL
      SELECT f."orgId", f."projectId", f."stage", f."raisedById", 'finding', f."id", f."raisedAt"
      FROM "findings" f WHERE f."raisedAt" > ${since}::timestamptz
      UNION ALL
      SELECT s."orgId", r."projectId", r."stage", s."sealedById", 'seal', s."id", s."sealedAt"
      FROM "seals" s JOIN "stage_reviews" r ON r."orgId" = s."orgId" AND r."id" = s."stageReviewId"
      WHERE s."sealedAt" > ${since}::timestamptz
    )
    SELECT to_char((c."at" AT TIME ZONE 'UTC') + interval '3 hours', 'YYYY-MM-DD') AS "day", max(c."at") AS "latestAt",
      c."who" AS "who", c."kind" AS "kind", count(DISTINCT c."item")::int AS "count",
      c."projectId" AS "projectId", p."name" AS "projectName", c."stage" AS "stage"
    FROM "changes" c JOIN "projects" p ON p."orgId" = c."orgId" AND p."id" = c."projectId"
    WHERE p."archivedAt" IS NULL AND (${opts.excludeUserId}::text IS NULL OR c."who" <> ${opts.excludeUserId}::text)
    GROUP BY 1, c."who", c."kind", c."projectId", p."name", c."stage"
    ORDER BY "latestAt" DESC, "day" DESC, c."kind", c."projectId", c."stage", c."who"
    LIMIT ${opts.limitGroups + 1}`;
}
