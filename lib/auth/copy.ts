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
  rateLimited: (minutes: number): string =>
    minutes === 1 ? 'Too many sign-ins right now. Wait 1 minute and try again.' : `Too many sign-ins right now. Wait ${minutes} minutes and try again.`,
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
