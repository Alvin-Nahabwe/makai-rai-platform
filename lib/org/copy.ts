import type { OrgRole } from '@prisma/client';
import type { DefinedEntry, VocabularyEntry } from '@/lib/vocabulary/types';
import type { OrgEventAction } from '@/types/record';
import type { MemberRoleWords } from '@/lib/org/members/copy';
import { TERM_ADMIN, TERM_ASSESSOR, TERM_MAK_AI_ADMINISTRATOR, TERM_OWNER, TERM_REVIEWER, TERM_VIEWER } from '@/lib/vocabulary/terms';

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
    /** Also the page's heading (audit D OR54, OR55). */
    organisation: 'Organisation details',
    invitation: 'Invitation',
  }),
  /** The organisation chooser, `/` (audit A 3 to 6). Server code only. */
  chooser: Object.freeze({
    heading: 'Choose an organisation',
    listLabel: 'Your organisations',
    emptyHeading: 'Welcome',
    emptyBody: "You are not a member of any organisation yet. Ask the Owner of your team's organisation to invite you. You will get the invitation by email.",
    /** The empty state's own title, over `emptyBody` (plan 1B Task 8: the kit's EmptyState, which takes a title). */
    emptyTitle: 'No organisation yet',
    /** Each organisation's line of state: `roleWithArticle` is "an Owner", "a Viewer" and so on (plan 1B Task 8). */
    youAre: (roleWithArticle: string): string => `You are ${roleWithArticle}`,
  }),
  /** S-22 Members, the page's own words (audit D OR3, OR4); the manager's are `MEMBERS_COPY` (lib/org/members/copy.ts). */
  members: Object.freeze({
    /** Shown only to a role that may invite (Owners and Admins). */
    lead: 'Owners and Admins: invite people, change roles and remove members here.',
    showMore: 'Show more',
  }),
  /** S-30 Organisation details (audit D OR56 to OR58, OR86; the legal plan's legal-name line). */
  organisation: Object.freeze({
    legalName: (legalName: string | null): string => `Legal name: ${legalName ?? 'Not recorded'}`,
    /** The heading over the download link, shown only to a role that can download (ruling L5-12). */
    downloadHeading: 'Download records',
    download: "Download all of this organisation's records (every project)",
  }),
  /** S-30's changes table, `components/org/OrganisationEventsList.tsx` (audit D OR66 to OR85; answers Q4, Q10 and Q23). */
  events: Object.freeze({
    heading: 'Changes to members and the organisation',
    none: 'No changes recorded yet.',
    caption: 'Changes to this organisation and its members, newest first',
    columns: Object.freeze({
      when: 'When', who: 'Who', what: 'What', concerning: 'Member or invitation', reason: 'Reason or request reference', before: 'Before the change',
    }),
    /** The actor's role when it was the platform's administrator; a member's role is the vocabulary's word. */
    administrator: TERM_MAK_AI_ADMINISTRATOR.term,
    /** Each action in plain words (SRS 7.5). The new role of a role change is defect 43, stage 3's. */
    actions: Object.freeze({
      organisation_created: 'Created the organisation',
      agreement_recorded: 'Recorded the organisation agreement',
      owner_invitation_issued: 'Invited an Owner',
      owner_invitation_resent: 'Resent the owner invitation',
      owner_invitation_revoked: 'Cancelled the owner invitation',
      organisation_name_corrected: 'Changed the organisation name',
      organisation_legal_name_corrected: "Changed the institution's legal name",
      account_deactivated: 'Deactivated an account',
      account_reactivated: 'Reactivated an account',
      member_invited: 'Invited a member',
      member_joined: 'Joined the organisation',
      member_role_changed: "Changed a member's role",
      member_removed: 'Removed a member',
      member_left: 'Left the organisation',
    } satisfies Record<OrgEventAction, string>),
    showOlder: 'Show older',
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

const ROLE_TERMS: Readonly<Record<OrgRole, DefinedEntry>> = Object.freeze({
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

/** Whether a role read as text (orgRoleLabel returns the membership's role as text) is one of the five organisation roles. */
export function isOrgRole(label: string): label is OrgRole {
  return Object.hasOwn(ROLE_TERMS, label);
}

/**
 * The five roles' words for S-22's client manager (ruling L5-9): each role's vocabulary entry (its word and the
 * definition shown under the invite form's role choice) and its article form, read from the one map above and passed
 * as a prop, so the client file imports neither this module nor the vocabulary. Words only: the screen decides nothing
 * from it. Server code only.
 */
export function memberRoleWords(): MemberRoleWords {
  const word = (role: OrgRole) => Object.freeze({ entry: ROLE_TERMS[role], withArticle: roleWithArticle(role) });
  return Object.freeze({ owner: word('owner'), admin: word('admin'), assessor: word('assessor'), reviewer: word('reviewer'), viewer: word('viewer') });
}

/**
 * The welcome line on the dashboard after joining (audit A 100): `roleSentence` is `roleWithArticle(role)`, never a raw role
 * value. The sentence that says what the role can do is plan 1B's.
 */
export function welcomeLine(organisationName: string, roleSentence: string): string {
  return `Welcome to ${organisationName}. You are ${roleSentence}.`;
}
