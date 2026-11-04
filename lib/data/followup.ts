import { withOrg, type OrgContext, type TenantTx, type FollowUpSourceRows } from '@/lib/data/tenant';
import { identityDb } from '@/lib/data/identity';
import { userRefs } from '@/lib/data/views';
import { deriveFindingState } from '@/lib/findings/state';
import { eatDate } from '@/lib/followup/overdue';
import { canAct, selectOpenMitigations, type FollowUpCore } from '@/lib/followup/rules';
import { STAGES, type CalendarDate, type FindingEventKind, type FindingSource, type Stage } from '@/types/record';
import type { FollowUpItem } from '@/types/api';

/** Follow-up lists (FR-FUP-01, 02, 05): the pages' view of what the reminder job also decides on. */

/**
 * The rows `selectOpenMitigations` reads, built in the caller's transaction in the same shape the
 * reminder lane returns, so the app lists and the job apply the rules to one input type.
 */
export async function loadFollowUpSourceRows(tx: TenantTx, filter: { projectId?: string }): Promise<FollowUpSourceRows> {
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
  return cores.flatMap((c) => {
    const owner = refs.get(c.ownerUserId);
    // Accounts are scrubbed, never deleted (FR-EXP-03), so an owner always has a reference.
    if (!owner) throw new Error(`followup: owner ${c.ownerUserId} of mitigation ${c.mitigationId} has no account row`);
    return [{ ...c, what: what.get(c.versionId) ?? null, owner }];
  });
}

async function loadItems(ctx: OrgContext, filter: { projectId?: string }, today: CalendarDate, keep: (c: FollowUpCore) => boolean = () => true): Promise<FollowUpItem[]> {
  return withOrg(ctx, async (tx) => {
    const rows = await loadFollowUpSourceRows(tx, filter);
    const actable = await actableOwners(tx, rows.currentMitigations.map((m) => m.ownerUserId));
    return toItems(tx, selectOpenMitigations(rows, actable, today).filter(keep));
  });
}

/** FR-FUP-01: every open item of the project by stage, cannot-act ones included with `ownerCanAct: false`. */
export async function openMitigationsByStage(
  ctx: OrgContext, projectId: string, today: CalendarDate,
): Promise<Record<Stage, FollowUpItem[]>> {
  const items = await loadItems(ctx, { projectId }, today);
  const out = Object.fromEntries(STAGES.map((s) => [s, [] as FollowUpItem[]])) as Record<Stage, FollowUpItem[]>;
  for (const i of items) out[i.stage].push(i);
  return out;
}

/** FR-FUP-01: the open items `userId` owns in the context organisation, in every active project. */
export async function myMitigations(ctx: OrgContext, userId: string, today: CalendarDate): Promise<FollowUpItem[]> {
  return loadItems(ctx, {}, today, (c) => c.ownerUserId === userId);
}

/** FR-FUP-05: the project's open items whose owner can no longer act (S-15's "reassign" mark). */
export async function ownerCannotAct(ctx: OrgContext, projectId: string): Promise<FollowUpItem[]> {
  return loadItems(ctx, { projectId }, eatDate(new Date()), (c) => !c.ownerCanAct);
}

/** S-08 and S-11: findings of the stage whose state is open, and the stage's overdue mitigations. */
export async function stageFollowUpCounts(
  ctx: OrgContext, projectId: string, stage: Stage, today: CalendarDate,
): Promise<{ openFindings: number; overdueMitigations: number }> {
  return withOrg(ctx, async (tx) => {
    const rows = await loadFollowUpSourceRows(tx, { projectId });
    const openFindings = rows.findings.filter((f) => f.stage === stage && deriveFindingState({
      source: f.source,
      events: rows.events.filter((e) => e.findingId === f.id),
      currentMitigations: rows.currentMitigations.filter((m) => m.findingId === f.id),
      acceptedRisks: rows.acceptedRisks.filter((r) => r.findingId === f.id),
    }) === 'open').length;
    const overdueMitigations = selectOpenMitigations(rows, () => true, today).filter((m) => m.stage === stage && m.overdue).length;
    return { openFindings, overdueMitigations };
  });
}
