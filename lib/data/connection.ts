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

  // A non-empty string is not enough. An adversarial review showed that
  // `postgresql://localhost:5432/makrai_test`, `postgresql://` and
  // `postgres://:@localhost:5432/db` all pass a presence check and then fall
  // through to PG* anyway — connecting as the OWNER (rolsuper, rolbypassrls)
  // with PGUSER set. Checking only for emptiness closed the instance and left
  // the class open, which is the mistake this branch keeps repeating.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${name} is not a valid URL. See ADR-0001.`);
  }
  if (parsed.username === '' || parsed.hostname === '' || parsed.pathname.replace('/', '') === '') {
    throw new Error(
      `${name} must specify user, host and database (postgresql://user:pass@host:port/db). ` +
        `A partial URL still lets pg fall back to PG* environment variables, which can ` +
        `silently connect as the schema owner and bypass RLS. See ADR-0001.`,
    );
  }
  return url;
}

/**
 * Caches a client on `globalThis` outside production, so Next.js dev hot-reload
 * does not accumulate a new `PrismaClient` (and its `pg.Pool`) on every module
 * re-evaluation until the server runs out of connections.
 *
 * Extracted because the pattern was hand-rolled at four sites and D-060 exists
 * precisely because it was once omitted at two of them. A named helper makes the
 * omission visible at the call site instead of relying on the next author
 * remembering three lines of boilerplate.
 */
export function hmrSingleton<T>(key: string, create: () => T): T {
  const store = globalThis as unknown as Record<string, T | undefined>;
  const existing = store[key];
  if (existing !== undefined) return existing;

  const created = create();
  if (process.env.NODE_ENV !== 'production') store[key] = created;
  return created;
}
