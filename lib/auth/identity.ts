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

  // Fail CLOSED on a missing/malformed claim, not open. An earlier draft
  // only rejected when `sessionIssuedAt` was present AND too old, which
  // silently exempted any token that lacks the claim — e.g. every session
  // signed before this field existed — from the absolute cap entirely.
  // `pr-review-toolkit:silent-failure-hunter` caught this: it is a
  // fail-open dressed as fail-closed, and it defeats the exact
  // walked-away-from-shared-machine exposure ADR-0002 §4 names as the
  // reason the cap exists.
  if (typeof token.sessionIssuedAt !== 'number') {
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
 * The thin wrapper: reads the NextAuth session, hands its claims to
 * `resolveIdentity`, and redirects to `/login` on any rejection.
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
 * the `next-auth` import cost on the one path that legitimately runs inside
 * the Next.js server runtime.
 *
 * Catches `SessionError` BY NAME, not every error. An unexpected failure —
 * the database connection dropping, say — must propagate and surface as a
 * loud 500, not get laundered into a quiet "please log in" that hides an
 * infrastructure outage behind what looks like an ordinary auth prompt.
 */
export async function requireIdentity(): Promise<Identity> {
  const { auth } = await import('../auth');
  const session = await auth();
  if (!session?.user?.id) redirect('/login');

  try {
    return await resolveIdentity({
      id: session.user.id,
      sessionEpoch: session.sessionEpoch,
      sessionIssuedAt: session.sessionIssuedAt,
    });
  } catch (e) {
    if (e instanceof SessionError) redirect('/login');
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
