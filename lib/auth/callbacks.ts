/**
 * NextAuth JWT and session callbacks.
 *
 * Extracted from lib/auth.ts so their contract can be tested directly. They
 * are pure functions of their arguments, and the property that matters most —
 * that `sessionIssuedAt` is stamped once at sign-in and never refreshed — is
 * invisible from the reading side. `resolveIdentity` (lib/auth/identity.ts) is
 * well covered, but it would happily accept a `sessionIssuedAt` that this
 * callback had wrongly refreshed on every request, so testing the reader
 * proves nothing about the writer. See __tests__/unit/auth-callbacks.test.ts.
 */
import type { JWT } from 'next-auth/jwt';
import type { Session, User } from 'next-auth';

/**
 * Stamp identity claims at sign-in only.
 *
 * `user` is supplied by NextAuth on the sign-in call and is absent on every
 * later invocation, which is what makes the sign-in branch a one-time event.
 * If a NextAuth upgrade ever starts passing `user` on ordinary requests, the
 * absolute session cap silently becomes unbounded — the test file named above
 * exists to fail loudly at that moment.
 */
export async function jwtCallback({ token, user }: { token: JWT; user?: User | null }): Promise<JWT> {
  if (user) {
    token.id = user.id as string;
    token.sessionEpoch = (user as User & { sessionEpoch?: number }).sessionEpoch;
    // Set ONLY at sign-in and never touched again by this callback, so it
    // survives every later re-encode intact. The JWT envelope's own `iat`
    // does NOT survive: @auth/core's `encode()` calls jose's `.setIssuedAt()`
    // with no argument on every re-encode — verified live, encoding the same
    // token twice 1.2s apart produced two different `iat` values. A re-encode
    // happens whenever the session action runs
    // (node_modules/@auth/core/lib/actions/session.js): at sign-in and on each
    // GET /api/auth/session, which is what "Stay signed in" sends. `auth()`
    // with no arguments runs the action too but returns only the body and
    // drops its Set-Cookie (node_modules/next-auth/lib/index.js:58-63), so an
    // ordinary page load does not move the cookie. Using the envelope `iat`
    // for the absolute session cap in lib/auth/identity.ts would still make
    // that cap move every time a person stays signed in, which is precisely
    // the case the cap exists to bound (ADR-0002 section 4: a
    // walked-away-from shared lab machine, periodically revisited).
    token.sessionIssuedAt = Math.floor(Date.now() / 1000);
  }
  return token;
}

/** Surface the claims resolveIdentity re-checks against the database. */
export async function sessionCallback({ session, token }: { session: Session; token: JWT }): Promise<Session> {
  if (session.user) {
    session.user.id = token.id as string;
  }
  session.sessionEpoch = token.sessionEpoch as number | undefined;
  session.sessionIssuedAt = token.sessionIssuedAt as number | undefined;
  return session;
}
