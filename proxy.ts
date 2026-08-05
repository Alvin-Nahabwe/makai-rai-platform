import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { checkRateLimit } from '@/lib/rate-limit';

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

  // Extract IP
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    '127.0.0.1';

  // Extract userId from JWT (if authenticated)
  let userId: string | null = null;
  try {
    const token = await getToken({ req: request });
    if (token?.id) {
      userId = token.id as string;
    }
  } catch {
    // Pre-auth request — no token available, use IP-based limiting
  }

  const result = checkRateLimit(method, pathname, ip, userId);

  if (!result.success) {
    const retryAfter = Math.ceil((result.resetAt.getTime() - Date.now()) / 1000);
    return new NextResponse(
      JSON.stringify({ error: 'Too many requests. Please try again later.' }),
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
  // API routes (rate limiting) plus all pages except Next internals and static
  // assets (forced-password-change enforcement).
  matcher: ['/api/:path*', '/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|svg|ico|webp)$).*)'],
};
