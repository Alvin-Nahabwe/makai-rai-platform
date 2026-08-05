import { redirect } from 'next/navigation';
import { identityDb } from '../data/identity';

/**
 * The one choke point for "who is this?" (ADR-0002). The token asserts
 * identity and nothing else — `platformRole` and `mustChangePassword` are
 * read from the database on every call, never from the JWT, so a demotion,
 * deactivation, or forced password change takes effect on the very next
 * request instead of surviving up to the old 30-day token lifetime.
 *
 * This is NOT an authorization function. It answers "who", never "may they
 * act in org X" — that is `requireOrgContext` (a later Plan 1b task). A
 * caller with a valid Identity may still be a member of zero organizations.
 */
export type Identity = {
  userId: string;
  email: string;
  name: string | null;
  platformRole: 'admin' | 'assessor';
  mustChangePassword: boolean;
};

/** Thrown by `resolveIdentity` for every rejection path. Caught by name in
 * `requireIdentity`, deliberately not by a catch-all — see its comment. */
export class SessionError extends Error {}

const ABSOLUTE_MAX_AGE_S = 7 * 24 * 60 * 60;

/**
 * The raw shape `resolveIdentity` consumes. Deliberately not `next-auth`'s
 * `JWT` type: this function must stay callable with a hand-built object in
 * tests, without a request, a cookie, or NextAuth in the loop at all.
 *
 * `sessionIssuedAt`, not the JWT envelope's own `iat`: verified live
 * (`@auth/core/jwt` encode/decode round-tripped through a 1.2s delay) that
 * `encode()` calls jose's `.setIssuedAt()` with no argument on EVERY
 * re-encode — i.e. on every `auth()` call under this session strategy,
 * because `@auth/core`'s JWT `session` action unconditionally decodes,
 * re-encodes, and re-sets the cookie on every hit (see
 * `node_modules/@auth/core/lib/actions/session.js`). That resets the
 * envelope `iat` to "now" every single request, so a token read every few
 * hours by an active-but-forgotten browser NEVER accumulates 7 days of
 * measured age and the absolute cap is silently a no-op — exactly the
 * "walked-away-from shared lab machine" exposure ADR-0002 names as the
 * reason this cap exists. `sessionIssuedAt` is a claim ONLY the sign-in
 * branch of `jwt()` in `lib/auth.ts` sets, and no other code path in this
 * module ever refreshes it, so it survives every re-encode intact.
 */
type RawToken = {
  id?: unknown;
  sessionEpoch?: unknown;
  sessionIssuedAt?: unknown;
};

/**
 * A finite, positive integer — nothing looser. `typeof x === 'number'`
 * alone is NOT sufficient: `typeof NaN === 'number'` is `true`, and a
 * subsequent `now - NaN > MAX` comparison is always `false` (every
 * comparison with `NaN` is), so a `NaN` claim would silently pass through a
 * bare `typeof` guard and skip the absolute-age cap entirely — the same
 * fail-open shape `silent-failure-hunter` closed for the MISSING-claim case,
 * left open for the malformed one. `Number.isInteger` itself already
 * excludes `NaN`/`±Infinity`/fractional values (`Number.isInteger(NaN)` and
 * `Number.isInteger(Infinity)` are both `false`), so this predicate rejects
 * every non-number, `NaN`, `±Infinity`, non-integer, and non-positive value
 * in one place, and narrows the type so callers need no cast.
 */
function isPositiveInteger(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x > 0;
}

/**
 * Pure modulo one database read: no cookies, no headers, no redirect. Every
 * rejection throws `SessionError` — never returns a partial `Identity`, so a
 * caller cannot accidentally treat a half-checked token as good by reading a
 * field before an `await` resolves.
 *
 * Order matters and is deliberate: cheap, request-independent checks first
 * (subject present, absolute age), then the one database round trip, then
 * the two checks that need its result (active, epoch). Failing closed means
 * every one of these is a `throw`, not a fallback value.
 */
export async function resolveIdentity(token: RawToken): Promise<Identity> {
  if (typeof token.id !== 'string' || token.id.length === 0) {
    throw new SessionError('session has no subject');
  }

  // Fail CLOSED on a missing OR malformed claim, not open. Guard the VALUE
  // via `isPositiveInteger`, not the shape a real signed JWT happens to
  // produce — see that predicate's comment for why a bare `typeof` check
  // does not suffice (D-092: five prior guards each closed the shape their
  // author enumerated and left the class open).
  if (!isPositiveInteger(token.sessionIssuedAt)) {
    throw new SessionError('session issuance time is missing or invalid');
  }
  if (Date.now() / 1000 - token.sessionIssuedAt > ABSOLUTE_MAX_AGE_S) {
    throw new SessionError('absolute session lifetime exceeded');
  }

  const user = await identityDb.user.findUnique({
    where: { id: token.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
      sessionEpoch: true,
    },
  });

  if (!user || !user.isActive) {
    throw new SessionError('session belongs to an inactive or unknown user');
  }
  if (user.sessionEpoch !== token.sessionEpoch) {
    throw new SessionError('session has been revoked');
  }

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    platformRole: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}

