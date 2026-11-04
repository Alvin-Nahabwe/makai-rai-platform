import { identityDb } from '@/lib/data/identity';
import { listOrganisationsForReminders, withReminderRunLock } from '@/lib/data/identityReads';
import { systemContext, type ReminderLane, type ReminderLogRow } from '@/lib/data/tenant';
import { mitigationDueEmail } from '@/lib/email/templates/mitigationDue';
import { mitigationOverdueEmail } from '@/lib/email/templates/mitigationOverdue';
import { sendEmail } from '@/lib/email/send';
import { eatDate } from '@/lib/followup/overdue';
import { canAct, reminderDue, selectOpenMitigations } from '@/lib/followup/rules';
import { publicOrigin } from '@/lib/publicOrigin';
import { logSecurityEvent } from '@/lib/security-logger';
import type { CalendarDate, ReminderKind } from '@/types/record';

/**
 * The reminder job (SRS 6.6; FR-FUP-03 to 06; NFR-REL-08). Imported by the internal route only
 * (NFR-SEC-13). For each organisation, inside one `systemContext`: the mitigations that are
 * eligible at `now`, minus those already sent, opted out or out of attempts, one email per person
 * and kind, and a claimed row before every send so a second run cannot send twice. Nothing in an
 * email but the organisation name, a date and a link (NFR-PRIV-02); nothing logged but counts.
 */

export type ReminderRunResult = { attempted: number; sent: number; failed: number; optedOut: number; skippedLocked: boolean };

/** One first send and at most three retries (FR-FUP-04). */
const MAX_ATTEMPTS = 4;

type Counts = { attempted: number; sent: number; failed: number; optedOut: number };
type Key = { mitigationId: string; dueDate: CalendarDate; kind: ReminderKind; ownerUserId: string; attempt: number };
type Org = { orgId: string; name: string; slug: string };
type Person = { email: string; reminderEmails: boolean };

const keyOf = (mitigationId: string, dueDate: CalendarDate, kind: ReminderKind) => `${mitigationId}|${dueDate}|${kind}`;

/** Runs every organisation's reminders. A failure to record a group is counted, the run goes on, and the run throws at its end. */
export async function runReminders(now: Date): Promise<ReminderRunResult> {
  const counts: Counts = { attempted: 0, sent: 0, failed: 0, optedOut: 0 };
  let failures = 0;

  const outcome = await withReminderRunLock(async () => {
    for (const org of await listOrganisationsForReminders()) {
      try {
        failures += await systemContext(org.orgId, 'reminders', (lane) => runOrganisation(lane, org, now, counts));
      } catch {
        failures += 1;
      }
    }
    return 'done' as const;
  });

  const skippedLocked = outcome === 'locked';
  logSecurityEvent('REMINDER_RUN', failures > 0 ? 'error' : 'info', { details: { ...counts } });
  if (failures > 0) throw new Error(`Reminder run: ${failures} organisation or group step(s) failed; the counts are in the REMINDER_RUN line.`);
  return { ...counts, skippedLocked };
}

