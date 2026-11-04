import type { OrgRole } from '@prisma/client';
import { can } from '@/lib/authz/policy';
import { deriveFindingState } from '@/lib/findings/state';
import { eatDate, isOverdue } from '@/lib/followup/overdue';
import type { FollowUpSourceRows } from '@/lib/data/tenant';
import type { CalendarDate, FindingState, ReminderKind, Stage } from '@/types/record';

/**
 * The follow-up rules (FR-FUP-01, 02, 03, 05; ADR-C5): one implementation that the app lists
 * (`lib/data/followup.ts`) and the reminder job (`lib/reminders/job.ts`) both apply.
 */

export type FollowUpCore = {
  mitigationId: string; versionId: string; findingId: string; projectId: string; stage: Stage;
  ownerUserId: string; dueDate: CalendarDate; status: 'planned' | 'in_progress';
  overdue: boolean; ownerCanAct: boolean;
};

/** FR-FUP-05: true only for a role that may write mitigations on an active account. */
export function canAct(role: OrgRole | undefined, isActive: boolean | undefined): boolean {
  return role !== undefined && isActive === true && can(role, 'mitigation:write');
}

/** The one order of FR-FUP-01: overdue first, then due date, then mitigation id. */
export function compareFollowUp(
  a: { overdue: boolean; dueDate: CalendarDate; mitigationId: string },
  b: { overdue: boolean; dueDate: CalendarDate; mitigationId: string },
): number {
  return Number(b.overdue) - Number(a.overdue)
    || (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0)
    || (a.mitigationId < b.mitigationId ? -1 : a.mitigationId > b.mitigationId ? 1 : 0);
}

function groupByFinding<T extends { findingId: string }>(list: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of list) {
    const group = out.get(x.findingId);
    if (group) group.push(x); else out.set(x.findingId, [x]);
  }
  return out;
}

/** The state of every finding of `rows` (SRS 5.3 item 11), by finding id. */
export function findingStates(rows: FollowUpSourceRows): Map<string, FindingState> {
  const eventsOf = groupByFinding(rows.events);
  const mitigationsOf = groupByFinding(rows.currentMitigations);
  const risksOf = groupByFinding(rows.acceptedRisks);
  return new Map(rows.findings.map((f) => [f.id, deriveFindingState({
    source: f.source,
    events: eventsOf.get(f.id) ?? [],
    currentMitigations: mitigationsOf.get(f.id) ?? [],
    acceptedRisks: risksOf.get(f.id) ?? [],
  })]));
}

/**
 * Current mitigation versions that are planned or in progress, whose finding is open and whose
 * project is not archived; overdue first, then due date, then mitigation id (FR-FUP-01).
 */
export function selectOpenMitigations(
  rows: FollowUpSourceRows, actable: (userId: string) => boolean, today: CalendarDate,
): FollowUpCore[] {
  const archived = new Set(rows.archivedProjectIds);
  const findings = new Map(rows.findings.map((f) => [f.id, f]));
  const states = findingStates(rows);

  const out: FollowUpCore[] = [];
  for (const m of rows.currentMitigations) {
    if (m.status !== 'planned' && m.status !== 'in_progress') continue;
    const finding = findings.get(m.findingId);
    const state = states.get(m.findingId);
    if (!finding || state !== 'open' || archived.has(finding.projectId)) continue;
    out.push({
      mitigationId: m.mitigationId, versionId: m.versionId, findingId: m.findingId, projectId: finding.projectId,
      stage: finding.stage, ownerUserId: m.ownerUserId, dueDate: m.dueDate, status: m.status,
      overdue: isOverdue(m, state, today), ownerCanAct: actable(m.ownerUserId),
    });
  }
  return out.sort(compareFollowUp);
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(d: CalendarDate, n: number): CalendarDate {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The reminder kind a mitigation is eligible for at `now`: 'due' on the due date (from 06:00 East
 * Africa Time) and the day after; 'overdue' on due date + 7 (from 06:00) and + 8; else null.
 * Two days per kind is what NFR-REL-08's 30-hour gap needs (FR-FUP-03).
 */
export function reminderDue(dueDate: CalendarDate, now: Date): ReminderKind | null {
  const today = eatDate(now);
  const afterSix = now.getTime() - Date.parse(`${today}T00:00:00+03:00`) >= SIX_HOURS_MS;
  if (today === dueDate) return afterSix ? 'due' : null;
  if (today === addDays(dueDate, 1)) return 'due';
  if (today === addDays(dueDate, 7)) return afterSix ? 'overdue' : null;
  if (today === addDays(dueDate, 8)) return 'overdue';
  return null;
}

/**
 * The kind whose last eligible day was yesterday (the due date + 1 for 'due', + 8 for 'overdue'), and
 * null on every other day. A key the once-a-day cap held back on that last day stays eligible one more
 * day, for that reason only (FR-FUP-03); the job decides whether the cap held it back.
 */
export function reminderDueAfterCap(dueDate: CalendarDate, now: Date): ReminderKind | null {
  if (reminderDue(dueDate, now) !== null) return null;
  return reminderDue(dueDate, new Date(now.getTime() - DAY_MS));
}
