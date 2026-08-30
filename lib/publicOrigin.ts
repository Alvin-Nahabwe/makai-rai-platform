/**
 * The origin a RECIPIENT can reach, as opposed to the one the server sees.
 *
 * `app/api/v1/orgs/[slug]/members/route.ts` built invitation links from
 * `req.nextUrl.origin`. Behind nginx that is not the public address: the
 * standalone Next server binds to `process.env.HOSTNAME`, which Docker sets to
 * the container id (register row D-236), so every invitation email carried
 *
 *     https://1038b2a33d91:3000/invitations/<token>
 *
 * — a host that exists only inside the Docker network. The mail was delivered
 * and the link went nowhere.
 *
 * NOTHING ABOUT THE REQUEST IS USED. Not `nextUrl`, not `Host`, not
 * `X-Forwarded-Host`. Two reasons, and the second is the one that generalises:
 * the request origin is wrong here even when nobody is attacking, because the
 * app genuinely cannot see its own public name; and a value a recipient acts on
 * should never be derived from something a client can influence. The same
 * argument decides `lib/auth/secureCookie.ts`.
 *
 * IT THROWS rather than falling back. A fallback to the request origin is
 * precisely the defect this file exists to remove, and a fallback to a hardcoded
 * domain would silently produce wrong links in any other deployment. An
 * invitation is single-use: a wrong link is not a retry, it is a token spent on
 * a page the recipient cannot open. The route already treats a failed send as
 * non-fatal and returns the URL for copy-paste, so a throw here surfaces as a
 * visible error rather than a silent bad link.
 */
function configuredOrigin(): string {
  // `AUTH_URL ?? NEXTAUTH_URL` mirrors @auth/core's own precedence, so this
  // cannot disagree with the value the auth layer considers canonical.
  const raw = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (!raw) {
    throw new Error(
      'NEXTAUTH_URL (or AUTH_URL) is not set, so the public origin for outbound ' +
        'links cannot be determined. Refusing to guess: a link built from the ' +
        'request would point at the container, which is the defect this replaced.',
    );
  }
  return raw;
}

/** Scheme + host + port of the public site, with any path discarded. */
export function publicOrigin(): string {
  return new URL(configuredOrigin()).origin;
}

/** The link an invited person clicks. Absolute, and reachable from outside. */
export function invitationAcceptUrl(rawToken: string): string {
  return new URL(`/invitations/${rawToken}`, publicOrigin()).toString();
}
