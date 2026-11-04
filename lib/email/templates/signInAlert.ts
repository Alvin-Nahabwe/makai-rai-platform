import type { EmailContent } from '../templates';
import { escapeHtml } from '../escape';

/**
 * The sign-in alert to the owner (NFR-OBS-04): counts and a time only, no account id, email or name (obligation B16).
 * `failures` and `accounts` describe a spray within the hour to `at`; `locks` one account's locks within the 24 hours to
 * `at`. Pure: no I/O; lib/auth/signInAlerts.ts sends it.
 */
export function signInAlertEmail(
  input: { kind: 'spray'; failures: number; accounts: number; at: Date } | { kind: 'repeated_lock'; locks: number; at: Date },
): EmailContent {
  const what = input.kind === 'spray'
    ? `${input.failures} failed sign-ins across ${input.accounts} accounts in the hour`
    : `an account was locked ${input.locks} times in the 24 hours`;
  const text = `Sign-in alert: ${what} to ${input.at.toISOString().slice(0, 19)} UTC. Read the security log on the host. This message carries no other data.`;
  return { subject: '[makrai] Sign-in alert', text, html: `<p>${escapeHtml(text)}</p>` };
}
