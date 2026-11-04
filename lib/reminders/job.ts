import { identityDb } from '@/lib/data/identity';
import { listOrganisationsForReminders, withReminderRunLock } from '@/lib/data/identityReads';
import { systemContext, type ReminderLane, type ReminderLogRow } from '@/lib/data/tenant';
import { mitigationDueEmail } from '@/lib/email/templates/mitigationDue';
import { mitigationOverdueEmail } from '@/lib/email/templates/mitigationOverdue';
import { sendEmail } from '@/lib/email/send';
import { eatDate } from '@/lib/followup/overdue';
import { canAct, reminderDue, reminderDueAfterCap, selectOpenMitigations } from '@/lib/followup/rules';
import { publicOrigin } from '@/lib/publicOrigin';
import { logSecurityEvent } from '@/lib/security-logger';
import type { CalendarDate, ReminderKind } from '@/types/record';

/**
 * The reminder job (SRS 6.6; FR-FUP-03 to 06; NFR-REL-08). Imported by the internal route only
 * (NFR-SEC-13). For each organisation, inside one `systemContext`: the mitigations that are
 * eligible at `now`, minus those already sent, opted out or out of attempts, one email per person
 * and kind, and a claimed row before every send so a second run cannot send twice. Nothing in an
 * email but the organisation name, a date and a link (NFR-PRIV-02); nothing logged but counts.
 *
 * A step that fails to record is counted and the run goes on; at its end the run logs REMINDER_RUN
 * at error level and throws, so route 40 answers 500 and the host's dead-man check alerts.
 */

export type ReminderRunResult = { attempted: number; sent: number; failed: number; optedOut: number; skippedLocked: boolean };

/** Seams for the tests; production passes none. */
export type ReminderRunOptions = {
  send?: typeof sendEmail;
  clock?: () => number;
  deadlineMs?: number;
  sendTimeoutMs?: number;
};

/** One first send and at most three retries (FR-FUP-04). */
const MAX_ATTEMPTS = 4;
/** The run stops starting groups after this long; the next hourly run sends the rest (the lock lasts 15 minutes). */
const RUN_DEADLINE_MS = 10 * 60 * 1000;
const SEND_TIMEOUT_MS = 10 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Counts = { attempted: number; sent: number; failed: number; optedOut: number; deferred: number; stepsFailed: number };
type Key = { mitigationId: string; dueDate: CalendarDate; kind: ReminderKind; ownerUserId: string; attempt: number };
type Org = { orgId: string; name: string; slug: string };
type Person = { email: string; reminderEmails: boolean };
type Run = { counts: Counts; send: typeof sendEmail; sendTimeoutMs: number; pastDeadline: () => boolean };

const keyOf = (mitigationId: string, dueDate: CalendarDate, kind: ReminderKind) => `${mitigationId}|${dueDate}|${kind}`;

function groupBy<T>(list: readonly T[], keyFor: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of list) {
    const k = keyFor(x);
    const group = out.get(k);
    if (group) group.push(x); else out.set(k, [x]);
  }
  return out;
}

/**
 * The one REMINDER_RUN line of a run: counts and a closed reason, nothing else (NFR-OBS-01, NFR-PRIV-03). `failed` counts
 * every failure of the run: emails that were not sent plus log steps that could not be written.
 */
function logRun(c: Counts, reason: 'none' | 'sender_unset' | 'api_key_unset'): void {
  logSecurityEvent('REMINDER_RUN', c.stepsFailed > 0 || reason !== 'none' ? 'error' : 'info', {
    details: { attempted: c.attempted, sent: c.sent, failed: c.failed + c.stepsFailed, optedOut: c.optedOut, deferred: c.deferred, reason },
  });
}

