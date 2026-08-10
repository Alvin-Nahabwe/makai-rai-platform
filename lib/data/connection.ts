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
 * Memo tier 1 — see `hmrSingleton`'s own doc comment below for why there are
 * two and why conflating them broke production. Declared out here, above that
 * comment, so the comment stays attached to `hmrSingleton` itself: a JSDoc
 * block documents whatever declaration follows it, so a `const` slipped
 * between the two would quietly steal the function's hover documentation.
 */
const instances = new Map<string, object>();

/**
 * Returns a process-wide singleton for `key`, constructed lazily on first use.
 *
 * TWO memo tiers, and the distinction is load-bearing (fix round 4, D-157):
 *
 *   1. `instances`, module-scoped — the singleton itself, in EVERY environment.
 *   2. `globalThis[key]`, read AND written outside production only — a bridge
 *      across Next.js dev hot-reload, which re-evaluates this module and
 *      therefore empties tier 1. Without it, dev would accumulate a new
 *      `PrismaClient` (and its `pg.Pool`) per save until the server ran out of
 *      connections.
 *
 * They are consulted in order and tier 1 wins outright; they are NOT kept in
 * sync, and nothing here tries to. Once tier 1 holds a client, a later write to
 * `globalThis[key]` by anything else is simply never observed — which is the
 * correct behaviour for a singleton, and worth stating because "two tiers"
 * invites the assumption that they agree.
 *
 * Conflating the two is what broke production between fix rounds 2 and 4: tier 2
 * looks like the cache, so when the lazy Proxy removed the implicit tier-1 memo
 * (the caller's own `export const`), nothing noticed that production had been
 * left with no memo at all. Tier 2's `NODE_ENV` condition is about globalThis
 * hygiene and hot-reload; it is not, and never was, the singleton mechanism.
 *
 * `key` is a bare string and `instances` is process-wide, so two call sites
 * sharing a key silently share a client — and the four current keys do not all
 * carry the same authority (`appClient` is NOBYPASSRLS; `identityBaseClient`
 * and `preauthClient` are the schema OWNER). Held by a generated check in
 * `__tests__/integration/trigger-enumeration.test.ts`, not by memory.
 *
 * Extracted because the pattern was hand-rolled at four sites and D-060 exists
 * precisely because it was once omitted at two of them. A named helper makes the
 * omission visible at the call site instead of relying on the next author
 * remembering three lines of boilerplate.
 *
 * LAZY (fix round 2, task-6-report.md, D-156).
 * NOTE: fix round 4 is what makes the sentence below about "reuses the cached
 * real instance" true in production as well as in dev. Before it, that clause
 * described the intent rather than the behaviour. `create` used to run the
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
 * `lib/data/tenant.ts`. **That guarantee is scoped to a SYNCHRONOUS throw**,
 * which is all any current `create()` can produce. Qualified fix round 4
 * after `silent-failure-hunter` showed the unqualified wording was false for
 * an async `create()` — a returned rejected Promise is memoised as a success.
 * See D-159; it is a real fail-open the day a connection string comes from a
 * secrets manager, and it is cheap to catch now and expensive to notice then.
 */
