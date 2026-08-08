/**
 * The ONE place that reads `NEXTAUTH_SECRET`, shared between `lib/auth.ts`'s
 * `NextAuth({...})` config and `proxy.ts`'s standalone `getToken()` call.
 *
 * Fix round 1, Important 2 (task-6-report.md). Before this, `lib/auth.ts`
 * relied on `next-auth`'s own IMPLICIT fallback -- verified by reading
 * `next-auth/lib/env.js` directly, not inferred from a changelog:
 * `config.secret ?? (config.secret = process.env.AUTH_SECRET ??
 * process.env.NEXTAUTH_SECRET)`. `proxy.ts` instead called the lower-level,
 * standalone `getToken` (imported from `next-auth/jwt`, a plain re-export
 * of `@auth/core/jwt`'s own `getToken` -- `next-auth/jwt.js` is just
 * `export * from "@auth/core/jwt"`, verified by reading the runtime file).
 * That function reads NO environment variable for the secret at all --
 * `secret` comes only from the object passed to it, with no env fallback
 * anywhere in its implementation, REGARDLESS of what its own module doc
 * comment claims ("uses the AUTH_SECRET environment variable") -- disproven
 * live, twice: `__tests__/unit/auth-secret.test.ts` shows `getToken({req})`
 * throws `MissingSecret` even with `NEXTAUTH_SECRET` set, and an earlier
 * ad hoc script against this project's real `.env` reproduced the same
 * throw. This project's `.env`/`.env.example`/`docker-compose.prod.yml`
 * set only `NEXTAUTH_SECRET` (the pre-v5 name) -- `AUTH_SECRET` is never
 * set anywhere in this codebase -- so `getToken` in `proxy.ts` threw on
 * every request carrying a session cookie, silently caught and
 * miscategorised as "no token available" (D-114 Finding 2), collapsing
 * every `keyBy: 'userId'` rate-limit rule onto the client-controlled
 * `x-forwarded-for` header (D-151, D-124's trigger).
 *
 * Reading the SAME exported function in both places makes the two values
 * agree STRUCTURALLY (one function, one env read), not merely by the
 * coincidence of two different pieces of framework code each defaulting to
 * the same env var today. Deliberately NOT "add AUTH_SECRET to .env" --
 * that would fix `getToken` alone while leaving `lib/auth.ts` and
 * `proxy.ts` reading two independently-resolved values that merely happen
 * to end up equal, with nothing enforcing that they stay that way.
 *
 * Mirrors `lib/data/connection.ts#requireDatabaseUrl`'s shape: fail loud at
 * the point of use rather than let a missing/empty value silently degrade
 * behaviour (there, a connection falling back to superuser defaults; here,
 * NextAuth or `getToken` failing in a way each library then handles
 * differently -- NextAuth would throw at startup, `getToken` used to fail
 * open into IP-keyed rate limiting).
 */
export function requireAuthSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(
      'NEXTAUTH_SECRET is not set. NextAuth cannot sign or verify session tokens without it.',
    );
  }
  return secret;
}
