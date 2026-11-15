/**
 * The words of signing in and passwords. `AUTH_COPY` is read by server components (the pages); each client component
 * reads its own screen's constant below. The bundler ships this module whole to every page whose client code imports
 * it, separate constants included (ruling T16-18), so the constants are for reading, not for weight: every word here
 * reaches the browser. Words only the server prints do not belong here (the password route's answers are
 * `PASSWORD_ROUTE_COPY` in `lib/http/api/copy.ts`).
 */

const SHOW_PASSWORD = 'Show password';
const PASSWORD_CHANGED = 'Password changed. Please sign in with your new password.';
const SOMETHING_WENT_WRONG = 'Something went wrong on our side. Try again.';
const PASSWORD_HINT = (min: number): string => `At least ${min} characters.`;
/**
 * The admission's 429 (spec 9.7: the wait in words, beside the action), in whole minutes rounded up. It counts every
 * sign-in from a browser it does not know, across the platform (lib/auth/signInAdmission.ts, never per person or
 * address), so the words say that many people are signing in, not that this person tried too often (ruling L5-9). A
 * locked account answers M-20 instead.
 */
const TOO_MANY_SIGN_INS = (minutes: number): string =>
  minutes === 1
    ? 'Too many people are signing in right now. Wait 1 minute, then try again.'
    : `Too many people are signing in right now. Wait ${minutes} minutes, then try again.`;

export const AUTH_COPY = Object.freeze({
  titles: Object.freeze({
    signIn: 'Sign in',
    forgotPassword: 'Forgot password',
    resetPassword: 'Set a new password',
    changePassword: 'Change your password',
  }),
  logoAlt: 'MAK-AI',
  loading: 'Loading...',
  /** The heading of the forgot-password page: the action, not the problem (audit A 138). */
  resetHeading: 'Reset your password',
  backToSignIn: 'Back to sign in',
  showPassword: SHOW_PASSWORD,
  /** S-01's footer (A page verdict, S-01): accounts come only from an invitation; "Owner" is the role's name (§2). */
  noAccount: 'No account? You need an invitation. Ask an Owner of your organisation to invite you.',
  /** S-01 after the idle sign-out (C12), read from the hint IdleWarning leaves (lib/auth/idle.ts). */
  signedOutIdle: 'You were signed out because 12 hours passed since you signed in or last chose Stay signed in.',
  /** S-01 after the 7-day limit (C12). */
  signedOutAbsolute: 'You were signed out because 7 days passed since you signed in.',
  /** Under either signed-out line. */
  signedOutKept: 'Sign in again to carry on. Unsaved decisions and mitigations you typed in this browser come back when you open them again.',
  tooManyAttempts: TOO_MANY_SIGN_INS,
  /** S-02's lead (audit A 138). */
  forgotLead: 'Enter the email you use to sign in. We will send you a link to set a new password.',
  /** The line under the change-password heading (audit A 61). */
  changeLead: 'When you change your password, you are signed out on every device, including this one. Then sign in with your new password.',
});

/**
 * The three answers that more than one place says (SRS 7.5.7 M-20, M-21, M-22). `lib/http/messages.ts` re-exports them
 * as `M20`, `M21` and `M22`, the names the screens and the routes import.
 */
export const AUTH_MESSAGE_COPY = Object.freeze({
  /** M-20: one text for a wrong password, a locked account and an unknown email. */
  wrongCredentials: 'The email or password is wrong. Check them and try again. After five wrong tries an account is locked for 15 minutes. You can also reset your password.',
  /** M-21: one answer whatever the address. */
  resetLinkSent: 'If an account exists for this email, we have sent a link. It works once and expires in 30 minutes.',
  /** M-22: a reset link that is used, expired, voided or unknown. */
  resetLinkUnusable: 'This link has expired or has already been used. Ask for a new one.',
});

/** Sign in (S-01), read by LoginClient. */
export const SIGN_IN_COPY = Object.freeze({
  heading: 'Sign in',
  email: 'Email',
  password: 'Password',
  showPassword: SHOW_PASSWORD,
  submit: 'Sign in',
  submitting: 'Signing in...',
  forgotLink: 'Forgot your password?',
  passwordChanged: PASSWORD_CHANGED,
  signedOut: 'You are signed out. Sign in, then start the download again.',
  busy: 'Too many people are signing in right now. Wait a minute, then try again.',
  serverProblem: 'We could not sign you in because of a problem on our side. Wait a few minutes, then try again.',
  connectionLost: 'We could not sign you in. Check your internet connection and try again.',
  /** The admission's 429, with the wait in whole minutes rounded up (one sentence for 1, one for more). */
  rateLimited: TOO_MANY_SIGN_INS,
});

/** Forgot password (S-02), read by ForgotPasswordClient. */
export const FORGOT_COPY = Object.freeze({
  email: 'Email',
  submit: 'Send reset link',
  notReached: 'The link was not sent. Check your internet connection and try again.',
  serverProblem: 'The link was not sent because of a problem on our side. Wait a few minutes, then try again.',
});

/** Set a new password (S-03), read by ResetPasswordClient. */
export const RESET_COPY = Object.freeze({
  newPassword: 'New password',
  showPassword: SHOW_PASSWORD,
  hint: PASSWORD_HINT,
  submit: 'Set password',
  askNewLink: 'Ask for a new link',
  loading: 'Loading...',
  passwordChanged: PASSWORD_CHANGED,
  notReached: 'Your password was not changed. Check your internet connection and try again. Your link still works.',
  serverProblem: 'Your password was not changed because of a problem on our side. Try again. If the link no longer works, ask for a new one.',
});

/** Change password (S-29 and S-21's link), read by ChangePasswordForm. */
export const CHANGE_PASSWORD_COPY = Object.freeze({
  currentPassword: 'Current password',
  newPassword: 'New password',
  showPasswords: 'Show passwords',
  hint: PASSWORD_HINT,
  submit: 'Change password',
  submitting: 'Saving...',
  notChanged: 'Your password was not changed. Check your internet connection and try again.',
  /** A failure on our side; with the support reference when the answer carried one, without it when not. */
  serverProblem: (reference: string | null): string =>
    reference === null
      ? SOMETHING_WENT_WRONG
      : `Something went wrong on our side. Try again. If this keeps happening, contact MAK-AI and give this reference: ${reference}.`,
});