/**
 * Thrown by `requireIdentityForApi` — never by `requireIdentity`, which
 * redirects instead of throwing this. A distinct class (not `SessionError`
 * reused) so a route handler's `instanceof` check cannot accidentally also
 * catch a `SessionError` that leaked from somewhere else and misreport it.
 */
export class UnauthenticatedError extends Error {}

/**
 * Thrown by `requireIdentityForApi` when the caller IS authenticated but the
 * account is flagged `mustChangePassword` and the caller did not opt out via
 * `{ allowMustChangePassword: true }`. Deliberately a separate class from
 * `UnauthenticatedError`: this caller has a valid session (401 would be a
 * lie — "please log in" when they already are) and the correct instruction
 * is "log in, but you must change your password first" (403, with a
 * machine-readable `code` — see `lib/http/toResponse.ts`).
 */
export class PasswordChangeRequiredError extends Error {}

/** `/change-password` itself must never redirect to itself — see
 * `requireIdentity`'s comment. */
const CHANGE_PASSWORD_PATH = '/change-password';

/** Shared options for `requireIdentity`/`requireIdentityForApi`. Only the
 * password-change page/route may pass `allowMustChangePassword: true` —
 * everything else must leave it unset, or a flagged account can never reach
 * the one action that clears the flag. */
export type RequireIdentityOptions = {
  allowMustChangePassword?: boolean;
};

/**
 * Reads the NextAuth session and resolves it to an `Identity`, throwing
 * `SessionError` on any rejection. Shared by `requireIdentity` (pages,
 * redirects) and `requireIdentityForApi` (routes, 401s) so the session-read
 * and dynamic-import machinery exists once, not twice.
 *
 * `auth` is imported dynamically, INSIDE the function body, rather than at
 * module scope. That is not a style choice: `next-auth` transitively
 * imports `next/server`, which is unresolvable outside the Next.js runtime
 * (verified live — a plain `import { auth } from '../auth'` at the top of
 * this file makes `next/server` fail to resolve under vitest's `node`
 * environment with `Cannot find module '.../node_modules/next/server'`, a
 * pre-existing condition reproduced against the unmodified `lib/auth.ts`
 * too, so it is a toolchain limitation, not something this task
 * introduced). A static top-level import would drag that failure into
 * every module that imports `resolveIdentity`, including this file's own
 * test — directly breaking constraint 3, "testable without a request".
 * Deferring the import to call time keeps `resolveIdentity` and
 * `bumpSessionEpoch` importable and testable in plain Node, and only pays
 * the `next-auth` import cost on the paths that legitimately run inside the
 * Next.js server runtime.
 */
async function resolveFromSession(): Promise<Identity> {
  const { auth } = await import('../auth');
  const session = await auth();
  if (!session?.user?.id) throw new SessionError('no session');
  return resolveIdentity({
    id: session.user.id,
    sessionEpoch: session.sessionEpoch,
    sessionIssuedAt: session.sessionIssuedAt,
  });
}

/**
 * For SERVER COMPONENTS AND PAGES. Redirects to `/login` on any rejection —
 * correct there, because the caller renders HTML and a 30x is what sends
 * the browser to the login page.
 *
 * Catches `SessionError` BY NAME, not every error. An unexpected failure —
 * the database connection dropping, say — must propagate and surface as a
 * loud 500, not get laundered into a quiet "please log in" that hides an
 * infrastructure outage behind what looks like an ordinary auth prompt.
 *
 * SECOND gate, after identity resolves: `mustChangePassword`, read fresh
 * from the database by `resolveIdentity` above, redirects to
 * `/change-password` — UNLESS the current request already targets that
 * page, which would otherwise be an immediate redirect loop. This function
 * has no pathname parameter (every caller today invokes it as
 * `requireIdentity()`, from the shared `(authenticated)/layout.tsx` that
 * wraps every authenticated route including `/change-password` itself — see
 * that layout's own comment), so it cannot know its own target from its
 * arguments. `proxy.ts` forwards the real request pathname as the
 * `x-pathname` header on every page request specifically so this function
 * can read it via `next/headers` — proxy itself makes no authorization
 * decision from it (see proxy.ts's module doc for why that split is
 * architectural, not a runtime limitation).
 *
 * This is the fix for the regression this branch introduced: `proxy.ts`
 * used to read `mustChangePassword` off the JWT, but ADR-0002 §3 removed
 * that claim from the token (staleness — a forced change would never take
 * effect until the token itself expired). The token read kept
 * type-checking against `next-auth`'s index-signature-open `JWT` type and
 * silently evaluated to `undefined` forever, so the gate went dead with no
 * compile error and no test failure. This reads the SAME flag `resolveIdentity`
 * already fetches from Postgres on every call — no new database round trip.
 */
