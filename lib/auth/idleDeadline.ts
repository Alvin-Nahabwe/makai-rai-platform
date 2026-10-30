import { getToken } from 'next-auth/jwt';
import { ABSOLUTE_SESSION_SECONDS } from './idle';
import { requireAuthSecret } from './secret';
import { usesSecureCookies } from './secureCookie';

/**
 * The seconds left on a signed-in person's session, read from the session cookie itself, for the
 * idle warning (UX-43; SRS line 2645). Server only: it decrypts the cookie, so no client component
 * may import it (a test pins the importers).
 *
 * Why the cookie and not the layout's own clock. The server ends the session at the earlier of the
 * cookie's `exp` and `sessionIssuedAt` + 7 days (lib/auth/idle.ts explains how `exp` moves). A timer
 * that starts when a page loads knows neither, so a page opened ten hours after sign-in would warn
 * ten hours too late. The numbers are returned as seconds left, not as timestamps, so the browser's
 * clock does not matter.
 *
 * ADR-0002 keeps the raw session unreachable from application code, and this is the one file under
 * app/** and lib/** that may import `next-auth/jwt`; __tests__/lint/no-raw-session-token.test.ts
 * fails on any other. It reads
 * `exp` and `sessionIssuedAt` and nothing else, and it returns no identity: lib/auth/identity.ts
 * stays the only choke point for "who is this?". Reading a claim here proves nothing about the
 * person, which is why a result is only ever two numbers.
 *
 * It finds the cookie the way proxy.ts does, with `secureCookie: usesSecureCookies()`, so the name
 * and the salt cannot drift from what lib/auth.ts wrote (DEP-04). A wrong flag returns null with no
 * error, which reads as "signed out"; the layout logs that, and a test per cookie name exists
 * because nothing else would notice.
 *
 * Null when there is no token, when either claim is missing or not a positive whole number, or when
 * either result is not positive.
 */
export async function readSessionDeadlines(
  requestHeaders: Headers,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ secondsLeft: number; absoluteSecondsLeft: number } | null> {
  const token = await getToken({
    req: { headers: requestHeaders },
    secret: requireAuthSecret(),
    secureCookie: usesSecureCookies(),
  });
  if (!token) return null;

  const { exp, sessionIssuedAt } = token;
  if (!isPositiveInteger(exp) || !isPositiveInteger(sessionIssuedAt)) return null;

  const secondsLeft = exp - nowSeconds;
  const absoluteSecondsLeft = sessionIssuedAt + ABSOLUTE_SESSION_SECONDS - nowSeconds;
  if (secondsLeft <= 0 || absoluteSecondsLeft <= 0) return null;
  return { secondsLeft, absoluteSecondsLeft };
}

function isPositiveInteger(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x > 0;
}
