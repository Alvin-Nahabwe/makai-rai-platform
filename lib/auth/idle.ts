/**
 * The idle limit of a signed-in session, and the pure rules behind the warning that comes
 * before it (UX-43, SRS 7.6.1; WCAG 2.2.1). Client-safe: this file imports nothing, because
 * components/layout/IdleWarning.tsx imports it.
 *
 * What the limit is. The session cookie carries its own expiry, `exp`, set to now + 12 hours
 * when the person signs in and again each time GET /api/auth/session is read. Measured on a dev
 * server (docs/adr/0002-identity-and-account-linking.md section 4): only sign-in and that
 * read move it. Page loads, API reads and API writes do not, because server code reads the
 * session with `auth()` and next-auth drops the refreshed cookie on that path
 * (node_modules/next-auth/lib/index.js:58-63). So "idle" means 12 hours since sign-in or since
 * the last "Stay signed in" (owner default B33), not since the last click. The server accepts a
 * token up to `exp` + 15 s (node_modules/@auth/core/jwt.js:79); the browser drops the cookie at
 * `exp`. A second, harder limit sits beside it: `sessionIssuedAt` is stamped once at sign-in
 * (lib/auth/callbacks.ts) and lib/auth/identity.ts refuses a session older than 7 days. Staying
 * signed in never moves that stamp, so the person's real deadline is the earlier of the two.
 *
 * Test seam. A test build can shorten the limit so an end-to-end test does not wait 12 hours:
 * set MAKRAI_TEST_SEAMS=1 (H0's variable, which only the test build sets) and
 * MAKRAI_TEST_IDLE_SECONDS to a whole number from 180 to 43200. The seam can only shorten.
 * Anything else, including a value above the real limit, leaves 12 hours. H0's test-seams lint
 * keeps both variables out of the production images, compose files and runbooks.
 */

/**
 * The sessionStorage key of the signed-out hint (C12): IdleWarning writes `{ reason, at }` when a session ends by the
 * clock, and S-01 reads it once, as one of two fixed words (LoginClient.tsx, readSignedOutHint). No draft key.
 */
export const SIGNED_OUT_HINT_KEY = 'makrai.signedOut';

/** Seconds before the idle deadline at which the warning opens. */
export const IDLE_WARNING_SECONDS = 120;

/** The 7-day absolute limit, in seconds. Equal to the limit at lib/auth/identity.ts (pinned by a test). */
export const ABSOLUTE_SESSION_SECONDS = 7 * 24 * 60 * 60;

/** Seconds taken off the idle deadline for the delay between the server's render and the browser's mount. */
export const IDLE_MARGIN_SECONDS = 5;

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

export type IdleDeadlines = { secondsLeft: number; absoluteSecondsLeft: number };
export type IdlePhase = 'waiting' | 'warning' | 'ended';
export type StayResult = 'extended' | 'ended' | 'failed';

/**
 * Where the page is in the countdown. `secondsLeft` and `absoluteSecondsLeft` are what the server
 * measured when it rendered the page (relative, so the browser's clock does not matter) and
 * `elapsedSeconds` is the time since the page took them. 'ended' once either deadline is reached;
 * 'warning' for the last IDLE_WARNING_SECONDS before the idle deadline; otherwise 'waiting'. When
 * the 7-day limit comes first (or at the same moment) there is never a warning, because
 * "Stay signed in" cannot move it.
 */
export function idlePhase(p: { secondsLeft: number; absoluteSecondsLeft: number; elapsedSeconds: number }): IdlePhase {
  const idleLeft = p.secondsLeft - p.elapsedSeconds;
  const absoluteLeft = p.absoluteSecondsLeft - p.elapsedSeconds;
  if (idleLeft <= 0 || absoluteLeft <= 0) return 'ended';
  if (idleLeft <= IDLE_WARNING_SECONDS && p.secondsLeft < p.absoluteSecondsLeft) return 'warning';
  return 'waiting';
}

/**
 * What a GET of /api/auth/session means for "Stay signed in". 'extended' is a 200 whose body has a
 * `user` while the 7-day limit has not been reached. 'ended' is a 200 that says there is no session
 * (a parsed `null`, or an object without `user`), or any 200 once the 7-day limit has been reached.
 * Everything else, including 429, 5xx, a redirect, a network error and a 200 whose body is not what
 * next-auth answers, is 'failed': the person may well still be signed in.
 */
