/**
 * The words of the session's end (UX-43, SRS 7.6.1; plan 1B Task 4): the warning two minutes before the idle deadline, and
 * the notice once the session has ended. Kept apart from lib/auth/copy.ts because components/layout/IdleWarning.tsx is on
 * every signed-in page and needs only these; AUTH_COPY carries the same words for the door pages.
 *
 * The rule they state is the code's (lib/auth/idle.ts): a session ends 12 hours after sign-in or after the last "Stay
 * signed in", and in any case 7 days after sign-in (owner's ruling R10: never "because nothing has happened").
 */
export const IDLE_TEXTS = Object.freeze({
  /** The dialog's title, its accessible name. */
  warningTitle: 'You will be signed out in 2 minutes',
  /** The rule and what to do now (R10, lead's ruling L5-10). */
  warningBody: 'For your security, you are signed out 12 hours after you sign in, or after you last chose Stay signed in. Save your work now, or choose Stay signed in.',
  warningKept: 'Unsaved decisions and mitigations stay in this browser and come back when you sign in again here.',
  stay: 'Stay signed in',
  /** A session read that failed (audit A 34; defect 7). */
  stayFailed: 'We could not keep you signed in. Select Stay signed in again.',
  endedIdle: 'You were signed out because 12 hours have passed since you signed in or last chose Stay signed in.',
  endedAbsolute: 'You were signed out because 7 days have passed since you signed in. Everyone signs in again at least once every 7 days.',
  /**
   * The session ended before either deadline: the server said so when Stay signed in was pressed (sign out everywhere, a
   * password change, a deactivation). The clock cannot say why, so no reason is given (B35's first sentence).
   */
  endedElsewhere: 'You have been signed out.',
  endedKept: 'What you typed is still on this page. Unsaved decisions and mitigations also stay in this browser and come back when you sign in again here.',
  signInAgain: 'Sign in again',
});
