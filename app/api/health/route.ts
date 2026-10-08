import { databaseReachable } from '@/lib/data/health';

/**
 * Liveness for the uptime monitor and the container's own healthcheck (INFRA-12, D-236).
 *
 * `{"status":"ok"}` with 200 when the database answers, `{"status":"unavailable"}` with 503
 * when it does not or does not answer in time. Nothing else is ever in the body: no version,
 * no error text, no timing. The route is open to the internet because the monitor carries no
 * credentials, so it may not tell a stranger anything about the database or the build.
 *
 * It does no authentication and no organisation lookup, and takes no request. Rate limiting
 * is still `proxy.ts`'s, as for every `/api/*` route.
 *
 * `dynamic = 'force-dynamic'` states that the answer is made per request. Next 16 does not
 * cache a GET handler by default (node_modules/next/dist/docs/01-app/01-getting-started/
 * 15-route-handlers.md, "Caching"), so today the export changes nothing: `next build` lists
 * the route as dynamic with or without it. It is here so the intent is pinned. A
 * `force-static` in its place is measured to make the build run the handler once and write
 * `{"status":"ok"}` to `.next/server/app/api/health.body`, which a monitor can then read
 * forever without the database being asked. `Cache-Control: no-store` is what keeps
 * Cloudflare and any browser from holding an answer, and is the control that matters at the
 * edge. __tests__/unit/health-route.test.ts holds both.
 *
 * The boot check (`instrumentation.ts`) is separate. If the database roles are wrong the
 * process exits before this route can answer, and the container healthcheck fails because
 * nothing is listening, which is the intended signal.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const ok = await databaseReachable();
  return Response.json(
    { status: ok ? 'ok' : 'unavailable' },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
