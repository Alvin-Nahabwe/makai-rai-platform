import { verbatim } from '@/lib/vocabulary/verbatim';
import type { AcceptedKind } from '@/types/legal';

/**
 * The words of the acceptances form (S-05, and the second step of S-04) and of the sends that record them (plan 1A Task 16b).
 * The page `/acceptances` loads this module whole (ruling T16-18, 156 of 160 KB): it imports `verbatim` and types only, and
 * nothing else goes in it. Words only a server reads live in `lib/legal/copy.ts`.
 */

/** The sentence each box carries as its label (W-11 note 2). Signed with the legal texts by the owner: not one character changes. */
export const ACCEPT_LABEL: Record<AcceptedKind, string> = {
  terms: verbatim('legal-text', 'I accept the terms of service.'),
  privacy: verbatim('legal-text', 'I have read the privacy notice.'),
  'cross-border-consent': verbatim('legal-text', 'I agree that my data is stored in Finland and handled by Cloudflare, around the world, and Resend, in the United States, as the consent to storage abroad describes.'),
};

/** "a", "a and b", "a, b and c". */
function listOf(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export const ACCEPTANCES_COPY = Object.freeze({
  /** The page's heading in modes `required` and `invitation` (audit A 190). Offer mode's heading is `offerLegend`. */
  legend: 'Accept the terms to continue',
  offerLegend: (names: readonly string[]): string => `A new version of the ${listOf(names)}`,
  lead: 'Read each text. Then tick each box.',
  version: (version: string, date: string): string => `Version ${version}, published ${date}.`,
  readLink: (name: string): string => `Read the ${name}`,
  opensInNewTab: '(opens in a new tab)',
  /** Under an unticked box (audit A 206). */
  tickThis: 'Tick this box to continue.',
  /** In the summary at the top and in route 31's answer (audit A 206); `acceptanceError` in `lib/legal/kinds.ts` is its one reader. */
  tickBoxFor: (name: string): string => `Tick the box for the ${name}.`,
  /** The title of the error summary: no audit row words it; it is the audited text of E-API-7, as the coordinator ruled. */
  summaryTitle: 'Some answers need fixing.',
  submit: 'Accept and continue',
  /** While a send is in flight (audit A 198). */
  saving: 'Saving...',
  /** Mode `required` (audit A 194, KEEP): the words around two links. */
  alternativesBefore: 'If you do not want to accept, you can ',
  deleteAccount: 'delete your account',
  alternativesOr: ' or ',
  signOut: 'sign out',
  alternativesAfter: '.',
  /**
   * Under a sign out (this form's, and the invitation page's for another account) whose press failed: its code did not
   * load, or the sign-out got no answer (the coordinator's ruling T16-Q11; ruling T16-31). One key for both controls.
   */
  stillSignedIn: 'You are still signed in. Check your internet connection and try again.',
  /** Mode `invitation` (audit A 195). */
  closePage: 'If you do not want to accept, close this page. Your account will not be created.',
  notNow: 'Not now',
  tryAgain: 'Try again',
  /** The wait in a 429 (audit A 185): two sentences, one for a single minute. */
  rateLimited: (minutes: number): string =>
    minutes === 1 ? 'Too many attempts. Wait 1 minute, then try again.' : `Too many attempts. Wait ${minutes} minutes, then try again.`,
  /** What a send that did not finish says, by what was being sent (audit A 186, 187). */
  send: Object.freeze({
    account: Object.freeze({
      /** No reply: the account may have been created all the same (the coordinator's ruling Q7). */
      lost: 'We did not get a reply, so your account may already be created. Select Try again. If the link no longer works, sign in with the password you chose.',
      refused: 'Your account was not created because of a problem on our side. Try again.',
    }),
    choice: Object.freeze({
      lost: 'Your choice was not saved. Check your internet connection and try again.',
      refused: 'Your choice was not saved because of a problem on our side. Try again.',
    }),
  }),
});
