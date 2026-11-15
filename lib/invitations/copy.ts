/**
 * The words the invitation page's client half shows (plan 1A Task 16b). This module imports nothing: the public
 * invitation page loads it in the browser, and a copy module ships whole (ruling T16-18), so it holds `INVITATION_COPY`
 * only. The page's own server-rendered words and M-23 are `INVITATION_PAGE_COPY` in `lib/org/copy.ts`; the copy-link
 * box of the members screens is `lib/invitations/link/copy.ts`; route 32's answer is in `lib/http/api/copy.ts`.
 */

/** What the invitation page's client half shows: the three branches of S-04. */
export const INVITATION_COPY = Object.freeze({
  accountCreated: 'Your account was created. Sign in to continue.',
  signIn: 'Sign in',
  /** Route 31's 409 `account_exists` (audit A 270); the screen puts the sign-in link after it. */
  accountExists: 'You already have an account with this email. Sign in to accept the invitation.',
  nameRequired: 'Enter your name.',
  /** Route 31 refuses a name that reads as a link (FR-MEM-01, obligation M9; audit A 273). */
  nameHasWebAddress: 'A name cannot contain a web address.',
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
  /** The steps of joining in the gate frame's route (plan 1B Task 6, ruling L5-14), drawn in the browser as the step
   * changes (ruling L5-28); "Accept the terms" is GATE_COPY's. */
  stops: Object.freeze({ details: 'Your details', join: 'Join' }),
});
