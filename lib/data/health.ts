import { appClient } from './tenant';

/** Rejected by the timer, so the log can tell "no answer" from "an answer that was an error". */
class NoAnswer extends Error {}

/**
 * What the log may say about a failure: a fixed word for a timeout, otherwise the error's
 * class name. Never its message. A driver's message can carry a role name, a host, a port
 * or a connection string, and this line sits in the journal for 90 days.
 */
function failureKind(e: unknown): string {
  if (e instanceof NoAnswer) return 'timeout';
  return e instanceof Error ? e.name : 'non-Error';
}

/**
 * Whether the database answers `SELECT 1` within `timeoutMs`. Never throws.
 *
 * This is what GET /api/health reports, and so what the container healthcheck and the
 * uptime monitor read. It uses `appClient` (makrai_app, the connection every tenant request
 * uses), so a 200 means the web process can reach the database with the credentials it
 * serves with. It deliberately does not go through `withOrg`: a health check has no org,
 * and the role check `withOrg` runs is the boot check's job (`instrumentation.ts`).
 *
 * Every failure is `false`, and the kind goes to the log, not to the caller: a refused
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
      timer = setTimeout(() => reject(new NoAnswer()), timeoutMs);
    });
    await Promise.race([appClient.$queryRaw`SELECT 1`, timedOut]);
    return true;
  } catch (e) {
    // Server-side only. The response says "unavailable" and nothing else; this line tells an
    // operator that the check failed and how it ended (`docker logs`, or the journal under the
    // makrai/ tag), not what the driver said. The message is deliberately left out.
    console.error(`health: database check failed (${failureKind(e)})`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