/** Returns how many groups or steps failed to record; email send failures are outcomes, not failures. */
async function runOrganisation(lane: ReminderLane, org: Org, now: Date, counts: Counts): Promise<number> {
  const today = eatDate(now);
  const rows = await lane.followUpRows();
  const ownerIds = [...new Set(rows.currentMitigations.map((m) => m.ownerUserId))];
  const [roles, accounts, history] = await Promise.all([
    lane.memberRoles(ownerIds),
    identityDb.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, email: true, isActive: true, reminderEmails: true } }),
    lane.reminderLogRows(rows.currentMitigations.map((m) => m.mitigationId)),
  ]);
  const active = new Map(accounts.map((a) => [a.id, a.isActive]));
  const people = new Map<string, Person>(accounts.map((a) => [a.id, { email: a.email, reminderEmails: a.reminderEmails }]));

  const byKey = new Map<string, ReminderLogRow[]>();
  for (const r of history) byKey.set(keyOf(r.mitigationId, r.dueDate, r.kind), [...(byKey.get(keyOf(r.mitigationId, r.dueDate, r.kind)) ?? []), r]);

  // A person who was sent a reminder of a kind today, whatever has happened to that mitigation since.
  const ownerOf = new Map(rows.currentMitigations.map((m) => [m.mitigationId, m.ownerUserId]));
  const sentToday = new Set<string>();
  for (const r of history) {
    const owner = ownerOf.get(r.mitigationId);
    if (r.outcome === 'sent' && owner !== undefined && eatDate(new Date(r.at)) === today) sentToday.add(`${owner}|${r.kind}`);
  }

  const keys: Key[] = [];
  const optedOut: Key[] = [];
  for (const m of selectOpenMitigations(rows, (u) => canAct(roles.get(u), active.get(u)), today)) {
    if (!m.ownerCanAct) continue;
    const kind = reminderDue(m.dueDate, now);
    if (kind === null) continue;
    const prior = byKey.get(keyOf(m.mitigationId, m.dueDate, kind)) ?? [];
    if (prior.some((r) => r.outcome === 'sent' || r.outcome === 'opted_out')) continue;
    // Every other attempt ended failed, or was claimed and never finished: both count.
    const attempts = new Set(prior.map((r) => r.attempt));
    if (attempts.size >= MAX_ATTEMPTS) continue;
    const key: Key = { mitigationId: m.mitigationId, dueDate: m.dueDate, kind, ownerUserId: m.ownerUserId, attempt: Math.max(0, ...attempts) + 1 };
    (people.get(m.ownerUserId)?.reminderEmails === false ? optedOut : keys).push(key);
  }

  let failures = 0;
  for (const key of optedOut) {
    try {
      const res = await lane.insertReminderLog({ ...key, outcome: 'opted_out', failureCode: null });
      if (res === 'inserted') counts.optedOut += 1;
    } catch {
      failures += 1;
    }
  }

  const groups = new Map<string, Key[]>();
  for (const key of keys) {
    if (sentToday.has(`${key.ownerUserId}|${key.kind}`)) continue;
    groups.set(`${key.ownerUserId}|${key.kind}`, [...(groups.get(`${key.ownerUserId}|${key.kind}`) ?? []), key]);
  }
  for (const group of groups.values()) {
    try {
      await sendGroup(lane, org, group, people.get(group[0].ownerUserId)!.email, counts);
    } catch {
      failures += 1;
    }
  }
  return failures;
}

/** Claim every key of the group, send one email, record one outcome per claimed key with the claim's attempt. */
async function sendGroup(lane: ReminderLane, org: Org, group: Key[], to: string, counts: Counts): Promise<void> {
  // Resolved before any claim: a missing public origin throws here and leaves no claimed row behind.
  const dashboardUrl = `${publicOrigin()}/orgs/${org.slug}/dashboard`;
  const claimed: Key[] = [];
  for (const key of group) {
    const res = await lane.insertReminderLog({ ...key, outcome: 'claimed', failureCode: null });
    if (res === 'inserted') claimed.push(key);
  }
  if (claimed.length === 0) return;

  const kind = claimed[0].kind;
  const dueDate = claimed.map((k) => k.dueDate).sort()[0];
  const from = process.env.EMAIL_FROM_ADDRESS;
  let result: { outcome: 'sent' } | { outcome: 'failed'; failureCode: 'transport_error' | 'not_configured' };
  counts.attempted += 1;
  if (typeof from !== 'string' || from.length === 0) {
    result = { outcome: 'failed', failureCode: 'not_configured' };
  } else {
    const content = { orgName: org.name, dueDate, dashboardUrl };
    try {
      await sendEmail({ to, from, ...(kind === 'due' ? mitigationDueEmail(content) : mitigationOverdueEmail(content)) });
      result = { outcome: 'sent' };
    } catch {
      // The failure is the outcome row below; no error text is kept (it can carry the address).
      result = { outcome: 'failed', failureCode: 'transport_error' };
    }
  }
  if (result.outcome === 'sent') counts.sent += 1; else counts.failed += 1;

  for (const key of claimed) {
    const res = await lane.insertReminderLog({
      ...key, outcome: result.outcome, failureCode: result.outcome === 'failed' ? result.failureCode : null,
    });
    // The outcome row shares the claim's attempt; the unique keys admit the pair (gap G091).
    if (res === 'duplicate') throw new Error('The outcome row of a claimed attempt was refused by the unique keys.');
  }
}
