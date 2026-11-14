/**
 * The words of joining by invitation (plan 1A Task 16b). This module imports nothing: the invitation page and the
 * members screens load it in the browser, and a copy module ships whole (ruling T16-18). Words that need the vocabulary
 * (a role's name) arrive as arguments: `roleWithArticle` lives in `lib/org/copy.ts`, which no client file may import.
 */

/** "invited you to join as an Assessor": the part of the invited line that names the role (audit A 159). */
const INVITED_AS = (roleWithArticle: string): string => `invited you to join as ${roleWithArticle}`;

/** The invitation page itself and its two routes (server code); M-23 is here because the page and routes 31 and 32 say it. */
export const INVITATION_PAGE_COPY = Object.freeze({
  /** M-23 (SRS 7.5.7): one text for every unusable invitation (expired, used, revoked, replaced or unknown). */
  unusable: 'This invitation link does not work. It may have expired, been used, or been replaced by a newer one. Ask the person who invited you to send it again.',
  /** The heading over M-23 (audit A 160). */
  unusableHeading: 'This invitation cannot be used',
  heading: (org: string): string => `You are invited to ${org}`,
  /** `roleWithArticle` is "an Owner", "a Viewer" and so on, from `lib/org/copy.ts` (audit A 159). */
  invitedAs: INVITED_AS,
  invitedLine: (inviter: string, roleWithArticle: string, date: string): string =>
    `${inviter} ${INVITED_AS(roleWithArticle)}. This invitation ends on ${date}.`,
  /** Route 32's 409 `wrong_account` (audit A 269). */
  wrongAccountRoute: 'This invitation was sent to a different email address. Sign out, then sign in with that email address.',
});

/** What the invitation page's client half shows: the three branches of S-04. */
export const INVITATION_COPY = Object.freeze({
  accountCreated: 'Your account was created. Sign in to continue.',
  signIn: 'Sign in',
  /** Route 31's 409 `account_exists` (audit A 270); the screen puts the sign-in link after it. */
  accountExists: 'You already have an account with this email. Sign in to accept the invitation.',
  nameRequired: 'Enter your name.',
  wrongAccount: (viewerEmail: string, invitedEmail: string): string =>
    `You are signed in as ${viewerEmail}, but this invitation is for ${invitedEmail}. Sign out, then open the link again.`,
  signOut: 'Sign out',
  accept: 'Accept invitation',
  acceptAndContinue: 'Accept and continue',
  saving: 'Saving...',
  createHeading: 'Create your account',
  email: 'Email',
  emailHint: 'This is the email your invitation was sent to. You cannot change it.',
  name: 'Your name',
  nameHint: 'Your colleagues will see this name. You cannot change it later.',
  password: 'Password',
  showPassword: 'Show password',
  passwordHint: (min: number): string => `At least ${min} characters.`,
  continue: 'Continue',
  createAccount: 'Create account',
  creating: 'Creating your account...',
  alreadyHave: 'Already have an account with this email?',
  signInToAccept: 'Sign in to accept',
});

/** The copy-link box of the members and administrator screens. */
export const COPY_LINK_COPY = Object.freeze({
  copied: 'Link copied.',
  copyFailed: 'The link could not be copied. Select it and copy it by hand.',
  emailFailed: 'The invitation email could not be sent. Send this link another way.',
  linkLabel: 'Invitation link',
  copy: 'Copy link',
  worksOnce: (date: string): string => `The link works once and expires on ${date}.`,
  resend: 'Send the email again and show the link',
});
