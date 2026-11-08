/**
 * Next.js calls `register()` once when a server instance starts
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md).
 * Next skips it during `next build` itself (instrumentation-globals.external.js returns
 * early when NEXT_PHASE is 'phase-production-build'), so the build needs no database.
 *
 * Node.js runtime only: the check needs `pg`, and the edge runtime has no database
 * driver. The import is inside the branch, as the guide recommends, so the edge bundle
 * never pulls `pg` in. The same goes for the console redaction, which needs `node:util`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // RL 2.3 / 7.12: no email address in any log line. Everything the server prints goes
  // through `console.*`, including Next's own error printing (measured: the built server
  // makes no direct write to stdout or stderr), so wrapping the four methods covers it.
  // This is first, before the role check, so that the check's own error output, which can
  // carry a connection error naming a user, is redacted too.
  try {
    const { installConsoleRedaction } = await import('./lib/redact');
    installConsoleRedaction();
  } catch (e) {
    // Fail closed, for the same reason as the role check below. Printing is safe: this is
    // a failure to load our own module, and no address is in play yet.
    console.error('Refusing to start: console redaction could not be installed.', e);
    process.exit(1);
  }

  // ADR-0009: both database lanes must be unprivileged, or nothing is served. This is
  // the check that covers the identity lane's clients, which have no per-call one.
  try {
    // Inside the try: a module that fails to load (pg missing from the standalone
    // trace, say) must exit like a failed check, not reject.
    const { verifyDatabaseRoles } = await import('./lib/data/connection');
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

  // FR-ACC-02, SRS 6.7: every page and route behind the acceptance gate needs the current text
  // of each kind, so a registry that cannot load (a malformed or missing file) stops the start
  // here, by exiting as above, rather than serving a gate built on a text nobody can show. The
  // import is inside the try for the same reason as the role check's. No words of any text are
  // read here.
  try {
    const { LEGAL_KINDS, currentLegalText } = await import('./lib/legal/registry');
    for (const kind of LEGAL_KINDS) currentLegalText(kind);
  } catch (e) {
    console.error('Refusing to start: the legal texts could not be loaded.', e);
    process.exit(1);
  }
}
