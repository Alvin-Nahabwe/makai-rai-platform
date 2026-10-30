/**
 * The idle limit of a signed-in session, and the warning that comes before it
 * (UX-43, SRS 7.6.1; WCAG 2.2.1).
 *
 * The limit is 12 hours, as lib/auth.ts has always set it. NextAuth re-signs the
 * session cookie with a fresh expiry when the session is read, so it behaves as
 * an idle timeout and not as a hard cutoff; the hard cutoff is the 7-day
 * `sessionIssuedAt` check in lib/auth/identity.ts, which nothing here touches.
 *
 * Test seam. A test build can shorten the limit so an end-to-end test does not
 * wait 12 hours: set MAKRAI_TEST_SEAMS=1 (H0's variable, which only the test
 * build sets) and MAKRAI_TEST_IDLE_SECONDS to a whole number from 180 to 43200.
 * The seam can only shorten. Anything else, including a value above the real
 * limit, leaves 12 hours. H0's test-seams lint keeps both variables out of the
 * production images, compose files and runbooks.
 */

/** Seconds before the idle limit at which the warning opens. */
export const IDLE_WARNING_SECONDS = 120;

const IDLE_LIMIT_SECONDS = 12 * 60 * 60;
const SEAM_MINIMUM_SECONDS = 180;

export function idleLimitSeconds(env: NodeJS.ProcessEnv = process.env): number {
  if (env.MAKRAI_TEST_SEAMS !== '1') return IDLE_LIMIT_SECONDS;
  const requested = env.MAKRAI_TEST_IDLE_SECONDS;
  // Digits only: Number() would also accept ' 180', '1e3', '0x100' and '180.0'.
  if (requested === undefined || !/^\d+$/.test(requested)) return IDLE_LIMIT_SECONDS;
  const seconds = Number(requested);
  if (!Number.isSafeInteger(seconds) || seconds < SEAM_MINIMUM_SECONDS || seconds > IDLE_LIMIT_SECONDS) {
    return IDLE_LIMIT_SECONDS;
  }
  return seconds;
}