/** Runs every organisation's reminders (see the module comment for what a failure does). */
export async function runReminders(now: Date, opts: ReminderRunOptions = {}): Promise<ReminderRunResult> {
  const counts: Counts = { attempted: 0, sent: 0, failed: 0, optedOut: 0, deferred: 0, stepsFailed: 0 };

  // Settings are checked before anything is claimed: a missing one would otherwise spend an attempt per run.
  const unset = typeof process.env.EMAIL_FROM_ADDRESS !== 'string' || process.env.EMAIL_FROM_ADDRESS.length === 0 ? 'sender_unset'
    : typeof process.env.RESEND_API_KEY !== 'string' || process.env.RESEND_API_KEY.length === 0 ? 'api_key_unset' : null;
  if (unset !== null) {
    logRun(counts, unset);
    throw new Error(`Reminder run not started: ${unset}.`);
  }

  const clock = opts.clock ?? Date.now;
  const work = async () => {
    const started = clock();
    const run: Run = {
      counts, send: opts.send ?? sendEmail, sendTimeoutMs: opts.sendTimeoutMs ?? SEND_TIMEOUT_MS,
      pastDeadline: () => clock() - started >= (opts.deadlineMs ?? RUN_DEADLINE_MS),
    };
    for (const org of await listOrganisationsForReminders()) {
      try {
        await systemContext(org.orgId, 'reminders', (lane) => runOrganisation(lane, org, now, run));
      } catch {
        counts.stepsFailed += 1;
      }
    }
    return 'done' as const;
  };
  let outcome: 'done' | 'locked';
  try {
    outcome = await withReminderRunLock(work);
  } catch (e) {
    // The lock, the organisation list or the lock's transaction failed (or outlived its 15 minutes): the counts so far are
    // still logged, without error text; the thrown error keeps the original as its cause.
    counts.stepsFailed += 1;
    logRun(counts, 'none');
    throw new Error('Reminder run: the run lock or the organisation list failed; the counts are in the REMINDER_RUN line.', { cause: e });
  }

  logRun(counts, 'none');
  if (counts.stepsFailed > 0) throw new Error(`Reminder run: ${counts.stepsFailed} step(s) failed; the counts are in the REMINDER_RUN line.`);
  return { attempted: counts.attempted, sent: counts.sent, failed: counts.failed, optedOut: counts.optedOut, skippedLocked: outcome === 'locked' };
}

/** Email send failures are outcome rows, not failed steps; a step is a log write or read that failed. */
async function runOrganisation(lane: ReminderLane, org: Org, now: Date, run: Run): Promise<void> {
  // Past the deadline an organisation is not even read, so the run ends well inside the lock's 15 minutes.
  if (run.pastDeadline()) { run.counts.deferred += 1; return; }
  const today = eatDate(now);
  const yesterday = eatDate(new Date(now.getTime() - DAY_MS));
  const rows = await lane.followUpRows();
  const ownerIds = [...new Set(rows.currentMitigations.map((m) => m.ownerUserId))];
  const [roles, accounts, history] = await Promise.all([
    lane.memberRoles(ownerIds),
    identityDb.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, email: true, isActive: true, reminderEmails: true } }),
    lane.reminderLogRows(rows.currentMitigations.map((m) => m.mitigationId)),
  ]);
  const active = new Map(accounts.map((a) => [a.id, a.isActive]));
  const people = new Map<string, Person>(accounts.map((a) => [a.id, { email: a.email, reminderEmails: a.reminderEmails }]));
  const byKey = groupBy(history, (r) => keyOf(r.mitigationId, r.dueDate, r.kind));

  // Credited to the mitigation's current owner, not to the recipient: the log has no recipient column (DEFERRAL, item 6).
  // A same-day reassignment can give one extra or one held-back email.
  const ownerOf = new Map(rows.currentMitigations.map((m) => [m.mitigationId, m.ownerUserId]));
  const sentOn = new Set<string>();
  for (const r of history) {
    const owner = ownerOf.get(r.mitigationId);
    if (r.outcome === 'sent' && owner !== undefined) sentOn.add(`${owner}|${r.kind}|${eatDate(new Date(r.at))}`);
  }

  const keys: Key[] = [];
  const optedOut: Key[] = [];
  for (const m of selectOpenMitigations(rows, (u) => canAct(roles.get(u), active.get(u)), today)) {
    if (!m.ownerCanAct) continue;
    // One extra day, and only when the once-a-day cap held the key back on its last eligible day.
    const late = reminderDueAfterCap(m.dueDate, now);
    const kind = reminderDue(m.dueDate, now) ?? (late !== null && sentOn.has(`${m.ownerUserId}|${late}|${yesterday}`) ? late : null);
    if (kind === null) continue;
    const prior = byKey.get(keyOf(m.mitigationId, m.dueDate, kind)) ?? [];
    if (prior.some((r: ReminderLogRow) => r.outcome === 'sent' || r.outcome === 'opted_out')) continue;
    // Every other attempt ended failed, or was claimed and never finished: both count.
    const attempts = new Set(prior.map((r) => r.attempt));
    if (attempts.size >= MAX_ATTEMPTS) continue;
    const key: Key = { mitigationId: m.mitigationId, dueDate: m.dueDate, kind, ownerUserId: m.ownerUserId, attempt: Math.max(0, ...attempts) + 1 };
    (people.get(m.ownerUserId)?.reminderEmails === false ? optedOut : keys).push(key);
  }

  for (const key of optedOut) {
    try {
      const res = await lane.insertReminderLog({ ...key, outcome: 'opted_out', failureCode: null });
      if (res === 'inserted') run.counts.optedOut += 1;
    } catch {
      run.counts.stepsFailed += 1;
    }
  }

  const eligible = keys.filter((k) => !sentOn.has(`${k.ownerUserId}|${k.kind}|${today}`));
  for (const group of groupBy(eligible, (k) => `${k.ownerUserId}|${k.kind}`).values()) {
    if (run.pastDeadline()) { run.counts.deferred += 1; continue; }
    try {
      await sendGroup(lane, org, group, people.get(group[0].ownerUserId)!.email, run);
    } catch {
      run.counts.stepsFailed += 1;
    }
  }
}

