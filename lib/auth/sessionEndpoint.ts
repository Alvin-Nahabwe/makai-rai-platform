/**
 * The session-read guard for NextAuth's `GET` and `POST /api/auth/session` (NFR-SEC-07; obligation B21).
 *
 * next-auth answers that endpoint, by either method, with 200, the user, `id` and `sessionEpoch`, and re-signs the cookie
 * with a fresh expiry, for any token that decodes: `sessionCallback` (lib/auth/callbacks.ts) makes no database check
 * (node_modules/@auth/core/lib/actions/session.js). So a session `resolveIdentity` refuses on every page and API call
 * (sign out everywhere, a password change or reset, deactivation, deletion, past 7 days) would still read as signed in
 * there and have its expiry moved; UI's Stay signed in reads it (components/layout/IdleWarning).
 *
 * On that one path (trailing slashes removed) the guard resolves the identity first, through `tryResolveIdentity`, the
 * choke point's soft form. Found: next-auth's own Response, untouched (its CSRF check on `POST` included; the guard never
 * reads the body). Refused (null): next-auth's own answer for no session, without calling it: 200, JSON `null`, the cache
 * headers for `GET` only (next-auth leaves them out on the update, `POST`), and every session-token cookie the request
 * carried cleared as `sessionStore.clean()` serialises them; nothing is signed. A database failure is not a refusal: it
 * propagates, so an outage is a 500 and never a quiet sign-out. Every other path goes straight to next-auth and reads
 * nothing, so a sign-in POST never meets an identity read.
 *
 * `tryResolveIdentity` is imported inside the function, as `resolveFromSession` imports `auth` (lib/auth/identity.ts), so
 * this file loads under vitest without Next; tests pass `deps.resolve`. It imports neither `auth` nor next-auth's JWT module.
 */
export const SESSION_PATH = '/api/auth/session';

/** next-auth's session-token cookie, either name, with an optional chunk suffix (`.0`, `.1`, ...). */
const SESSION_TOKEN_COOKIE = /^(__Secure-)?authjs\.session-token(\.\d+)?$/;

export async function guardSessionRead<R extends Request>(
  req: R,
  delegate: (req: R) => Promise<Response>,
  deps: { resolve?: () => Promise<unknown | null> } = {},
): Promise<Response> {
  if (new URL(req.url).pathname.replace(/\/+$/, '') !== SESSION_PATH) return delegate(req);
  const resolve = deps.resolve ?? (async () => (await import('./identity')).tryResolveIdentity());
  if ((await resolve()) !== null) return delegate(req);
  return noSession(req);
}

/** next-auth's answer for no session, with the request's session-token cookies cleared. */
function noSession(req: Request): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (req.method !== 'POST') {
    headers.set('Cache-Control', 'private, no-cache, no-store');
    headers.set('Expires', '0');
    headers.set('Pragma', 'no-cache');
  }
  for (const name of cookieNames(req.headers.get('cookie'))) {
    if (!SESSION_TOKEN_COOKIE.test(name)) continue;
    headers.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${name.startsWith('__Secure-') ? '; Secure' : ''}`);
  }
  return new Response('null', { status: 200, headers });
}

function cookieNames(cookieHeader: string | null): string[] {
  if (!cookieHeader) return [];
  return cookieHeader.split(';').map((p) => p.split('=')[0].trim()).filter((n) => n.length > 0);
}
