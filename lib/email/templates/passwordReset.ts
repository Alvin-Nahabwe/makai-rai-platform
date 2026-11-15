import type { EmailContent } from '../templates';
import { escapeHtml } from '../escape';
import { EMAIL_COPY } from '../copy';

/**
 * E-03 (FR-ACC-06, SRS 7.5.9 line 2602): the reset link. `resetUrl` is S-03 with the token after `#token=`, so the token is
 * never in a request line a server or proxy logs; S-03 sends it in the request body (NFR-OBS-01). SRS 6.1: no record text
 * and no email address. Pure: no I/O; lib/data/passwordReset.ts sends it.
 */
export function passwordResetEmail(input: { resetUrl: string }): EmailContent {
  const { passwordReset } = EMAIL_COPY;
  return {
    subject: passwordReset.subject,
    text: [`${passwordReset.linkLead}\n${input.resetUrl}`, passwordReset.closing].join('\n\n'),
    html: [
      `<p>${passwordReset.linkLead}</p>`,
      `<p><a href="${escapeHtml(input.resetUrl)}">${escapeHtml(input.resetUrl)}</a></p>`,
      `<p>${passwordReset.closing}</p>`,
    ].join('\n'),
  };
}
