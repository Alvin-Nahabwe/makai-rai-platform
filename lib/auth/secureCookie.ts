/**
 * The ONE place that decides whether the session cookie carries the
 * `__Secure-` prefix, so that `proxy.ts`'s standalone `getToken()` looks for
 * the cookie `lib/auth.ts`'s `NextAuth()` actually wrote.
 *
 * DEP-04 of the 2026-08-17 platform audit, rated High. `getToken` derives BOTH
 * the cookie name it reads AND the salt it decrypts with from one input:
 * `node_modules/@auth/core/jwt.js:86` --
 *   `cookieName = defaultCookies(secureCookie ?? false).sessionToken.name`
 * and then `salt = cookieName`. Called with no `secureCookie` it looks for
 * `authjs.session-token`, salted with that name.
 *
 * Production writes the other one. `@auth/core/lib/init.js:69` selects the
 * cookie set with `config.useSecureCookies ?? url.protocol === "https:"`, and
 * `@auth/core/lib/utils/cookie.js:45` prefixes the name `__Secure-` when that
 * is true. So over HTTPS the cookie is `__Secure-authjs.session-token` -- a
 * name the proxy never looked for, salted with a value it never used.
 *
 * The failure was SILENT, which is what made it survive: `null` is also the
 * correct answer for a request carrying no cookie, so every authenticated
 * request looked anonymous to the proxy and every `keyBy: 'userId'` rate limit
 * degraded to IP keying -- for the NAT'd classroom population the limiter is
 * built for (`lib/rate-limit.ts:2-4`), one shared 60/min bucket and one
 * account deletion per hour for a whole lab.
 *
 * WHY THIS DERIVES FROM THE URL AND NOT FROM A HEADER. The audit's suggested
 * direction offered `x-forwarded-proto` as an alternative. That would be a
 * client-supplied value deciding which credential the server trusts, and the
 * only thing standing between it and an attacker is the origin firewall. This
 * reads the same configuration `@auth/core` itself reads, so the writer and the
 * reader of the cookie cannot disagree by construction -- there is no request
 * in which they could see different values, because neither consults the
 * request.
 *
 * `AUTH_URL ?? NEXTAUTH_URL` mirrors `@auth/core`'s own precedence
 * (`lib/utils/env.js:68`). This project sets only the `NEXTAUTH_` name, on
 * purpose -- see `lib/auth/secret.ts` -- but reading both keeps this function
 * honest if that ever changes.
 */
export function usesSecureCookies(): boolean {
  const raw = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (!raw) return false; // no configured URL: local dev over http
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    // An unparseable URL is a configuration error, not a security decision to
    // guess at. Returning false here would silently restore the exact bug this
    // file exists to close, so fail loudly instead.
    throw new Error(
      `AUTH_URL/NEXTAUTH_URL is not a valid URL (${JSON.stringify(raw)}), so the ` +
        `session cookie name cannot be determined. @auth/core derives the ` +
        `__Secure- prefix from this value; if it cannot be parsed, the proxy and ` +
        `NextAuth would disagree about which cookie holds the session.`,
    );
  }
}
