/**
 * Next.js calls `register()` once when a server instance starts
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md).
 * Next skips it during `next build` itself (instrumentation-globals.external.js returns
 * early when NEXT_PHASE is 'phase-production-build'), so the build needs no database.
 *
 * Node.js runtime only: the check needs `pg`, and the edge runtime has no database
 * driver. The import is inside the branch, as the guide recommends, so the edge bundle
 * never pulls `pg` in.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // ADR-0009: both database lanes must be unprivileged, or nothing is served. This is
  // the check that covers the identity lane's clients, which have no per-call one.
  const { verifyDatabaseRoles } = await import('./lib/data/connection');
  try {
    await verifyDatabaseRoles();
  } catch (e) {
    // Exit rather than reject. A rejected register() does NOT stop Next 16: measured
    // against both `next start` and the standalone `server.js`, the server logs
    // "Failed to prepare server", keeps listening, and answers every request with 500,
    // because Next memoises the rejected registration and re-awaits it per request.
    // That is closed, but it is also permanent: a server started before its role had
    // a password, or while Postgres was briefly down, would keep refusing after the
    // cause was fixed, while `docker compose ps` showed it Up. Exiting makes the
    // refusal visible and lets the restart policy retry until the check passes.
    console.error('Refusing to start: the database role check failed.', e);
    process.exit(1);
  }
}
