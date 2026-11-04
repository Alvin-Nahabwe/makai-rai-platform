import { mailUnavailable, sendEmail } from '../email/send';
import { signInAlertEmail } from '../email/templates/signInAlert';
import { logSecurityEvent } from '../security-logger';

/**
 * The password-spraying alert (NFR-OBS-04, SRS line 3370). Ruling 10 removed the address-keyed sign-in limits, which were
 * the coarse defence against one attacker trying a few passwords on many accounts; this alarm restores visibility without
 * locking out shared addresses. `lib/auth/credentials.ts` reports every refused sign-in for an existing account here;
 * failures for unknown emails name no account and are not counted.
 *
 * Two rules, in-process sliding windows (one process, K-5):
 * - spray: more than SPRAY_FAILURES failures across at least SPRAY_ACCOUNTS accounts within an hour gives one alert,
 *   then none for an hour;
 * - repeated lock: one account locked LOCKS_PER_DAY or more times within 24 hours gives one alert for that account per
 *   24 hours.
 * Each alert logs SIGN_IN_ALERT with its kind and count and mails ADMIN_EMAIL, where the host's own alerts already go
 * (ops/host/makrai-lib.sh), from EMAIL_FROM_ADDRESS. The mail carries counts and a time only: no account id, email or
 * name (obligation B16). A send that fails, or cannot be made, is logged at error and never thrown into the sign-in.
 */
export const SPRAY_FAILURES = 50;
export const SPRAY_ACCOUNTS = 10;
export const LOCKS_PER_DAY = 3;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let failures: Array<{ userId: string; at: number }> = [];
let lastSprayAlertAt = -Infinity;
const locks = new Map<string, number[]>();
const lastLockAlertAt = new Map<string, number>();

/** Tests only: forgets every window. */
export function resetSignInAlerts(): void {
  failures = [];
  lastSprayAlertAt = -Infinity;
  locks.clear();
  lastLockAlertAt.clear();
}

export function recordSignInFailure(e: { userId: string; locked: boolean }, now: Date = new Date()): void {
  const t = now.getTime();

  failures = failures.filter((f) => f.at > t - HOUR_MS);
  failures.push({ userId: e.userId, at: t });
  if (failures.length > SPRAY_FAILURES && t - lastSprayAlertAt >= HOUR_MS) {
    const accounts = new Set(failures.map((f) => f.userId)).size;
    if (accounts >= SPRAY_ACCOUNTS) {
      lastSprayAlertAt = t;
      alert('spray', failures.length, signInAlertEmail({ kind: 'spray', failures: failures.length, accounts, at: now }));
    }
  }

  // Only the account's own list is kept past a day, so the map holds accounts locked in the last 24 hours.
  for (const [id, times] of locks) {
    const kept = times.filter((x) => x > t - DAY_MS);
    if (kept.length === 0) locks.delete(id);
    else locks.set(id, kept);
  }
  if (!e.locked) return;
  const times = [...(locks.get(e.userId) ?? []), t];
  locks.set(e.userId, times);
  if (times.length >= LOCKS_PER_DAY && t - (lastLockAlertAt.get(e.userId) ?? -Infinity) >= DAY_MS) {
    lastLockAlertAt.set(e.userId, t);
    alert('repeated_lock', times.length, signInAlertEmail({ kind: 'repeated_lock', locks: times.length, at: now }));
  }
}

type AlertKind = 'spray' | 'repeated_lock';

/** Logs the alert and starts the mail; returns at once, so sign-in never waits on the mail provider. */
function alert(kind: AlertKind, count: number, mail: { subject: string; text: string; html: string }): void {
  logSecurityEvent('SIGN_IN_ALERT', 'warn', { details: { kind, count } });
  const notMailed = (reason: 'recipient_unset' | 'sender_unset' | 'api_key_unset' | 'send_failed') =>
    logSecurityEvent('SIGN_IN_ALERT', 'error', { details: { kind, count, mailed: false, reason } });
  const to = process.env.ADMIN_EMAIL;
  if (!to) return notMailed('recipient_unset');
  const unavailable = mailUnavailable();
  if (unavailable) return notMailed(unavailable);
  const from = process.env.EMAIL_FROM_ADDRESS as string;
  // The provider's error text can carry the address, so only a fixed reason is logged (NFR-PRIV-03).
  sendEmail({ to, from, ...mail }).catch(() => notMailed('send_failed'));
}
