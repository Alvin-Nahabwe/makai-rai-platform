/**
 * Task 9 constraint 1: pure functions, no I/O. This module builds the
 * invitation email's subject/html/text and nothing else — no network call,
 * no env read, no logging. `lib/email/send.ts` is the transport; this file
 * never imports it, so a template change can never accidentally start
 * sending mail.
 */

export interface InvitationEmailInput {
  /** Display name of the inviting organization. Not escaped by the caller —
   * this function HTML-escapes it before interpolating into `html`, because
   * an org name is user-supplied (set at org creation) and an unescaped
   * value would let one org's chosen name inject markup into an email sent
   * on another user's behalf. */
  orgName: string;
  role: string;
  /** The one-time accept link. Embedding it in the email body is the whole
   * point of this template — it is not a log line, so AGENTS.md's "don't
   * log the token/URL" constraint (which governs security-logger/console
   * output) does not apply here. */
  acceptUrl: string;
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function invitationEmail(input: InvitationEmailInput): EmailContent {
  const { orgName, role, acceptUrl } = input;
  const safeOrgName = escapeHtml(orgName);
  const safeRole = escapeHtml(role);

  const subject = `You've been invited to join ${orgName} on the MAK-AI RAI Toolkit`;

  const text = [
    `You have been invited to join ${orgName} as ${role} on the MAK-AI RAI Toolkit.`,
    '',
    'Accept your invitation:',
    acceptUrl,
    '',
    'This link is single-use and expires in 7 days. If you were not expecting this invitation, you can ignore this email.',
  ].join('\n');

  const html = [
    `<p>You have been invited to join <strong>${safeOrgName}</strong> as <strong>${safeRole}</strong> on the MAK-AI RAI Toolkit.</p>`,
    `<p><a href="${acceptUrl}">Accept your invitation</a></p>`,
    '<p>This link is single-use and expires in 7 days. If you were not expecting this invitation, you can ignore this email.</p>',
  ].join('\n');

  return { subject, html, text };
}