/** Rejects when `work` has not settled in `ms`; the work itself is left running. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('send timed out')), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** One outcome row, tried twice: the email is already out, so a single blip must not leave only a claim behind. */
async function recordOutcome(lane: ReminderLane, key: Key, outcome: 'sent' | 'failed'): Promise<void> {
  const row = { ...key, outcome, failureCode: outcome === 'failed' ? 'transport_error' : null };
  let res: 'inserted' | 'duplicate';
  let retried = false;
  try {
    res = await lane.insertReminderLog(row);
  } catch {
    retried = true;
    res = await lane.insertReminderLog(row);
  }
  // The outcome row shares the claim's attempt; the unique keys admit the pair (gap G091). On the retry,
  // 'duplicate' means the first try landed and only its reply was lost.
  if (res === 'duplicate' && !retried) throw new Error('The outcome row of a claimed attempt was refused by the unique keys.');
}

/** Claim every key of the group, send one email, record one outcome per claimed key with the claim's attempt. */
async function sendGroup(lane: ReminderLane, org: Org, group: Key[], to: string, run: Run): Promise<void> {
  // Resolved before any claim: a missing public origin throws here and leaves no claimed row behind.
  const dashboardUrl = `${publicOrigin()}/orgs/${org.slug}/dashboard`;
  const claimed: Key[] = [];
  for (const key of group) {
    const res = await lane.insertReminderLog({ ...key, outcome: 'claimed', failureCode: null });
    if (res === 'inserted') claimed.push(key);
  }
  if (claimed.length === 0) return;

  const content = { orgName: org.name, dueDate: claimed.map((k) => k.dueDate).sort()[0], dashboardUrl };
  const email = claimed[0].kind === 'due' ? mitigationDueEmail(content) : mitigationOverdueEmail(content);
  run.counts.attempted += 1;
  let outcome: 'sent' | 'failed';
  try {
    await within(run.send({ to, from: process.env.EMAIL_FROM_ADDRESS as string, ...email }), run.sendTimeoutMs);
    outcome = 'sent';
  } catch {
    // The failure is the outcome row below; no error text is kept (it can carry the address).
    outcome = 'failed';
  }
  if (outcome === 'sent') run.counts.sent += 1; else run.counts.failed += 1;

  let unrecorded = 0;
  for (const key of claimed) {
    try {
      await recordOutcome(lane, key, outcome);
    } catch {
      unrecorded += 1;
    }
  }
  if (unrecorded > 0) throw new Error(`${unrecorded} outcome row(s) of a sent group were not written.`);
}