export function stayOutcome(status: number | 'network', body: unknown, absoluteSecondsLeftNow: number): StayResult {
  if (status !== 200) return 'failed';
  if (body === null) return 'ended';
  if (typeof body !== 'object' || Array.isArray(body)) return 'failed';
  const user = (body as { user?: unknown }).user;
  if (user === null || user === undefined) return 'ended';
  return absoluteSecondsLeftNow > 0 ? 'extended' : 'ended';
}

/**
 * What a settled read means once the local clock is taken into account. The server's answer
 * decides: a read that answers 'extended' is extended even when it settles after the local
 * deadline, because the server accepts the token up to `exp` + 15 s and has just re-signed it.
 * Only a 'failed' read that settles after the deadline is 'ended', because by then there is
 * nothing left to keep and "try again" would be false.
 */
export function settleStay(outcome: StayResult, phaseNow: IdlePhase): StayResult {
  return outcome === 'failed' && phaseNow === 'ended' ? 'ended' : outcome;
}

/**
 * Both deadlines counted `IDLE_MARGIN_SECONDS` early, never below 0. The 7-day limit is moved with the idle one so their order
 * does not change: if only the idle deadline moved, one that really falls 1 to 5 s after the 7-day limit would read as earlier and
 * the warning would offer an extension that cannot move the limit (U-S1).
 */
export function withMargin(p: IdleDeadlines): IdleDeadlines {
  return {
    secondsLeft: Math.max(0, p.secondsLeft - IDLE_MARGIN_SECONDS),
    absoluteSecondsLeft: Math.max(0, p.absoluteSecondsLeft - IDLE_MARGIN_SECONDS),
  };
}

const TIMER_SLACK_MS = 50;
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Milliseconds until the next phase boundary, for a single timeout (null once ended). A timer can
 * fire late, or not at all while a laptop sleeps, so the caller also re-checks on a tick and on
 * visibility, pageshow, focus and online; this is only the exact wake-up for the usual case.
 */
export function msToNextPhase(p: { secondsLeft: number; absoluteSecondsLeft: number; elapsedSeconds: number }): number | null {
  const phase = idlePhase(p);
  if (phase === 'ended') return null;
  const idleLeft = p.secondsLeft - p.elapsedSeconds;
  const absoluteLeft = p.absoluteSecondsLeft - p.elapsedSeconds;
  const warningComesFirst = phase === 'waiting' && p.secondsLeft < p.absoluteSecondsLeft;
  const seconds = warningComesFirst ? idleLeft - IDLE_WARNING_SECONDS : Math.min(idleLeft, absoluteLeft);
  return Math.min(MAX_TIMER_MS, Math.ceil(seconds * 1000) + TIMER_SLACK_MS);
}

const isWholeNumber = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * A message from another tab on the BroadcastChannel. Accepted only as two whole numbers from 0, the
 * idle one no longer than this tab's own limit and the 7-day one no longer than the 7-day limit;
 * anything else (another page of the same origin, or a tab running older code during a deploy)
 * is ignored, so a malformed message cannot give the tab a NaN or an absurd deadline.
 */
export function acceptIdleMessage(data: unknown, idleSeconds: number): IdleDeadlines | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const { secondsLeft, absoluteSecondsLeft } = data as Record<string, unknown>;
  if (!isWholeNumber(secondsLeft) || !isWholeNumber(absoluteSecondsLeft)) return null;
  if (secondsLeft > idleSeconds || absoluteSecondsLeft > ABSOLUTE_SESSION_SECONDS) return null;
  return { secondsLeft, absoluteSecondsLeft };
}

/**
 * The status and parsed body of a session read, or `{ status: 'network', body: null }` when the
 * answer cannot be trusted to be next-auth's: not JSON, not parsable, or reached through a redirect.
 * A captive-portal page or a proxy's error page therefore reads as a failed read and never as a
 * signed-out session.
 */
export async function readSessionResponse(response: Response): Promise<{ status: number | 'network'; body: unknown }> {
  const unreadable = { status: 'network' as const, body: null };
  if (response.redirected) return unreadable;
  if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) return unreadable;
  try {
    return { status: response.status, body: await response.json() };
  } catch {
    // A body that is not JSON is the same case as a wrong content type: not next-auth's answer.
    return unreadable;
  }
}

/** The sign-in address that returns the person to the page they are on. The value is one encoded path, so it cannot carry a second parameter. */
export function signInAgainHref(pathname: string, search: string): string {
  return `/login?callbackUrl=${encodeURIComponent(pathname + search)}`;
}
