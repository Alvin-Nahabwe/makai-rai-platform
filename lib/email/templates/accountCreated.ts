import type { EmailContent } from '../templates';
import { escapeHtml } from '../escape';
import { EMAIL_COPY } from '../copy';
import { formatDay } from '../../format/dates';
import { publicOrigin } from '../../publicOrigin';

/**
 * E-06 (FR-ACC-10, SRS 7.5.9 line 2606): sent to the invited address when an account is created
 * from an invitation, so the person the invitation named learns of it even when someone else
 * held the link. SRS 6.1: no record text and no email address in it; its links are the reset page (S-02) and, last, the
 * sign-in page (S-01; plan 1B Task 6, C9, which changes SRS 7.5.9's one-link rule until the SRS revision, request R9),
 * neither address carrying anything; the organisation name is escaped in the HTML part.
 * Pure: no I/O; the route sends it through lib/email/send.ts.
 */
export function accountCreatedEmail(input: { orgName: string; createdAt: Date }): EmailContent {
  const resetUrl = new URL('/forgot-password', publicOrigin()).toString();
  const signInUrl = new URL('/login', publicOrigin()).toString();
  const { accountCreated } = EMAIL_COPY;
  const date = formatDay(input.createdAt);
  const link = (url: string) => `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
  return {
    subject: accountCreated.subject,
    text: [
      `${accountCreated.intro(input.orgName, date)}\n${resetUrl}`, accountCreated.closing(input.orgName), `${accountCreated.later}\n${signInUrl}`,
    ].join('\n\n'),
    html: [
      `<p>${accountCreated.intro(escapeHtml(input.orgName), date)}</p>`,
      `<p>${link(resetUrl)}</p>`,
      `<p>${accountCreated.closing(escapeHtml(input.orgName))}</p>`,
      `<p>${accountCreated.later}</p>`,
      `<p>${link(signInUrl)}</p>`,
    ].join('\n'),
  };
}
