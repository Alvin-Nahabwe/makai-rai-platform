import { appClient } from './tenant';

/**
 * Whether the database answers `SELECT 1` within `timeoutMs`. Never throws.
 *
 * This is what GET /api/health reports, and so what the container healthcheck and the
 * uptime monitor read. It uses `appClient` (makrai_app, the connection every tenant request
 * uses), so a 200 means the web process can reach the database with the credentials it
 * serves with. It deliberately does not go through `withOrg`: a health check has no org,
 * and the role check `withOrg` runs is the boot check's job (`instrumentation.ts`).
 *
 * Every failure is `false`, and the cause goes to the log, not to the caller: a refused
 * connection, a wrong password, an unset `APP_DATABASE_URL`, a query that never returns.
 * `appClient` is a lazy proxy that throws from the property access itself when its URL is
 * unset (`hmrSingleton`, lib/data/connection.ts), so that access has to sit inside the `try`
 * with the query, not before it.
 *
 * The timeout abandons the wait, not the query. A query that hangs keeps its pooled
 * connection until the driver returns it, and nothing here cancels it. While the database
 * hangs that is one connection per check (the container's every 30 seconds, plus the
 * monitor's) out of the pool's ten, which a hang that long would starve for tenant requests
 * anyway.
 */
export async function databaseReachable(timeoutMs = 2000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
    });
    await Promise.race([appClient.$queryRaw`SELECT 1`, timedOut]);
    return true;
  } catch (e) {
    // Server-side only. The response says "unavailable" and nothing else; this line is how
    // an operator learns why (`docker logs`, or the journal under the makrai/ tag).
    console.error('health: database check failed:', e instanceof Error ? e.message : String(e));
    return false;
  } finally {
    clearTimeout(timer);
  }
}
