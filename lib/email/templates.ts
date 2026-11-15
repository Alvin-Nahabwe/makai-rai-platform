/**
 * Task 9 constraint 1: pure functions, no I/O. This module builds the
 * invitation email's subject/html/text and nothing else — no network call,
 * no env read, no logging. `lib/email/send.ts` is the transport; this file
 * never imports it, so a template change can never accidentally start
 * sending mail.
 */

import { escapeHtml } from './escape';
import { formatDay } from '../format/dates';
import { EMAIL_COPY } from './copy';
import { roleWithArticle } from '../org/copy';
import type { OrgRole } from '@prisma/client';

export interface InvitationEmailInput {
  /** Display name of the inviting organisation. HTML-escaped here before it goes into `html`: an organisation
   * name is user-supplied, and an unescaped one would let it inject markup into an email sent on another
   * user's behalf. */
  orgName: string;
  role: OrgRole;
  /** The one-time accept link. It belongs in the email body (the point of this template); it is never logged. */
  acceptUrl: string;
  /** When the link stops working (FR-MEM-01, E-01: "works once and expires on <date>"). */
  expiresAt: Date;
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}


/** E-01 (SRS 7.5.8, line 2601). The input has no inviter field, so the email can never name one. */
export function invitationEmail(input: InvitationEmailInput): EmailContent {
  const { orgName, role, acceptUrl, expiresAt } = input;
  const expiry = formatDay(expiresAt);
  const roleSentence = roleWithArticle(role);
  const { invitation } = EMAIL_COPY;
  // The role's article is part of the vocabulary's sentence, so the whole phrase is the bold run.
  const intro = invitation.intro(`<strong>${escapeHtml(orgName)}</strong>`, `<strong>${roleSentence}</strong>`);
  return {
    subject: invitation.subject(orgName),
    text: [invitation.intro(orgName, roleSentence), `${invitation.linkLead}\n${acceptUrl}`, invitation.closing(expiry)].join('\n\n'),
    html: [
      `<p>${intro}</p>`,
      `<p>${invitation.linkLead}</p>`,
      `<p><a href="${escapeHtml(acceptUrl)}">${escapeHtml(acceptUrl)}</a></p>`,
      `<p>${invitation.closing(expiry)}</p>`,
    ].join('\n'),
  };
}
