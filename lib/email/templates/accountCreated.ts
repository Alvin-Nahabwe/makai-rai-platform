import { escapeHtml, type EmailContent } from '../templates';
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
  const before = `An account was created for this address in ${input.orgName} on ${formatDay(input.createdAt)}. If this was not you, reset your password: `;
  const after = ', and tell the organisation\'s owner.';
  return {
    subject: 'An account was created for this address',
    text: `${before}${resetUrl}${after}`,
    html: `<p>${escapeHtml(before)}<a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a>${escapeHtml(after)}</p>`,
  };
}
