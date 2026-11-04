import type { EmailContent } from '../templates';
import { escapeHtml } from '../escape';
import { formatDay } from '../../format/dates';
import { publicOrigin } from '../../publicOrigin';

/**
 * E-02 (FR-ACC-09, SRS 7.5.9 line 2601): sent to the account after every completed password change (S-21, S-29) and
 * reset (S-03). With no multi-factor sign-in in v1, this notice is how a takeover reaches the account holder. SRS 6.1: no
 * record text and no email address; its one link is S-02, whose address carries nothing. The time is written in UTC, with
 * its zone, because the server does not know the reader's. Pure: no I/O.
 */
export function passwordChangedEmail(input: { changedAt: Date }): EmailContent {
  const resetUrl = new URL('/forgot-password', publicOrigin()).toString();
  const hhmm = input.changedAt.toISOString().slice(11, 16);
  const before = `The password for your account was changed on ${formatDay(input.changedAt, 'UTC')} at ${hhmm} UTC. If this was not you, reset your password now: `;
  const after = ', and tell your organisation\'s owner.';
  return {
    subject: 'Your MAK-AI RAI Platform password was changed',
    text: `${before}${resetUrl}${after}`,
    html: `<p>${escapeHtml(before)}<a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a>${escapeHtml(after)}</p>`,
  };
}
