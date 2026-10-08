import { Client } from 'pg';

/** An environment to read connection strings from: `process.env`, or one a test builds. */
type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Connection-string acquisition for the three data-access clients: `appClient` on
 * `APP_DATABASE_URL` (makrai_app), and the identity lane's two on
 * `IDENTITY_DATABASE_URL` (makrai_identity, ADR-0009). `DATABASE_URL`, the schema
 * owner's, is still an accepted name, but no application client reads it any more.
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
 * The test suite cannot catch this — `vitest.config.ts` hardcodes the URLs, so
 * it proves the test configuration rather than the deployed one. Hence a
 * load-time check here and an identity assertion on the live connection in
 * `withOrg`. Found by the C6 re-drive (D-086); it survived every earlier pass.
 *
 * `env` exists for `verifyDatabaseRoles`, which checks the environment it is handed;
 * every client passes nothing and reads `process.env`.
 */
export function requireDatabaseUrl(
  name: 'APP_DATABASE_URL' | 'IDENTITY_DATABASE_URL' | 'DATABASE_URL',
  env: Environment = process.env,
): string {
  const url = env[name];
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

/** The shape of a Prisma client or transaction handle, as far as this check needs one. */
type RawQueryable = {
  $queryRaw: <T>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
};

/**
 * Asserts, on the LIVE connection, that it is not a superuser, BYPASSRLS or REPLICATION
 * role and cannot become a superuser or BYPASSRLS role with SET ROLE.
 *
 * A presence check on the URL is not sufficient. The URL can be present and still point
 * at the owner — a copy-paste from `.env.example`, one URL reused for two lanes, a
 * staging config that never got its own role. Every other control still "works" then:
 * the GUC is set, the policies exist, the tests pass — and RLS and every grant are
 * ignored, because superuser and BYPASSRLS are properties of the connected role, not of
 * the SQL. This is the one check that verifies the architecture's central assumption
 * against reality rather than against configuration.
 *
 * `rolreplication` is refused because a REPLICATION login can take a base backup of the
 * whole cluster wherever pg_hba allows replication connections, whatever its grants say.
 *
 * `privileged_member` covers the indirect form. `rolsuper` and `rolbypassrls` are not
 * inherited through role membership, but a member can `SET ROLE` to the role that has
 * them, so `GRANT makrai TO makrai_identity` would make the lane a superuser credential
 * while both flags read false.
 *
 * Fails closed: each flag must be a literal `false`. A missing row, or a column a stub or
 * a future query forgot, refuses rather than passes.
 *
 * Callers: `withOrg` on the app lane, memoised once per process (lib/data/tenant.ts),
 * and `verifyDatabaseRoles` below on both lanes at server start.
 */
export async function assertUnprivilegedRole(q: RawQueryable, urlName: string): Promise<void> {
  const rows = await q.$queryRaw<
    {
      current_user: string; rolsuper: unknown; rolbypassrls: unknown;
      rolreplication: unknown; privileged_member: unknown;
    }[]
  >`SELECT current_user, r.rolsuper, r.rolbypassrls, r.rolreplication,
           EXISTS (SELECT 1 FROM pg_roles p
                    WHERE (p.rolsuper OR p.rolbypassrls) AND p.oid <> r.oid
                      AND pg_has_role(r.oid, p.oid, 'MEMBER')) AS privileged_member
      FROM pg_roles r WHERE r.rolname = current_user`;
  const row = rows[0];
  if (
    row?.rolsuper === false && row.rolbypassrls === false &&
    row.rolreplication === false && row.privileged_member === false
  ) return;
  throw new Error(
    `The data layer refuses to run: connected as '${row?.current_user ?? 'unknown'}' ` +
      `(rolsuper=${row?.rolsuper}, rolbypassrls=${row?.rolbypassrls}, ` +
      `rolreplication=${row?.rolreplication}, privileged_member=${row?.privileged_member}) ` +
      `through ${urlName}. A superuser or BYPASSRLS role, or a member of one, ignores ` +
      `row-level security and every grant, and a REPLICATION role can stream the whole ` +
      `cluster. Point ${urlName} at its unprivileged role — see ADR-0001 and ADR-0009.`,
  );
}

/**
 * The two lanes the web process connects with, and the role each must connect as
 * (ADR-0009). The names are fixed by the migrations that create the roles.
 */
const LANES = { APP_DATABASE_URL: 'makrai_app', IDENTITY_DATABASE_URL: 'makrai_identity' } as const;

/**
 * Server-start check for both lanes, awaited by `instrumentation.ts#register`, which
 * exits the process when this rejects. (Next 16 itself does not stop on a rejected
 * `register()`: it keeps listening and answers every request with 500 — measured
 * against `next start` and the standalone `server.js`; instrumentation.ts says why
 * exiting is better.) So a missing or privileged URL means the server never serves.
 *
 * That is what covers the identity lane, which has no per-call check of its own:
 * `identityDb`, the raw `base` client behind `scrubUserOnDeactivation` and its batch
 * `$transaction`, and the preauth client. All three read `IDENTITY_DATABASE_URL` from
 * the same environment this checks.
 *
 * It also pins each lane to its own role. Both roles are unprivileged, so the check
 * above cannot tell them apart, and swapped or reused URLs would put `withOrg` on
 * makrai_identity, whose `identity_lane` policy is `USING (true)`: tenant reads of
 * memberships and invitations would stop being scoped to one organisation, silently.
 *
 * Opens one short-lived `pg.Client` per lane rather than touching the pooled clients,
 * so it checks the environment it is GIVEN, and leaves no pool behind. `options: ''`
 * for the same reason as the pools: PGOPTIONS must not alter the session it inspects.
 */
export async function verifyDatabaseRoles(env: Environment = process.env): Promise<void> {
  for (const [name, role] of Object.entries(LANES) as [keyof typeof LANES, string][]) {
    const client = new Client({
      connectionString: requireDatabaseUrl(name, env),
      options: '',
      connectionTimeoutMillis: 10_000,
    });
    try {
      await client.connect();
    } catch (e) {
      // pg's message names the role and the reason ("password authentication failed for
      // user ..."), never the password. Wrapped only to say which lane it was.
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`${name}: could not connect to check its role: ${reason}`, { cause: e });
    }
    try {
      await assertUnprivilegedRole(
        {
          $queryRaw: async <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> =>
            (await client.query(strings.reduce((sql, part, i) => `${sql}$${i}${part}`), values)).rows as T,
        },
        name,
      );
      const connectedAs: unknown = (await client.query('SELECT current_user')).rows[0]?.current_user;
      if (connectedAs !== role) {
        throw new Error(
          `${name} connects as '${String(connectedAs)}', but that lane must connect as '${role}'. ` +
            `The two lanes' URLs are swapped or one is reused for both — see ADR-0009.`,
        );
      }
    } finally {
      // A failed disconnect must never replace the verdict: a `finally` that throws
      // discards the refusal it was cleaning up after. Reported, not swallowed.
      await client.end().catch((endError: unknown) => {
        console.error(`${name}: closing the role-check connection failed`, endError);
      });
    }
  }
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
 * carry the same authority (`appClient` is makrai_app, bound by org_isolation on
 * every tenant table; `identityBaseClient` and `preauthClient` are makrai_identity,
 * which reads users and every organisation, membership and invitation — ADR-0009).
 * Held by a generated check in
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
 * `identityDb.user.findMany`, `preauthClient.membership.findMany`, ...) is
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
