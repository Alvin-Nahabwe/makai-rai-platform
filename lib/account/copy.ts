/**
 * The words of My account (`/account`, audit A 76 to 98). Its client files (`SignOutEverywhere`,
 * `PersonalExportAndDeletionForm`) are on that page only, so this module ships to no other page. The words of the slots the page
 * renders (`MyAcceptances`, `ReminderEmailsSetting`, `PreparingDownload`, `DraftsOnThisDevice`) are theirs, not these.
 */
export const ACCOUNT_COPY = Object.freeze({
  titles: Object.freeze({ myAccount: 'My account' }),
  page: Object.freeze({
    heading: 'My account',
    /** The h2 over name and email (A 78): it no longer repeats the h1. */
    detailsHeading: 'Name and email',
    name: 'Name',
    email: 'Email',
    passwordHeading: 'Password',
    changePassword: 'Change password',
    /** The h2 over Sign out everywhere (A 83). */
    devicesHeading: 'Signed-in devices',
  }),
});

/** Sign out everywhere (audit A 84 to 87). */
export const SIGN_OUT_EVERYWHERE_COPY = Object.freeze({
  button: 'Sign out everywhere',
  explains: 'Signs you out on every device, including this one.',
  /** The request did not reach the platform, or it refused: nothing ended (A 84). */
  notDone: 'You are still signed in on your other devices. Check your internet connection and try again.',
  /**
   * A 401: this browser's session had already ended and nothing says the others did (A 85). The row says "on this device", which
   * the vocabulary retires (unsaved-changes-draft); "in this browser" is the vocabulary's own word for where this browser's
   * session is, and the sentence this one replaces said "signed out of this browser". The coordinator confirmed it (ruling Q6).
   */
  signedOutHere: 'You are signed out in this browser. You may still be signed in on other devices. Sign in again, then select Sign out everywhere.',
});

/** My data and Delete my account (audit A 88 to 98). */
export const PERSONAL_DATA_COPY = Object.freeze({
  dataHeading: 'My data',
  /** The download link's words (A 96), and what it says while the file is prepared (A 88). */
  download: 'Download my data',
  preparing: 'Preparing your file...',
  /** Said before the link, so a person reads it before downloading (A 89). */
  downloadIntro: 'You can download a file with your data. It has your account details, your memberships, the legal texts you accepted and your reminder setting. It also lists the records you entered or were named in. It does not include the text of those records. That text belongs to your organisation.',
  deleteHeading: 'Delete my account',
  /**
   * A 90. The shown name is written by `lib/data/identity.ts` (`scrubUserOnDeactivation`, `DELETED_USER_NAME`),
   * which stays "Deleted user" while row F8 is held (review B2 I2: the approved legal texts promise that name). Until the
   * owner rules on F8, this sentence's "Deleted account" does not match the name an account is given when deleted.
   */
  deleteConsequence: 'Your name and email are removed and you are signed out everywhere. Records you entered stay with your organisations, shown as entered by "Deleted account". This cannot be undone.',
  objectName: 'Your account',
  deleteAction: 'Delete my account',
  deleteTrigger: 'Delete my account...',
  /** The confirmation's password field (A 94): "Password" alone could read as choosing one. */
  passwordLabel: 'Your current password',
});

/** The typed-phrase field's label (A 91); the phrase itself stays in `lib/export/messages.ts`. */
export function phraseLabel(phrase: string): string {
  return `Type ${phrase} to confirm`;
}