export async function requireIdentity(): Promise<Identity> {
  let identity: Identity;
  try {
    identity = await resolveFromSession();
  } catch (e) {
    if (e instanceof SessionError) redirect('/login');
    throw e;
  }

  if (identity.mustChangePassword) {
    const { headers } = await import('next/headers');
    const pathname = (await headers()).get('x-pathname');
    if (pathname !== CHANGE_PASSWORD_PATH) {
      redirect(CHANGE_PASSWORD_PATH);
    }
  }

  return identity;
}

/**
 * For API ROUTE HANDLERS. Throws `UnauthenticatedError` instead of
 * redirecting — a `redirect()` (a 307 to `/login`, HTML) is WRONG for a
 * `fetch()` caller expecting JSON: the browser follows the redirect,
 * receives the login page's `200 text/html`, and `res.json()` throws, so
 * the caller sees a generic parse error instead of "please log in". Every
 * other route in this codebase already answers an unauthenticated caller
 * with `401` and a JSON body (see `getSessionUser` in `lib/authz.ts`); this
 * keeps that contract for routes built on `requireIdentity()`'s replacement.
 *
 * A separate, distinctly-named export rather than a `{ mode: 'page' | 'api' }`
 * parameter on one function: a flag a caller can pass wrong is exactly the
 * shape of bug this exists to prevent (an API route that accidentally reads
 * `'page'` would fail the same way `requireIdentity()` did here). Two
 * differently-typed functions make the call site's intent explicit instead.
 *
 * The route handler is expected to catch this by name and map it to a 401
 * JSON response — see `app/api/v1/orgs/route.ts` for the pattern.
 *
 * SECOND gate, after identity resolves: `mustChangePassword` throws
 * `PasswordChangeRequiredError` (403, not 401 — the caller IS authenticated)
 * unless `options.allowMustChangePassword` is set. Only
 * `app/api/users/me/password/route.ts` — the one action that can clear the
 * flag — may pass that option; every other API route must leave it unset or
 * a flagged account can never reach the action that unblocks it. See
 * `lib/http/toResponse.ts` for the shared 403 mapping.
 */
export async function requireIdentityForApi(
  options: RequireIdentityOptions = {},
): Promise<Identity> {
  let identity: Identity;
  try {
    identity = await resolveFromSession();
  } catch (e) {
    if (e instanceof SessionError) throw new UnauthenticatedError(e.message);
    throw e;
  }

  if (identity.mustChangePassword && !options.allowMustChangePassword) {
    throw new PasswordChangeRequiredError();
  }

  return identity;
}

/**
 * For pages that want identity WHEN PRESENT but must not force a redirect —
 * the invitation-acceptance page is the only caller (Task 8, D-098):
 * `requireIdentity()` would redirect an anonymous visitor to `/login` before
 * they can see what org/role the link even names, which is the wrong UX for
 * a link whose whole point is to be followed by someone who may not have an
 * account yet.
 *
 * Returns `null` for "no session" AND for every rejection `resolveIdentity`
 * throws (expired/revoked/deactivated) — from the caller's point of view
 * those are indistinguishable "anonymous" states, the same unauthenticated
 * branch `requireIdentity()` handles by redirecting. Anything that is NOT a
 * `SessionError` propagates uncaught, matching `requireIdentity`/
 * `requireIdentityForApi`'s by-name (never catch-all) handling.
 *
 * Added at the final Plan 1b review (CRITICAL-1) to close the branch's one
 * live violator of ADR-0002's construction guarantee: the invitation page
 * used to `import { auth } from '@/lib/auth'` directly to get exactly this
 * soft-identity behaviour. `resolveFromSession` (above) is now the ONLY
 * place in the codebase that imports `auth` — the raw session is reachable
 * from nowhere else, page code included.
 */
export async function tryResolveIdentity(): Promise<Identity | null> {
  try {
    return await resolveFromSession();
  } catch (e) {
    if (e instanceof SessionError) return null;
    throw e;
  }
}

/**
 * Invalidates every outstanding session for a user immediately: logout-
 * everywhere, password change, deactivation, or any admin action that
 * should end existing sessions. The NEXT request's `resolveIdentity` call
 * finds the stored epoch no longer matches the token's and rejects — no
 * token blocklist, no revocation store, just one integer comparison.
 */
export async function bumpSessionEpoch(userId: string): Promise<void> {
  await identityDb.user.update({
    where: { id: userId },
    data: { sessionEpoch: { increment: 1 } },
  });
}