export function hmrSingleton<T extends object>(key: string, create: () => T): T {
  const store = globalThis as unknown as Record<string, T | undefined>;

  function getOrCreate(): T {
    // FIRST tier, and the only one that runs in production (fix round 4,
    // D-157). `instances` is module-scoped — the SAME storage tier the
    // pre-Proxy code used, where the production singleton was simply the
    // `export const appClient = hmrSingleton(...)` binding in each caller
    // module. That binding stopped being the memo when fix round 2 made
    // this function return a lazy Proxy: the const now holds the Proxy,
    // and the real client had nowhere to live in production, because the
    // `globalThis` write below is deliberately skipped there. Every trap
    // calls getOrCreate(), so `create()` — a `new PrismaClient` over a
    // `new pg.Pool` that nothing ever `.end()`s — ran on EVERY property
    // access, i.e. every `appClient.$transaction(...)` in `withOrg`, i.e.
    // every tenant request in the deployed container. The `NODE_ENV` test
    // guarding the `store[key]` write further down was never wrong; what
    // changed under it was that it became the only memo instead of a
    // supplement to one.
    // `has`, not a truthiness or `!== undefined` test on the value: those
    // conflate "not memoised yet" with "memoised a falsy value", so a
    // `create()` returning `undefined` would silently re-run on every access
    // — reintroducing, for that one shape, the exact per-access
    // reconstruction this tier exists to prevent. `T extends object` makes
    // it unreachable today; `has` makes it unreachable by construction.
    if (instances.has(key)) return instances.get(key) as T;

    // Tier 2 is DEV-ONLY IN BOTH DIRECTIONS, and the single `hmrEnabled` flag
    // is the point. Until fix round 4 the WRITE was gated and the READ was
    // not, which is backwards: this function only ever writes here outside
    // production, so in production anything FOUND here was, by definition,
    // not put here by this function — an injected global, a name collision,
    // a stray assignment. Trusting it meant `create()` never ran, and with
    // it `requireDatabaseUrl()` never ran: the D-086 / ADR-0001 guard against
    // `pg` falling back to `PG*` and landing on the schema owner simply
    // stopped firing, silently and permanently. Found by
    // `pr-review-toolkit:silent-failure-hunter` and reproduced in a real node
    // process; pinned in `__tests__/unit/connection.test.ts`. One flag for
    // both so the two can never again drift apart by editing one line.
    const hmrEnabled = process.env.NODE_ENV !== 'production';

    if (hmrEnabled) {
      // Object.hasOwn, not a bare read: `store[key]` walks the prototype chain,
      // so `Object.prototype.appClient = X` would make this hand back X instead
      // of a real client. This is the identical class already closed in
      // lib/authz/policy.ts; no reachable pollution primitive exists on this
      // branch, so it is defence-in-depth, but the fix is one call.
      // (`instances` above needs none: `Map` lookups consult no prototype
      // chain.)
      const existing = Object.hasOwn(store, key) ? store[key] : undefined;
      if (existing !== undefined) {
        instances.set(key, existing);
        return existing;
      }
    }

    // Assumed SYNCHRONOUS and object-returning, which every current caller is
    // (four `new PrismaClient(...)` constructions). The re-attempt-on-failure
    // guarantee documented above holds for a synchronous THROW only: a
    // `create()` that returned a rejected Promise would be memoised below as
    // a success, caching a failed construction and never re-running
    // `requireDatabaseUrl`. See D-159 — pick that up before making any
    // `create()` async (e.g. fetching the connection string from a secrets
    // manager).
    const created = create();
    // Written only AFTER create() returns. A memo populated despite a throw
    // would cache a half-constructed client and permanently skip
    // `requireDatabaseUrl` — the D-086 / ADR-0001 fail-open where pg falls
    // back to PG* and can land on the schema owner, bypassing RLS. The
    // re-attempt-on-failure discipline documented above depends on exactly
    // this ordering.
    instances.set(key, created);
    // Same `hmrEnabled` flag as the read above. This write exists only so a client can
    // survive Next.js dev hot-reload RE-EVALUATING this module, which empties
    // `instances` above; production never re-evaluates modules, so it needs
    // no bridge. Writing here in production would also publish an ambient,
    // import-free handle to a live database client on the tenant-isolation
    // spine — reachable by anything in the process without going through
    // `lib/data/tenant.ts#withOrg`, which that module calls "the ONLY path to
    // tenant data". Pinned in `__tests__/unit/connection.test.ts`'s
    // "globalThis hygiene" block, both directions.
    if (hmrEnabled) store[key] = created;
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
  //
  // REFLECTIVE NOTE, fix round 3 (task-6-report.md), because someone WILL
  // run this and be alarmed otherwise: `Object.isFrozen(identityDb)` now
  // reports `false` (was `true` before this Proxy existed). That is
  // INHERENT to any Proxy over a lazily-constructed target -- freezing the
  // placeholder `{}` would freeze it PERMANENTLY, before `create()` ever
  // runs, which defeats the lazy initialisation this whole file exists
  // for. The BEHAVIOURAL guarantee is intact: every fundamental mutating
  // operation still throws (proven in `__tests__/integration/
  // data-boundary.test.ts` and `__tests__/unit/connection.test.ts`); only
  // the REFLECTIVE observability of that guarantee moved from
  // `Object.isFrozen` to "try to mutate it and watch it throw". See
  // `lib/data/identity.ts`'s own "What enforces what" comment for the
  // full account of what changed and why it is still safe.
  //
  // NON-OBVIOUS, established by deliberately removing each trap in turn
  // (task-6-report.md fix round 3) rather than assumed from reading the
  // spec: `set` is FULLY REDUNDANT with `defineProperty` for ordinary
  // assignment (`identityDb.evil = x`) -- removing `set` ALONE changes
  // nothing observable, because the Proxy's OWN default (no-trap) `[[Set]]`
  // behaviour falls through to `CreateDataProperty` on the RECEIVER (the
  // proxy itself), which re-enters via `defineProperty`. `set` is kept
  // anyway, deliberately: it is a DIRECT, independently-reasoned-about
  // rejection (`Reflect.set` straight to the real frozen instance) that
  // does not rely on that fallback chain, which is genuinely obscure
  // ECMAScript-internals behaviour -- if a future edit ever changes
  // `defineProperty` in a way that breaks the fallback, `set` still holds
  // the line on its own. `defineProperty` and `deleteProperty` are each
  // independently necessary regardless of `set`: `defineProperty` alone
  // also guards the DIRECT `Object.defineProperty()` API, which never
  // goes through `[[Set]]` at all; `deleteProperty`'s absence lets
  // `delete identityDb.user` trivially "succeed" against the always-empty
  // target (deleting a non-existent property is a no-op success under any
  // guard), so it has no fallback to lean on and must stand alone.
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
      // rejected by `deleteProperty`/`defineProperty` below (and by `set`,
      // redundantly with `defineProperty` -- see the note above),
      // regardless of what this descriptor reports.
      if (desc) desc.configurable = true;
      return desc;
    },
    // Kept despite being provably redundant with `defineProperty` for
    // every scenario found so far -- see the note above `new Proxy` for
    // why, and task-6-report.md fix round 3 for the non-vacuity
    // investigation that established it (not assumed).
    set(_target, prop, value) {
      return Reflect.set(getOrCreate() as object, prop, value);
    },
    // Independently necessary -- see the note above `new Proxy`.
    deleteProperty(_target, prop) {
      return Reflect.deleteProperty(getOrCreate() as object, prop);
    },
    // Independently necessary -- see the note above `new Proxy`.
    defineProperty(_target, prop, descriptor) {
      return Reflect.defineProperty(getOrCreate() as object, prop, descriptor);
    },
  });
}
