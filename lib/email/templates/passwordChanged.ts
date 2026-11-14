import type { EmailContent } from '../templates';
import { escapeHtml } from '../escape';
import { EMAIL_COPY } from '../copy';
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
  const { passwordChanged } = EMAIL_COPY;
  const intro = passwordChanged.intro(formatDay(input.changedAt, 'UTC'), hhmm);
  return {
    subject: passwordChanged.subject,
    text: [`${intro}\n${resetUrl}`, passwordChanged.closing].join('\n\n'),
    html: [
      `<p>${intro}</p>`,
      `<p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p>`,
      `<p>${passwordChanged.closing}</p>`,
    ].join('\n'),
  };
}
