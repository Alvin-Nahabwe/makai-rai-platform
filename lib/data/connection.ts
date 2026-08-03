/**
 * Connection-string acquisition for the three data-access clients.
 *
 * This exists because `new Pool({ connectionString: undefined })` does NOT
 * throw. `pg` tests the value for truthiness (`pg/lib/connection-parameters.js`:
 * `if (config.connectionString)`) and, when it is absent, falls through to the
 * `PG*` environment variables and then to libpq-style defaults —
 * `host: 'localhost'`, `user: process.env.USER`, database named after the user.
 *
 * That is the single highest-consequence silent failure available on this
 * branch. `PGUSER`/`PGPASSWORD` are conventional to set in containers and CI,
 * and `.env.example` hands an operator the OWNER credential (`makrai`). If
 * `APP_DATABASE_URL` is unset or misspelled while those are set, `appClient`
 * silently becomes a SUPERUSER/BYPASSRLS connection: `withOrg` still sets the
 * GUC, RLS is bypassed entirely, and every tenant query returns every
 * organization's rows with a correct-looking HTTP 200 and no error anywhere.
 *
 * The test suite cannot catch this — `vitest.config.ts` hardcodes both URLs, so
 * it proves the test configuration rather than the deployed one. Hence a
 * load-time check here and an identity assertion on the live connection in
 * `withOrg`. Found by the C6 re-drive (D-086); it survived every earlier pass.
 */
export function requireDatabaseUrl(name: 'APP_DATABASE_URL' | 'DATABASE_URL'): string {
  const url = process.env[name];
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(
      `${name} is not set. Refusing to construct a connection pool: pg would ` +
        `silently fall back to PG* environment variables and libpq defaults, which ` +
        `can land on the schema owner and bypass RLS entirely. See ADR-0001.`,
    );
  }
  return url;
}
