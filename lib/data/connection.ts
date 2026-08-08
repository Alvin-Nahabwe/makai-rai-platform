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
  // PGOPTIONS is the one PG* variable that can change query SEMANTICS rather
  // than just routing: `PGOPTIONS='-c app.current_org_id=<org>'` pre-sets the
  // isolation GUC on every pooled connection, so a query that never called
  // withOrg returns that org's rows — inverting the fail-closed property T2
  // asserts. `requireDatabaseUrl` cannot prevent that on its own (pg resolves
  // PG* per field, and this check only covers user/host/database), so the Pool
  // configs pass `options: ''` explicitly. Reject the in-URL form here.
  if (parsed.searchParams.has('options')) {
    throw new Error(
      `${name} must not carry an 'options' query parameter: it can pre-set ` +
        `app.current_org_id and defeat the isolation guarantee. See ADR-0001.`,
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
 *
 * LAZY (fix round 2, task-6-report.md, D-156). `create` used to run the
 * instant `hmrSingleton` was called — and every one of its four callers
 * invokes it at MODULE TOP LEVEL (`export const appClient = hmrSingleton(...)`
 * in `lib/data/tenant.ts`, and the identical shape in `lib/data/identity.ts`
 * (twice) and `lib/data/preauth.ts`), which runs the instant the module is
 * imported. `next build`'s "Collecting page data" phase imports every route
 * module to inspect it — so `create` (which calls `requireDatabaseUrl`,
 * throwing if unset, then constructs a real `pg.Pool`) ran DURING THE BUILD.
 * That was invisible for most of this project's life because `.env` was
 * copied into the Docker builder stage by `docker/Dockerfile:18`'s
 * `COPY . .` — the same leak D-149 existed to close. Closing that leak
 * (a correct, necessary fix) removed `DATABASE_URL` from the build
 * environment along with the secret, and the eager construction here broke
 * as an unassessed consequence three steps downstream — not a pre-existing,
 * unrelated defect. See D-156 for the full causal chain.
 *
 * Generalises the identical fix already made for `lib/auth.ts`'s
 * `requireAuthSecret()` (NextAuth's own lazy-initialisation pattern,
 * `NextAuth(() => ({...}))`) to this sibling case, via a `Proxy` instead of
 * a framework-provided lazy hook — `hmrSingleton` has no such hook of its
 * own to defer to. Every property access (`appClient.$transaction`,
 * `identityDb.user.findMany`, `ownerClient.membership.findMany`, ...) is
 * forwarded through `get`, which constructs (or reuses the cached) real
 * instance on first touch — deferred to actual REQUEST time, never at
 * import time, with ZERO changes needed at any of the ~15 call sites across
 * this codebase (verified by enumerating every one before this fix, not
 * assumed transparent). Methods are explicitly `.bind(instance)`'d so
 * `this` inside them is the REAL client, not the Proxy — required for any
 * method (Prisma's own, or `identityDb`'s hand-bound ones) that reads its
 * own internal state via `this`.
 *
 * A LAZY guard that never fires is worse than an eager one that fires too
 * early: `getOrCreate()` deliberately re-attempts (and re-throws) on every
 * access until construction actually succeeds — a transient failure must
 * not poison the process into skipping the check forever, mirroring
 * `withOrg`'s own `identityVerified` re-attempt-on-failure discipline in
 * `lib/data/tenant.ts`.
 */
export function hmrSingleton<T extends object>(key: string, create: () => T): T {
  const store = globalThis as unknown as Record<string, T | undefined>;

  function getOrCreate(): T {
    // Object.hasOwn, not a bare read: `store[key]` walks the prototype chain, so
    // `Object.prototype.appClient = X` would make this hand back X instead of a
    // real client — in production too, where this function deliberately never
    // writes. This is the identical class already closed in lib/authz/policy.ts;
    // no reachable pollution primitive exists on this branch, so it is
    // defence-in-depth, but the fix is one call.
    const existing = Object.hasOwn(store, key) ? store[key] : undefined;
    if (existing !== undefined) return existing;

    const created = create();
    if (process.env.NODE_ENV !== 'production') store[key] = created;
    return created;
  }

  // Every trap below forwards to the REAL instance (`getOrCreate()`), never
  // to the throwaway `{}` target -- `get`/`has` alone left enumeration
  // (`Object.keys`, `Object.getOwnPropertySymbols`, `JSON.stringify`,
  // `{...spread}`, `for...in`) silently answering against the empty
  // target instead, found by the full suite run against
  // `identityDb`'s own "exposes exactly the constructed surface" pin
  // (__tests__/integration/data-boundary.test.ts) -- a five-attempt-
  // documented security boundary, not a hypothetical. `ownKeys`/
  // `getOwnPropertyDescriptor` fix that. `set`/`deleteProperty`/
  // `defineProperty` forward too, for a DIFFERENT reason: every current
  // caller's `create()` returns an `Object.freeze()`'d client
  // (`lib/data/identity.ts#createIdentityClient`) or an effectively
  // immutable one (a `PrismaClient` instance), and a lazy wrapper that
  // silently let `identityDb.evil = x` succeed as a no-op on the target
  // -- instead of throwing, as it would pre-fix, in this codebase's
  // always-strict ES modules -- would be a quiet regression in exactly
  // the property a frozen, adversarially-reviewed object exists to hold.
  return new Proxy({} as T, {
    get(_target, prop, _receiver) {
      const instance = getOrCreate();
      const value = Reflect.get(instance as object, prop, instance);
      return typeof value === 'function' ? value.bind(instance) : value;
    },
    has(_target, prop) {
      return Reflect.has(getOrCreate() as object, prop);
    },
    ownKeys(_target) {
      return Reflect.ownKeys(getOrCreate() as object);
    },
    getOwnPropertyDescriptor(_target, prop) {
      const desc = Reflect.getOwnPropertyDescriptor(getOrCreate() as object, prop);
      // Proxy invariant: a NON-configurable property may only be reported
      // if the TARGET (the throwaway `{}`, always extensible, never
      // holding this key) also has it non-configurable -- which it
      // structurally cannot. Forcing `configurable: true` here is what the
      // spec requires, not a weakening: actual mutation is independently
      // rejected by `set`/`deleteProperty`/`defineProperty` below,
      // regardless of what this descriptor reports.
      if (desc) desc.configurable = true;
      return desc;
    },
    set(_target, prop, value) {
      return Reflect.set(getOrCreate() as object, prop, value);
    },
    deleteProperty(_target, prop) {
      return Reflect.deleteProperty(getOrCreate() as object, prop);
    },
    defineProperty(_target, prop, descriptor) {
      return Reflect.defineProperty(getOrCreate() as object, prop, descriptor);
    },
  });
}
