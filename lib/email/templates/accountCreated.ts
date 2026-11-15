import type { EmailContent } from '../templates';
import { escapeHtml } from '../escape';
import { EMAIL_COPY } from '../copy';
import { formatDay } from '../../format/dates';
import { publicOrigin } from '../../publicOrigin';

/**
 * E-06 (FR-ACC-10, SRS 7.5.9 line 2606): sent to the invited address when an account is created
 * from an invitation, so the person the invitation named learns of it even when someone else
 * held the link. SRS 6.1: no record text and no email address in it; its one link is the reset
 * page (S-02), whose address carries nothing; the organisation name is escaped in the HTML part.
 * Pure: no I/O; the route sends it through lib/email/send.ts.
 */
export function accountCreatedEmail(input: { orgName: string; createdAt: Date }): EmailContent {
  const resetUrl = new URL('/forgot-password', publicOrigin()).toString();
  const { accountCreated } = EMAIL_COPY;
  const date = formatDay(input.createdAt);
  const link = `<a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a>`;
  return {
    subject: accountCreated.subject,
    text: [`${accountCreated.intro(input.orgName, date)}\n${resetUrl}`, accountCreated.closing(input.orgName)].join('\n\n'),
    html: [
      `<p>${accountCreated.intro(escapeHtml(input.orgName), date)}</p>`,
      `<p>${link}</p>`,
      `<p>${accountCreated.closing(escapeHtml(input.orgName))}</p>`,
    ].join('\n'),
  };
}
