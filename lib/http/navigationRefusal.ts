import { NextResponse } from 'next/server';
import { UnauthenticatedError, PasswordChangeRequiredError } from '@/lib/auth/identity';
import { publicOrigin } from '@/lib/publicOrigin';

/**
 * What a download address answers when a BROWSER opened it as a page and the person's session does not let them in
 * (v0.6.1 U12 (e)). The download links are plain anchors, so a JSON refusal would replace the page with raw text.
 * A browser navigation goes to the page that fits instead, as route 20 does for `export_busy` and `rate_limited`
 * (lib/http/exportRefusal.ts). Everything else, an API client above all, still gets the route's own JSON.
 *
 * Only the two refusals that depend on the person's session are redirected: signed out, and an account that must
 * change its password. Both are decided before any resource is looked up, so the answer is the same for a resource
 * that exists, one that does not and one in another organisation. Not found, forbidden, erased and the rest are left
 * to `toResponse`: a redirect reason for those could tell a resource's existence apart.
 *
 * The target is a constant in this file. Nothing in the request (query, Referer, Host, Origin) reaches it, and it is
 * absolute on the configured public origin (lib/publicOrigin.ts, as every redirect in this application).
 */

/** The sign-in page's one-line reason (app/(public)/login/LoginClient.tsx reads `reason=signed_out`). */
export const SIGNED_OUT_LOCATION = '/login?reason=signed_out';
const CHANGE_PASSWORD_LOCATION = '/change-password';

/** True when a browser is loading the address as a page (the header the proxy and route 20 already read). */
export function isNavigation(req: Request): boolean {
  return req.headers.get('sec-fetch-mode') === 'navigate';
}

let warnedNoPublicOrigin = false;

/** The redirect for a refused browser navigation, or null to let the caller answer with its JSON. */
export function navigationRefusal(req: Request | undefined, e: unknown): NextResponse | null {
  if (req === undefined || !isNavigation(req)) return null;
  const location = e instanceof UnauthenticatedError ? SIGNED_OUT_LOCATION : e instanceof PasswordChangeRequiredError ? CHANGE_PASSWORD_LOCATION : null;
  if (location === null) return null;
  try {
    const res = NextResponse.redirect(new URL(location, publicOrigin()), 303);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (err) {
    // publicOrigin() throws when neither AUTH_URL nor NEXTAUTH_URL is set. The redirect is a convenience: the person
    // still gets the refusal as JSON, as route 20 does. Said once per process, so the missing setting is visible.
    if (!warnedNoPublicOrigin) {
      warnedNoPublicOrigin = true;
      console.warn('download refusal: no public origin, so a refused download answers JSON instead of going to the sign-in page', err);
    }
    return null;
  }
}
