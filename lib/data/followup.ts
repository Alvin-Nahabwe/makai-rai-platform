import { withOrg, type OrgContext, type TenantTx, type FollowUpSourceRows } from '@/lib/data/tenant';
import { identityDb } from '@/lib/data/identity';
import { userRefs } from '@/lib/data/views';
import { eatDate } from '@/lib/followup/overdue';
import { canAct, findingStates, selectOpenMitigations, type FollowUpCore } from '@/lib/followup/rules';
import { STAGES, type CalendarDate, type FindingEventKind, type FindingSource, type Stage } from '@/types/record';
import type { FollowUpItem } from '@/types/api';

/** Follow-up lists (FR-FUP-01, 02, 05): the pages' view of what the reminder job also decides on. */

/**
 * The rows `selectOpenMitigations` reads, built in the caller's transaction in the same shape the
 * reminder lane returns, so the app lists and the job apply the rules to one input type.
 */
async function loadFollowUpSourceRows(tx: TenantTx, filter: { projectId?: string }): Promise<FollowUpSourceRows> {
  const findings = await tx.finding.findMany({
    where: filter.projectId === undefined ? {} : { projectId: filter.projectId },
    select: { id: true, projectId: true, stage: true, source: true },
    orderBy: { id: 'asc' },
  });
  const ids = findings.map((f) => f.id);
  const [events, acceptedRisks, currentMitigations, archived] = await Promise.all([
    tx.findingEvent.findMany({ where: { findingId: { in: ids } }, select: { findingId: true, kind: true, findingSeq: true }, orderBy: [{ findingId: 'asc' }, { findingSeq: 'asc' }] }),
    tx.acceptedRisk.findMany({ where: { findingId: { in: ids } }, select: { findingId: true, findingSeq: true }, orderBy: [{ findingId: 'asc' }, { findingSeq: 'asc' }] }),
    tx.$queryRaw<FollowUpSourceRows['currentMitigations']>`
      SELECT DISTINCT ON ("mitigationId") "id" AS "versionId", "mitigationId", "findingId", "ownerUserId",
        to_char("dueDate", 'YYYY-MM-DD') AS "dueDate", "status", "findingSeq"
      FROM "mitigation_versions"
      WHERE "findingId" = ANY (${ids}::text[])
      ORDER BY "mitigationId", "versionNumber" DESC`,
    tx.project.findMany({ where: { archivedAt: { not: null } }, select: { id: true }, orderBy: { id: 'asc' } }),
  ]);
  return {
    findings: findings.map((f) => ({ id: f.id, projectId: f.projectId, stage: f.stage as Stage, source: f.source as FindingSource })),
    events: events.map((e) => ({ findingId: e.findingId, kind: e.kind as FindingEventKind, findingSeq: e.findingSeq })),
    acceptedRisks,
    currentMitigations,
    archivedProjectIds: archived.map((p) => p.id),
  };
}

/** Who can act now: an active membership with a role that may write mitigations, on an active account (FR-FUP-05). */
async function actableOwners(tx: TenantTx, ownerIds: readonly string[]): Promise<(userId: string) => boolean> {
  const ids = [...new Set(ownerIds)];
  const [members, users] = await Promise.all([
    tx.membership.findMany({ where: { userId: { in: ids }, status: 'active' }, select: { userId: true, role: true } }),
    identityDb.user.findMany({ where: { id: { in: ids } }, select: { id: true, isActive: true } }),
  ]);
  const roles = new Map(members.map((m) => [m.userId, m.role]));
  const active = new Map(users.map((u) => [u.id, u.isActive]));
  return (userId) => canAct(roles.get(userId), active.get(userId));
}

/** Selected core rows, then each one's text and owner reference, in the order the rules gave. */
async function toItems(tx: TenantTx, cores: FollowUpCore[]): Promise<FollowUpItem[]> {
  if (cores.length === 0) return [];
  const [versions, refs] = await Promise.all([
    tx.mitigationVersion.findMany({ where: { id: { in: cores.map((c) => c.versionId) } }, select: { id: true, what: true } }),
    userRefs(tx, cores.map((c) => c.ownerUserId)),
  ]);
  const what = new Map(versions.map((v) => [v.id, v.what]));
  return cores.map(({ ownerUserId, ...rest }) => {
    const owner = refs.get(ownerUserId);
    // Accounts are scrubbed, never deleted (FR-EXP-03), so an owner always has a reference.
    if (!owner) throw new Error(`followup: owner ${ownerUserId} of mitigation ${rest.mitigationId} has no account row`);
    return { ...rest, what: what.get(rest.versionId) ?? null, owner };
  });
}

/** An archived project is left out of every list unless the caller asks for it (S-10 does; reminders and S-08 never do, FR-PRJ-03). */
export type FollowUpOptions = { includeArchived?: boolean };

const withArchivedKept = (rows: FollowUpSourceRows, o: FollowUpOptions): FollowUpSourceRows =>
  o.includeArchived === true ? { ...rows, archivedProjectIds: [] } : rows;

async function loadItems(ctx: OrgContext, filter: { projectId?: string }, today: CalendarDate, keep: (c: FollowUpCore) => boolean = () => true, o: FollowUpOptions = {}): Promise<FollowUpItem[]> {
  return withOrg(ctx, async (tx) => {
    const rows = withArchivedKept(await loadFollowUpSourceRows(tx, filter), o);
    const actable = await actableOwners(tx, rows.currentMitigations.map((m) => m.ownerUserId));
    return toItems(tx, selectOpenMitigations(rows, actable, today).filter(keep));
  });
}

/** FR-FUP-01: every open item of the project by stage, cannot-act ones included with `ownerCanAct: false`. */
export async function openMitigationsByStage(
  ctx: OrgContext, projectId: string, today: CalendarDate, o: FollowUpOptions = {},
): Promise<Record<Stage, FollowUpItem[]>> {
  const items = await loadItems(ctx, { projectId }, today, () => true, o);
  const out = Object.fromEntries(STAGES.map((s) => [s, [] as FollowUpItem[]])) as Record<Stage, FollowUpItem[]>;
  for (const i of items) out[i.stage].push(i);
  return out;
}

/** FR-FUP-01: the open items `userId` owns in the context organisation, in every active project. */
export async function myMitigations(ctx: OrgContext, userId: string, today: CalendarDate): Promise<FollowUpItem[]> {
  return loadItems(ctx, {}, today, (c) => c.ownerUserId === userId);
}

/** FR-FUP-05: the project's open items whose owner can no longer act (S-15's "reassign" mark). */
export async function ownerCannotAct(ctx: OrgContext, projectId: string, o: FollowUpOptions = {}): Promise<FollowUpItem[]> {
  return loadItems(ctx, { projectId }, eatDate(new Date()), (c) => !c.ownerCanAct, o);
}

/** S-08 and S-11: findings of the stage whose state is open, and the stage's overdue mitigations. */
export async function stageFollowUpCounts(
  ctx: OrgContext, projectId: string, stage: Stage, today: CalendarDate, o: FollowUpOptions = {},
): Promise<{ openFindings: number; overdueMitigations: number }> {
  return withOrg(ctx, async (tx) => {
    const rows = withArchivedKept(await loadFollowUpSourceRows(tx, { projectId }), o);
    const states = findingStates(rows);
    const openFindings = rows.findings.filter((f) => f.stage === stage && states.get(f.id) === 'open').length;
    const overdueMitigations = selectOpenMitigations(rows, () => true, today).filter((m) => m.stage === stage && m.overdue).length;
    return { openFindings, overdueMitigations };
  });
}
