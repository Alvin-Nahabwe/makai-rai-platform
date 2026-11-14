import type { OrgRole } from '@prisma/client';
import type { DefinedEntry } from '@/lib/vocabulary/types';

/**
 * The words of S-22's manager, `app/(authenticated)/orgs/[slug]/settings/members/MembersManager.tsx` (plan 1A Task 19,
 * part 19b; copy audit D rows OR5 to OR53, with the coordinator's answers Q1, Q2, Q7, Q8 and Q9 of 14 November 2026).
 * That client file is the one that loads it, so it holds that screen's words and nothing else (ruling X-2: a copy
 * module ships whole to every page whose client code imports it). It imports types only. The role words are not here:
 * the server page builds them from the vocabulary (`memberRoleWords` in `lib/org/copy.ts`) and passes them as a prop
 * (ruling L5-9), and the email-failed sentence is `COPY_LINK_COPY.emailFailed`, which the screen already loads.
 */

/** One role as the members screen prints it: the vocabulary's entry (its word and its definition) and its article form. */
export type MemberRoleWord = { readonly entry: DefinedEntry; readonly withArticle: string };
/** The five roles' words, built on the server from the one map of role words and passed to the client as a prop. */
export type MemberRoleWords = Readonly<Record<OrgRole, MemberRoleWord>>;

export const MEMBERS_COPY = Object.freeze({
  /** Shown while any write waits longer than usual. */
  stillSaving: 'Still saving. The connection is slow.',
  /**
   * A lost reply or no reply in time (defect 39; answer Q1): one sentence per action, the same for both kinds. Each of
   * the first five is sent again with the same request id when pressed again unchanged, so "twice" is true of it.
   */
  lostReply: Object.freeze({
    invite: 'Not sent yet. We did not get a reply, so the invitation may already be sent. Select Invite again. It will not be sent twice.',
    resend: 'Not sent yet. We did not get a reply, so the invitation may already be sent again. Select Resend again. It will not be sent twice.',
    cancel: 'Not cancelled yet. We did not get a reply, so the invitation may already be cancelled. Select Cancel invitation again. It will not happen twice.',
    role: 'Not changed yet. We did not get a reply, so the role may already be changed. Select Change role again. It will not be changed twice.',
    remove: (name: string): string => `Not removed yet. We did not get a reply, so ${name} may already be removed. Select Remove again. It will not happen twice.`,
    leave: 'We did not get a reply, so you may already have left. Reload the page to check.',
  }),
  /** A 200 answer: the request had already been carried out (answer Q2). */
  replayed: Object.freeze({
    invite: 'This invitation was already created. If the email did not arrive, use Resend.',
    resend: 'This invitation was already resent. If the email did not arrive, use Resend again.',
  }),
  sent: (email: string): string => `Invitation sent to ${email}.`,
  cancelled: (email: string): string => `Invitation to ${email} cancelled. Its link no longer works.`,
  /** `roleWithArticle` is "an Admin", "a Viewer" and so on, from the role words prop. */
  roleChanged: (name: string, roleWithArticle: string): string => `${name} is now ${roleWithArticle}. The change takes effect at once.`,
  removed: (name: string): string => `${name} was removed.`,
  /** The sentences of a write the server refused. */
  refusals: Object.freeze({
    signedOut: 'Not saved. You have been signed out. Sign in again.',
    serverProblem: 'Not saved. The server had a problem. Try again in a moment.',
    lastOwner: (name: string): string => `${name} is the last Owner. Make someone else an Owner first.`,
    /** The person leaving is the last Owner (answer Q8). */
    lastOwnerLeaving: 'You are the last Owner. Make someone else an Owner before you leave.',
    rateLimited: 'Too many invitations just now. Try again later.',
    forbidden: 'Not saved. Your role in this organisation no longer allows this. Ask an Owner or Admin.',
    notFound: 'That member or invitation no longer exists. Reload the page.',
    alreadyMember: 'This person is already a member of this organisation.',
    notPending: 'That invitation was already accepted, cancelled or expired. Reload the page.',
    other: 'Not saved. Reload the page and try again.',
  }),
  /** The members table. */
  members: Object.freeze({
    caption: 'Members',
    columns: Object.freeze({ name: 'Name', role: 'Role', actions: 'Actions' }),
    you: ' (you)',
    copiedLink: ' account created from a copied link',
    roleFor: (name: string): string => `Role for ${name}`,
    changeRole: 'Change role',
    changeRoleFor: (name: string): string => `Change role for ${name}`,
    remove: 'Remove',
    removeName: (name: string): string => `Remove ${name}`,
    removeConsequence: 'They lose access to this organisation at once. What they entered stays in its records.',
    removeAction: 'Remove member',
  }),
  /** Leaving the organisation. */
  leave: Object.freeze({
    trigger: 'Leave this organisation',
    /** The confirmation's object when the person's own row is not on the page shown. */
    thisMember: 'This member',
    consequence: 'You lose access to this organisation. An Owner or Admin can invite you again.',
    action: 'Leave organisation',
  }),
  /** The pending invitations table. */
  invitations: Object.freeze({
    caption: 'Pending invitations',
    columns: Object.freeze({ email: 'Email', role: 'Role', expires: 'Expires', actions: 'Actions' }),
    none: 'No pending invitations.',
    showLink: 'Show the link',
    showLinkFor: (email: string): string => `Show the link when resending to ${email}`,
    resend: 'Resend',
    resendTo: (email: string): string => `Resend invitation to ${email}`,
    cancel: 'Cancel invitation',
    cancelTo: (email: string): string => `Cancel invitation to ${email}`,
    confirmObject: (email: string): string => `Invitation for ${email}`,
    consequence: 'Its link stops working at once.',
    confirmAction: 'Cancel invitation',
    /** The confirmation's own cancel button (answer Q7), so it is not a second "Cancel" beside "Cancel invitation". */
    keep: 'Keep invitation',
  }),
  /** The invite form. */
  invite: Object.freeze({
    heading: 'Invite someone',
    emailLabel: 'Email',
    roleLabel: 'Role',
    rolePlaceholder: 'Choose a role',
    roleMissing: 'Choose a role.',
    showLink: 'Also show me the link',
    showLinkHint: 'Tick this if the email might not arrive. The link is shown once, after you select Invite, so you can send it yourself.',
    submit: 'Invite',
  }),
});
