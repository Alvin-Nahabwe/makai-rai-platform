import type { OrgRole } from '@prisma/client';
import type { VocabularyEntry } from '@/lib/vocabulary/types';
import { TERM_ADMIN, TERM_ASSESSOR, TERM_OWNER, TERM_REVIEWER, TERM_VIEWER } from '@/lib/vocabulary/terms';

/**
 * The words of the organisation screens: their titles, the organisation chooser, the invitation page's own words, the role
 * names with their articles and the welcome line. Only server code reads this module; no client file imports it.
 */
export const ORG_COPY = Object.freeze({
  titles: Object.freeze({
    chooser: 'Choose an organisation',
    projects: 'Projects',
    newProject: 'New project',
    members: 'Members',
    organisation: 'Organisation',
    invitation: 'Invitation',
  }),
  /** The organisation chooser, `/` (audit A 3 to 6). Server code only. */
  chooser: Object.freeze({
    heading: 'Choose an organisation',
    listLabel: 'Your organisations',
    emptyHeading: 'Welcome',
    emptyBody: "You are not a member of any organisation yet. Ask the Owner of your team's organisation to invite you. You will get the invitation by email.",
  }),
});

/** "invited you to join as an Assessor": the part of the invited line that names the role (audit A 159). */
const INVITED_AS = (roleWithArticle: string): string => `invited you to join as ${roleWithArticle}`;

/**
 * The invitation page's own words (S-04's server half) and M-23, which the page, `lib/http/messages.ts` and routes 31
 * and 32 say. Server code only, like the rest of this module.
 */
export const INVITATION_PAGE_COPY = Object.freeze({
  /** M-23 (SRS 7.5.7): one text for every unusable invitation (expired, used, revoked, replaced or unknown). */
  unusable: 'This invitation link does not work. It may have expired, been used, or been replaced by a newer one. Ask the person who invited you to send it again.',
  /** The heading over M-23 (audit A 160). */
  unusableHeading: 'This invitation cannot be used',
  heading: (org: string): string => `You are invited to ${org}`,
  /** `roleWithArticle` is "an Owner", "a Viewer" and so on, from `roleWithArticle` below (audit A 159). */
  invitedAs: INVITED_AS,
  invitedLine: (inviter: string, roleWithArticle: string, date: string): string =>
    `${inviter} ${INVITED_AS(roleWithArticle)}. This invitation ends on ${date}.`,
});

const ROLE_TERMS: Readonly<Record<OrgRole, VocabularyEntry>> = Object.freeze({
  owner: TERM_OWNER,
  admin: TERM_ADMIN,
  assessor: TERM_ASSESSOR,
  reviewer: TERM_REVIEWER,
  viewer: TERM_VIEWER,
});

/** The vocabulary's entry for a role: a raw role value is never written into a sentence. */
export function roleTerm(role: OrgRole): VocabularyEntry {
  return ROLE_TERMS[role];
}

/**
 * The role as a sentence names it, with its article: "an Owner", "an Admin", "an Assessor", "a Reviewer", "a Viewer".
 * Server code only: no client file may import this module, which reads the vocabulary.
 */
export function roleWithArticle(role: OrgRole): string {
  const term = roleTerm(role).term;
  return `${/^[AEIOU]/.test(term) ? 'an' : 'a'} ${term}`;
}

/**
 * The welcome line on the dashboard after joining (audit A 100): `roleSentence` is `roleWithArticle(role)`, never a raw role
 * value. The sentence that says what the role can do is plan 1B's.
 */
export function welcomeLine(organisationName: string, roleSentence: string): string {
  return `Welcome to ${organisationName}. You are ${roleSentence}.`;
}
