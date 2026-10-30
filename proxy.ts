import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { checkRateLimit } from '@/lib/rate-limit';
import { exportRefusalLocation } from '@/lib/http/exportRefusal';
import { publicOrigin } from '@/lib/publicOrigin';
import { requireAuthSecret } from '@/lib/auth/secret';
import { usesSecureCookies } from '@/lib/auth/secureCookie';

/**
 * Identity for a request that did not arrive through nginx, and therefore
 * carries no trustworthy client address. Deliberately not an IP literal: it
 * must never collide with a real client's bucket.
 */
const UNKNOWN_CLIENT_IP = 'unknown-no-forwarded-for';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * Task 6 (active org as a URL segment): deliberately UNCHANGED here. The
 * `/orgs/[slug]/*` matcher already falls out of the existing generic page
 * pattern below, so no new route needs listing. What this function must NOT
 * grow, now that org membership is a real thing routes can be gated on, is
 * any check of WHICH org a request may reach, or any OTHER authorization
 * decision that needs a fresh database read (`mustChangePassword`,
 * `isActive`, `sessionEpoch`, org membership) — ADR-0002 requires those read
 * fresh from Postgres on every request, at ONE choke point,
 * `requireIdentity()` / `requireIdentityForApi()` (lib/auth/identity.ts),
 * enforced by an ESLint rule banning any other import of `auth` from
 * `lib/auth`. That is an architectural decision, not a runtime one.
 *
 * CHECKED, 2026-08-05 (CRITICAL-1): "enforced by an ESLint rule" was FALSE
 * from Task 5 until this fix — a second `no-restricted-imports` block added
 * for the `createOrgContext` ban (D-089) silently replaced this one's
 * options wherever both applied, because flat config replaces a rule's
 * options per matching object rather than merging them. `eslint.config.mjs`
 * now carries all three bans in one non-colliding block, and
 * `__tests__/lint/effective-config.test.ts` pins the RESOLVED config so this
 * sentence stays checked rather than trusted.
 *
 * CORRECTION, 2026-08-05: this comment previously justified the split by
 * saying proxy "runs on the edge runtime, where Prisma cannot reach
 * Postgres". That is false for this Next.js version and was asserting a
 * guarantee the code no longer provides (exactly the D-081 shape) —
 * verified against `node_modules/next/dist/docs/01-app/02-guides/upgrading/
 * version-16.md`: "The edge runtime is NOT supported in `proxy`. The
 * `proxy` runtime is `nodejs`, and it cannot be configured." `middleware`
 * (edge-capable) was renamed to `proxy` (Node.js-only) in v16; this file is
 * `proxy.ts`. So Prisma could physically run here now. The reason it still
 * does not is the one stated above: a second identity/org-resolution path
 * here would be exactly the divergence-between-checks ADR-0002 exists to
 * close, independent of what the runtime permits.
 *
 * The one thing this file does for page requests below is forward the
 * request's own pathname as a header, so `requireIdentity()` can tell
 * whether the CURRENT request already targets `/change-password` — its one
 * exemption from the must-change-password redirect it enforces after a
 * fresh, per-request database read. Proxy does not make that redirect
 * decision itself. Membership resolution happens once per request, from the
 * database, in the `/orgs/[slug]` layout
 * (app/(authenticated)/orgs/[slug]/layout.tsx) and independently in every
 * API route.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method;

  // Page requests: forward the pathname so the identity choke point
  // (`requireIdentity()`, lib/auth/identity.ts) knows its own target — see
  // the module doc above for why the must-change-password decision itself
  // is made there, from a fresh database read, and not here.
  if (!pathname.startsWith('/api/')) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-pathname', pathname);
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Client identity, from ONE header.
  //
  // nginx overwrites `X-Forwarded-For` with the address it restored from
  // `CF-Connecting-IP` (docker/nginx/default.conf), so what arrives here is a
  // single value written by our own proxy, not by the client. That is only
  // trustworthy because the Hetzner Cloud Firewall admits Cloudflare alone --
  // verified 2026-08-29, when check 1b of docs HETZNER_FIREWALL_SETUP.md
  // returned 521 from a Cloudflare address while a direct request from
  // elsewhere timed out. **If that firewall is ever loosened, this line
  // becomes worse than what it replaced**, because it would then trust a
  // header an attacker can set directly.
  //
  // The previous code read `x-forwarded-for ?? x-real-ip ?? '127.0.0.1'`. The
  // defect was the CHAIN, not either header: an attacker simply omits
  // `x-forwarded-for` and identity selection falls to `x-real-ip`, which they
  // also control, buying a fresh rate-limit bucket per forged value. A
  // fallback chain does not degrade to the safest option -- it degrades to
  // whichever option the attacker can still reach.
  //
  // `UNKNOWN_CLIENT_IP` rather than `127.0.0.1`: a request with no
  // `X-Forwarded-For` did not come through nginx, and pretending it came from
  // localhost hides that. Everything unattributable shares one bucket, which
  // over-limits rather than under-limits, and reads as what it is in the logs.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || UNKNOWN_CLIENT_IP;

  // Extract userId from JWT (if authenticated).
  //
  // Fix round 1, Important 2 (task-6-report.md): before this, `getToken`
  // was called with no `secret`. `getToken`, as imported here from
  // `next-auth/jwt`, is a PLAIN re-export of `@auth/core/jwt`'s own
  // `getToken` (`node_modules/next-auth/jwt.js` is just `export * from
  // "@auth/core/jwt"`, verified by reading the runtime file, not the type
  // declaration) — and that implementation reads NO environment variable
  // for the secret at all: `secret` comes only from the `params` object
  // passed in, with no `?? process.env.AUTH_SECRET` default anywhere in
  // it. (`@auth/core/jwt.js`'s own module doc claims it "uses the
  // AUTH_SECRET environment variable" — that claim does NOT hold for this
  // call path; proven live, twice: `__tests__/unit/auth-secret.test.ts`
  // shows `getToken({req})` throws `MissingSecret` even with
  // `NEXTAUTH_SECRET` set in `process.env`, and an earlier ad hoc script
  // against this project's real `.env` reproduced the identical throw.)
  // This project's `.env`/`.env.example`/`docker-compose.prod.yml` set
  // `NEXTAUTH_SECRET` throughout — `AUTH_SECRET` is set nowhere in this
  // codebase — so `getToken` threw on every call carrying a session
  // cookie, unconditionally. The catch
  // below swallowed that unconditionally under a comment reading "no token
  // available", which was true for a genuinely absent cookie but FALSE for
  // this case — `userId` was always `null`, and every `keyBy: 'userId'`
  // rate-limit rule (D-151's evidence-upload rule, `DELETE:/api/users/me`
  // at max 1/hour, `default`) silently fell back to the client-controlled
  // `x-forwarded-for` header (D-114 Finding 2, which recorded this as a
  // possibility; it was in fact the UNCONDITIONAL current state). Fixed by
  // passing the same `requireAuthSecret()` (lib/auth/secret.ts) `lib/auth.ts`
  // now passes explicitly to `NextAuth()`, so the two cannot drift apart.
  //
  // What a throw means NOW: `@auth/core/jwt.js`'s own `getToken`
  // (confirmed by reading its source directly, not assumed) already wraps
  // the actual token DECODE in its own try/catch and resolves a
  // corrupted/tampered/undecodable token to `null` -- NOT a throw. The
  // ONLY throw path left, once a secret is always supplied, is
  // `requireAuthSecret()` itself failing (NEXTAUTH_SECRET unset after the
  // process started -- which would also break `lib/auth.ts`'s own
  // NextAuth() call, so this is not a QUIET failure mode either way) or a
  // genuine unexpected library error. So a throw here is no longer the
  // "no token available" case this comment used to claim -- it is logged,
  // not swallowed, precisely because it is now the ANOMALOUS case (D-114
  // Finding 2's fix). Rate limiting still fails OPEN to IP-based limiting
  // on this path (a deliberate choice, not an oversight: the app is
  // already broken in a louder way if requireAuthSecret() is what threw,
  // since lib/auth.ts's own login flow would be down too) -- but loudly,
  // not silently.
  let userId: string | null = null;
  try {
    const token = await getToken({
      req: request,
      secret: requireAuthSecret(),
      // Without this, `getToken` looks for `authjs.session-token` and salts
      // with that name, while production writes `__Secure-authjs.session-token`
      // -- so every authenticated request resolved to `null` and every
      // `keyBy: 'userId'` rule silently fell back to IP keying. Audit finding
      // DEP-04; `lib/auth/secureCookie.ts` explains the derivation and why it
      // reads configuration rather than a request header.
      secureCookie: usesSecureCookies(),
    });
    if (token?.id) {
      userId = token.id as string;
    }
  } catch (e) {
    // The logging attempt itself must not be able to turn "log this
    // anomaly and fail open" into "crash the request" -- a
    // silent-failure-hunter finding on this exact fix: `String(e)` is not
    // airtight (an object with a poisoned `toString`/`Symbol.toPrimitive`
    // can make it throw), and nothing wraps the ORIGINAL call. Every real
    // error this specific chain (`getToken`/`requireAuthSecret`) can throw
    // today is a genuine `Error`, so this is defence-in-depth, not a fix
    // for an observed failure -- but this choke point gates ALL `/api/*`
    // traffic, so "logging can't crash the caller" is worth having here
    // even where it is not currently reachable.
    try {
      logSecurityEvent('AUTH_TOKEN_DECODE_FAILURE', 'error', {
        details: { pathname, message: e instanceof Error ? e.message : String(e) },
      });
    } catch {
      console.error('proxy: getToken failed AND logging that failure also failed', pathname);
    }
  }

  const result = checkRateLimit(method, pathname, ip, userId);

  if (!result.success) {
    // C6 whole-branch review, orphan sweep. `RATE_LIMIT_EXCEEDED` was
    // declared in `lib/security-logger.ts`'s `SecurityEvent` union and
    // emitted nowhere: this block built the 429 and returned it silently,
    // in a file that already imports `logSecurityEvent` and uses it two
    // blocks up. That left the structured log quiet during exactly the
    // traffic the limiter exists to blunt — an operator watching the one
    // stream every other security event lands in would see a flood as an
    // absence.
    //
    // `userId` may be null (unauthenticated, or the fail-open path above);
    // `ip` is the client-controlled `x-forwarded-for` when present, which
    // is a known limitation of this whole choke point (D-124), not a new
    // one introduced here — it is logged for attribution, never trusted as
    // identity. `warn`, matching every other refusal-shaped event in this
    // codebase (`INPUT_VALIDATION_FAILURE`), not `error`: a refused request
    // is the control working.
    //
    // Gated on `firstRefusal` (lib/rate-limit.ts) after a `code-review`
    // finding on the first draft of this fix, which logged EVERY refused
    // request: that makes log volume track ATTACK volume 1:1, with an
    // attacker-controlled `x-forwarded-for` and pathname in every line, so
    // a fix for a silent control would have handed over a log-amplification
    // vector instead. One line per (bucket, window) carries the same
    // information — the limit was breached, by which identifier, on what
    // path, and when it resets — and cannot be inflated by sending more.
    if (result.firstRefusal) {
      logSecurityEvent('RATE_LIMIT_EXCEEDED', 'warn', {
        ...(userId ? { userId } : {}),
        ip,
        details: { pathname, method, limit: result.limit },
      });
    }
    // The one key whose refusal a browser navigation can meet: the team export is a plain link on S-20, so a
    // JSON body would be shown raw. A navigation to it goes back to S-20 of the same scope instead
    // (contract Routes row 20, owner question B4). The slug and project id are checked by
    // `exportRefusalLocation`; when it answers null the JSON 429 below stands.
    const exportPath = method === 'GET' ? /^\/api\/v1\/orgs\/([^/]+)\/export$/.exec(pathname) : null;
    if (exportPath && request.headers.get('sec-fetch-mode') === 'navigate') {
      const location = exportRefusalLocation(exportPath[1], request.nextUrl.searchParams.get('projectId'), 'rate_limited');
      // Absolute, on the public origin: this layer parses a response `Location` with `new URL` and a relative
      // one is an ERR_INVALID_URL, a 500 (verified live), and the request's own origin is the container's
      // behind nginx (lib/publicOrigin.ts says why it is never used).
      if (location) {
        try {
          return NextResponse.redirect(new URL(location, publicOrigin()), 303);
        } catch {
          // publicOrigin() throws without NEXTAUTH_URL or AUTH_URL. The refusal is logged above, once per window, so
          // the redirect, a convenience, is dropped and the JSON 429 below stands.
        }
      }
    }
    // At least one second: the window can end between the limiter's answer and this line, and a wait of
    // 0 seconds is no wait (RateLimitedError refuses it for the same reason).
    const retryAfter = Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
    return new NextResponse(
      JSON.stringify({
        error: 'Too many requests. Please try again later.',
        code: 'rate_limited',
        retryAfterSeconds: retryAfter,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(result.limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': result.resetAt.toISOString(),
        },
      },
    );
  }

  const response = NextResponse.next();
  response.headers.set('X-RateLimit-Limit', String(result.limit));
  response.headers.set('X-RateLimit-Remaining', String(result.remaining));
  response.headers.set('X-RateLimit-Reset', result.resetAt.toISOString());
  return response;
}

export const config = {
  // API routes (rate limiting) plus every other path except Next's own `_next/static` and `_next/image`. No path is
  // skipped for what it ends in: on a path the proxy does not run on, `x-pathname` is whatever the client sent, and
  // `requireIdentity()` (lib/auth/identity.ts) decides its must-change-password gate from that header. A project id
  // or an unknown path can end in `.png` or `.svg` and still reach a page layout, so the header must always be the
  // proxy's own value. Files under `public/` pass through `NextResponse.next()` unchanged.
  matcher: ['/api/:path*', '/((?!_next/static|_next/image).*)'],
};
