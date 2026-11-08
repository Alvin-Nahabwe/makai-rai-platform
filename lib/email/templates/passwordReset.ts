import type { EmailContent } from '../templates';
import { escapeHtml } from '../escape';

/**
 * E-03 (FR-ACC-06, SRS 7.5.9 line 2602): the reset link. `resetUrl` is S-03 with the token after `#token=`, so the token is
 * never in a request line a server or proxy logs; S-03 sends it in the request body (NFR-OBS-01). SRS 6.1: no record text
 * and no email address. Pure: no I/O; lib/data/passwordReset.ts sends it.
 */
export function passwordResetEmail(input: { resetUrl: string }): EmailContent {
  const before = 'Use this link to set a new password: ';
  const after = '. It works once and expires in 30 minutes. If you did not ask for this, you can ignore this email; nothing will change.';
  return {
    subject: 'Reset your MAK-AI RAI Platform password',
    text: `${before}${input.resetUrl}${after}`,
    html: `<p>${escapeHtml(before)}<a href="${escapeHtml(input.resetUrl)}">${escapeHtml(input.resetUrl)}</a>${escapeHtml(after)}</p>`,
  };
}
