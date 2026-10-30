import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { authorizeCredentials } from './auth/credentials';
import { requireAuthSecret } from './auth/secret';
import { jwtCallback, sessionCallback } from './auth/callbacks';
import { idleLimitSeconds } from './auth/idle';

/**
 * LAZY config -- `NextAuth(() => ({...}))`, not `NextAuth({...})`. Fix
 * round 1, Important 2 correction (task-6-report.md): the first version of
 * this fix passed `secret: requireAuthSecret()` inside a plain object
 * literal, which `next-auth`'s OBJECT-config form evaluates EAGERLY, at
 * module-import time -- not per-request. `app/api/auth/[...nextauth]/route.ts`
 * statically imports `handlers` from this file, and `next build`'s
 * "Collecting page data" phase imports every route module to inspect it,
 * which runs that top-level code unconditionally. A
 * `pr-review-toolkit:silent-failure-hunter` pass caught this by actually
 * running `next build` twice (isolated copy, `NEXTAUTH_SECRET` unset,
 * matching this project's real Docker pipeline: `docker-compose.prod.yml`
 * supplies it only as a container RUNTIME env var, `.dockerignore`
 * excludes `.env` from the build context, and the documented `docker
 * build` command in `docs/runbooks/troubleshooting.md` passes no
 * `--build-arg`) -- the object form failed the build with this exact
 * error; the lazy form below did not.
 *
 * `next-auth`'s own "Lazy initialization" pattern (documented in
 * `node_modules/next-auth/index.js`'s own module doc, not invented here)
 * defers calling this function until an actual request needs it
 * (`next-auth/lib/index.js`'s `httpHandler`/`initAuth`, verified by
 * reading the source): `requireAuthSecret()` now runs per-request, never
 * at import/build time, while still being the ONE function `proxy.ts`'s
 * `getToken()` call also uses -- the "cannot drift apart" property this
 * fix exists for is unchanged, only WHEN it evaluates changed.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  secret: requireAuthSecret(),
  providers: [
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      // The body lives in lib/auth/credentials.ts, where it can be called (and tested)
      // without NextAuth. It logs the account by userId and never by email.
      async authorize(credentials) {
        return authorizeCredentials(credentials);
      },
    }),
  ],
  // Extracted to lib/auth/callbacks.ts so their contract is directly
  // testable. The load-bearing property — sessionIssuedAt is stamped once at
  // sign-in and never refreshed — cannot be observed from resolveIdentity,
  // which would accept a wrongly-refreshed value as valid.
  callbacks: {
    jwt: jwtCallback,
    session: sessionCallback,
  },
  pages: { signIn: '/login' },
  // maxAge: @auth/core re-signs the cookie with a fresh expiry when the
  // session endpoint (GET /api/auth/session) is read. Ordinary page and API
  // requests do not: they read the session with `auth()`, which drops the
  // refreshed cookie (node_modules/next-auth/lib/index.js:58-63; measured on
  // a dev server, the cookie expiry was unchanged by three authenticated
  // pages and moved only on the session read; records/plans/2026-10-29-v1-plan/
  // reviews/fix-r11.md R11-1). So the limit counts from
  // sign-in or from the last session read, which is what "Stay signed in"
  // does (UX-43). The hard 7-day cutoff is `sessionIssuedAt` above, checked in
  // lib/auth/identity.ts's resolveIdentity (ADR-0002 §4).
  // The limit and its test seam live in lib/auth/idle.ts (UX-43); 12 hours unless a test build shortens it.
  session: { strategy: 'jwt', maxAge: idleLimitSeconds() },
}));
