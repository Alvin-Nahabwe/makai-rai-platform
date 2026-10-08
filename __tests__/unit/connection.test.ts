import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Fix round 2 (task-6-report.md). `hmrSingleton` used to call `create()`
 * EAGERLY, the instant it was invoked -- and every one of its four callers
 * (`lib/data/tenant.ts#appClient`, `lib/data/identity.ts#base`/`identityDb`,
 * `lib/data/preauth.ts#preauthClient`) invokes it at MODULE TOP LEVEL
 * (`export const appClient = hmrSingleton(...)`), which runs the instant
 * the module is imported. `next build`'s page-data collection imports
 * every route module, so `create` (which calls `requireDatabaseUrl` and
 * constructs a real `pg.Pool`) ran during the build -- exactly the shape
 * already fixed for `lib/auth.ts#requireAuthSecret` via NextAuth's lazy
 * config pattern, generalised here (D-156).
 *
 * Each test uses its OWN unique globalThis key so tests cannot pollute one
 * another's cached singleton.
 *
 * ---
 *
 * FIX ROUND 4 (task-6-report.md, D-157): this file used to `vi.stubEnv(
 * 'NODE_ENV', 'test')` unconditionally in a single file-wide `beforeEach`,
 * so EVERY test below ran in exactly one environment -- and it was not the
 * one that ships. `docker/Dockerfile`'s runner stage sets
 * `ENV NODE_ENV=production`, and `hmrSingleton`'s memo was written only
 * when `NODE_ENV !== 'production'`. The test titled "calls create()
 * exactly once across multiple property accesses" therefore passed while
 * production re-ran `create()` -- a fresh `PrismaClient` and `pg.Pool`,
 * never closed -- on EVERY property access, i.e. every tenant request.
 *
 * The mechanism, not the patch: the environment is now a GENERATED
 * dimension (`describe.each(NODE_ENVS)`) rather than a hardcoded constant,
 * so every invariant below is asserted in every environment the code can
 * observe, including `undefined` (a bare `node server.js`, or `next build`
 * before the runner stage sets it). Adding an environment-sensitive branch
 * to `lib/data/connection.ts` cannot again leave the deployed branch
 * untested by construction -- AGENTS.md §3, "where a list must be
 * complete, generate it rather than writing it".
 */

/**
 * Every value `process.env.NODE_ENV` can hold in this system:
 * - 'production'  -- `docker/Dockerfile:26`, the deployed container
 * - 'development' -- `next dev`, where hot-reload re-evaluates modules
 * - 'test'        -- `vitest.config.ts`'s `env` block
 * - undefined     -- a bare `node`/`tsx` process; `next build` inherits
 *                    whatever the shell has, which may be nothing
 */
const NODE_ENVS = ['production', 'development', 'test', undefined] as const;

let keyCounter = 0;
function freshKey(): string {
  keyCounter += 1;
  return `test-singleton-${keyCounter}`;
}

describe.each(NODE_ENVS)('hmrSingleton laziness (NODE_ENV=%s)', (nodeEnv) => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', nodeEnv as string);
  });

  // Restore the real value rather than leaving the last stub standing:
  // `vitest.config.ts` sets `fileParallelism: false`, so test FILES share a
  // worker process and therefore share `process.env`. Without this, a
  // leftover 'production' stub would silently follow this file into the
  // next one.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does NOT call create() at the point hmrSingleton() itself is invoked', async () => {
    const { hmrSingleton } = await import('../../lib/data/connection');
    const create = vi.fn(() => ({ value: 'real' }));

    hmrSingleton(freshKey(), create);

    expect(create).not.toHaveBeenCalled();
  });

  it('calls create() on the FIRST property access, not before', async () => {
    const { hmrSingleton } = await import('../../lib/data/connection');
    const create = vi.fn(() => ({ value: 'real' }));

    const instance = hmrSingleton(freshKey(), create);
    expect(create).not.toHaveBeenCalled();

    // First real touch.
    expect(instance.value).toBe('real');
    expect(create).toHaveBeenCalledTimes(1);
  });

  /**
   * THE fix-round-4 regression test. This assertion is unchanged from fix
   * round 2 -- what changed is that it now runs under NODE_ENV=production,
   * where it was red: `getOrCreate()` cached into `globalThis` only when
   * `NODE_ENV !== 'production'`, so with the lazy Proxy (which calls
   * `getOrCreate()` from every trap) production re-constructed on every
   * access. `lib/data/tenant.ts#withOrg`'s `appClient.$transaction(...)` is
   * one such access per request, so the deployed container built a new
   * `PrismaClient` + `pg.Pool` (max 10, never `.end()`ed) per tenant
   * request until Postgres ran out of `max_connections`.
   */
  it('calls create() exactly once across multiple property accesses (singleton, not re-constructed per access)', async () => {
    const { hmrSingleton } = await import('../../lib/data/connection');
    const create = vi.fn(() => ({ a: 1, b: 2, c: 3 }));

    const instance = hmrSingleton(freshKey(), create);
    void instance.a;
    void instance.b;
    void instance.c;

    expect(create).toHaveBeenCalledTimes(1);
  });

  /**
   * The same invariant under a DIFFERENT lens, deliberately: the test above
   * asserts on the spy (how often the factory ran), this one asserts on
   * what the CALLER actually receives. A serial counter makes
   * re-construction directly observable in the returned value, so this
   * would still fail if `create` were ever memoised in a way that fooled
   * the spy but still handed back a fresh object -- which is the property
   * that matters, since a fresh object means a fresh unclosed `pg.Pool`.
   */
  it('hands the caller the SAME instance on every access, not a freshly constructed one', async () => {
    const { hmrSingleton } = await import('../../lib/data/connection');
    let serial = 0;
    const create = vi.fn(() => ({ serial: (serial += 1) }));

    const instance = hmrSingleton(freshKey(), create);

    expect(instance.serial).toBe(1);
    expect(instance.serial).toBe(1); // 2 if re-constructed per access
    expect(instance.serial).toBe(1);
    expect(serial).toBe(1);
  });

  it('a throwing create() propagates the throw on first property access -- fails closed, not silently', async () => {
    const { hmrSingleton } = await import('../../lib/data/connection');
    const create = vi.fn(() => {
      throw new Error('DATABASE_URL is not set.');
    });

    const instance = hmrSingleton(freshKey(), create) as { anything: unknown };

    // The guard must still fire -- a lazy guard that never fires is worse
    // than an eager one that fires too early (the coordinator's own words).
    expect(() => instance.anything).toThrow('DATABASE_URL is not set.');
  });

  it('a throwing create() throws again on the NEXT access too -- does not cache a broken state as success', async () => {
    const { hmrSingleton } = await import('../../lib/data/connection');
    const create = vi.fn(() => {
      throw new Error('boom');
    });
    const instance = hmrSingleton(freshKey(), create) as { x: unknown; y: unknown };

    expect(() => instance.x).toThrow('boom');
    expect(() => instance.y).toThrow('boom');
  });

  /**
   * The memo added in fix round 4 must be written ONLY on success. A memo
   * populated before or despite a throw would cache a half-constructed
   * client and permanently skip `requireDatabaseUrl` -- the D-086 /
   * ADR-0001 fail-open (pg falls back to PG* and can land on the schema
   * owner, bypassing RLS) that check exists to prevent. Two throws then a
   * success proves the memo neither poisons nor swallows.
   */
  it('recovers on a later access once create() stops throwing -- the memo is written on success only', async () => {
    const { hmrSingleton } = await import('../../lib/data/connection');
    let attempts = 0;
    const create = vi.fn(() => {
      attempts += 1;
      if (attempts < 3) throw new Error('APP_DATABASE_URL is not set.');
      return { ready: true };
    });

    const instance = hmrSingleton(freshKey(), create) as { ready: boolean };

    expect(() => instance.ready).toThrow('APP_DATABASE_URL is not set.');
    expect(() => instance.ready).toThrow('APP_DATABASE_URL is not set.');
    expect(instance.ready).toBe(true);
    expect(create).toHaveBeenCalledTimes(3);

    // And having succeeded, it is now a singleton like any other.
    void instance.ready;
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('method calls are correctly bound to the real instance (this is preserved through the proxy)', async () => {
    const { hmrSingleton } = await import('../../lib/data/connection');
    const create = vi.fn(() => ({
      internal: 42,
      readInternal() {
        // Relies on `this` being the REAL instance, exactly like a Prisma
        // Client method reading its own internal connection state would.
        return this.internal;
      },
    }));

    const instance = hmrSingleton(freshKey(), create);
    expect(instance.readInternal()).toBe(42);
  });

  it('preserves the singleton-across-hmrSingleton-calls behaviour: the SAME cached instance is returned for the same key, even from a second hmrSingleton() call', async () => {
    const { hmrSingleton } = await import('../../lib/data/connection');
    const key = freshKey();
    const create1 = vi.fn(() => ({ id: 'first' }));
    const create2 = vi.fn(() => ({ id: 'second' }));

    const first = hmrSingleton(key, create1);
    void first.id; // force construction + cache

    const second = hmrSingleton(key, create2);
    expect(second.id).toBe('first'); // reused the cached instance, not create2's
    expect(create2).not.toHaveBeenCalled();
  });

  /**
   * Found by the FULL suite run, not by this file alone:
   * __tests__/integration/data-boundary.test.ts's "exposes exactly the
   * constructed surface" test (a security-critical pin on `identityDb`,
   * documented five-attempt bypass history) failed against the first
   * version of this fix -- `Object.keys()`/`Object.getOwnPropertySymbols()`
   * go through the `ownKeys`/`getOwnPropertyDescriptor` traps, not `get`,
   * and a Proxy with no `ownKeys` trap enumerates its TARGET (the
   * throwaway `{}`), not the real lazily-constructed instance.
   */
  it('Object.keys() on the returned proxy reflects the REAL instance, not the empty proxy target', async () => {
    const { hmrSingleton } = await import('../../lib/data/connection');
    const create = vi.fn(() => Object.freeze({ a: 1, b: 2, c: 3 }));

    const instance = hmrSingleton(freshKey(), create);
    expect(Object.keys(instance).sort()).toEqual(['a', 'b', 'c']);
  });

  it('Object.getOwnPropertySymbols() on the returned proxy reflects the real instance (empty, matching identityDb\'s own "nothing to escape through" pin)', async () => {
    const { hmrSingleton } = await import('../../lib/data/connection');
    const create = vi.fn(() => Object.freeze({ a: 1 }));

    const instance = hmrSingleton(freshKey(), create);
    expect(Object.getOwnPropertySymbols(instance)).toEqual([]);
  });

  it('a symbol key on the real instance IS reported by Object.getOwnPropertySymbols (the enumeration is faithful in both directions, not hardcoded empty)', async () => {
    const { hmrSingleton } = await import('../../lib/data/connection');
    const sym = Symbol('marker');
    const create = vi.fn(() => ({ [sym]: 'present' }));

    const instance = hmrSingleton(freshKey(), create) as unknown as Record<symbol, string>;
    expect(Object.getOwnPropertySymbols(instance)).toEqual([sym]);
    expect(instance[sym]).toBe('present');
  });

  it('does not throw a Proxy invariant violation when the real instance is Object.freeze()d (every current caller freezes or effectively freezes its client)', async () => {
    const { hmrSingleton } = await import('../../lib/data/connection');
    const create = vi.fn(() => Object.freeze({ frozen: true }));

    const instance = hmrSingleton(freshKey(), create);
    expect(() => Object.keys(instance)).not.toThrow();
    expect(Object.keys(instance)).toEqual(['frozen']);
  });

  it('rejects mutation, matching the frozen real instance every current caller constructs -- a lazy wrapper must not accidentally make a frozen object mutable', async () => {
    const { hmrSingleton } = await import('../../lib/data/connection');
    const create = vi.fn(() => Object.freeze({ existing: 'value' }));

    const instance = hmrSingleton(freshKey(), create) as unknown as Record<string, unknown>;
    expect(() => {
      instance.newProp = 'should not stick';
    }).toThrow();
    // And the mutation must not silently land on some other object either.
    expect(instance.newProp).toBeUndefined();
  });
});

/**
 * The `NODE_ENV !== 'production'` condition in `hmrSingleton` is NOT
 * incidental and must not be deleted by whoever next finds it in their way.
 * Its purpose is `globalThis` hygiene: the global write exists ONLY to let a
 * client survive Next.js dev hot-reload re-evaluating the module, and
 * production never re-evaluates modules. Writing there in production would
 * publish an ambient, import-free handle to a live database client on the
 * tenant-isolation spine -- reachable by any code in the process without
 * going through `lib/data/tenant.ts#withOrg`, which that module's own header
 * calls "the ONLY path to tenant data".
 *
 * Fix round 4 restored the missing production memo WITHOUT touching that
 * condition (the memo moved to module scope inside `lib/data/connection.ts`,
 * which is the same storage tier the pre-Proxy code used -- the
 * `export const appClient = hmrSingleton(...)` binding at each call site).
 * These tests pin both halves so the two concerns cannot be confused again.
 */
describe('hmrSingleton globalThis hygiene (the reason the production branch exists)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does NOT publish the client on globalThis in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { hmrSingleton } = await import('../../lib/data/connection');
    const key = freshKey();

    const instance = hmrSingleton(key, () => ({ value: 'real' }));
    expect(instance.value).toBe('real'); // force construction

    expect(Object.hasOwn(globalThis, key)).toBe(false);
  });

  /**
   * Found by `pr-review-toolkit:silent-failure-hunter` on this round's own
   * change, and it is the finding this block previously got only half right.
   * The `globalThis` WRITE was gated on `NODE_ENV`; the READ was not. So in
   * production the only way `globalThis['appClient']` can ever be populated
   * is by something that is not this function -- an injected global, a
   * name collision, a stray assignment -- which is precisely the case that
   * must NOT be trusted. `create()` would then never run, and with it
   * `requireDatabaseUrl()` would never run: the D-086 / ADR-0001 guard
   * against `pg` falling back to `PG*` and landing on the schema owner
   * stops firing entirely, silently.
   *
   * That asymmetry pre-dates fix round 4. What fix round 4 briefly added
   * was PERMANENCE: promoting the globalThis value into the module memo
   * latched it for the life of the process, where before, deleting the
   * stray global let the next access recover. Verified in a real node
   * process against both revisions before the fix below was written.
   *
   * The fix is to gate the read on the SAME condition as the write, via one
   * shared flag, so the two can no longer drift apart by editing one line.
   */
  it('IGNORES a pre-existing globalThis entry in production -- the write is dev-only, so anything found there was not put there by this function', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { hmrSingleton } = await import('../../lib/data/connection');
    const key = freshKey();
    const store = globalThis as unknown as Record<string, unknown>;

    try {
      store[key] = { id: 'INJECTED' };

      const create = vi.fn(() => ({ id: 'REAL' }));
      const instance = hmrSingleton(key, create) as { id: string };

      expect(instance.id).toBe('REAL');
      expect(create).toHaveBeenCalledTimes(1);

      // And it must not have latched the injected value either.
      delete store[key];
      expect(instance.id).toBe('REAL');
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      delete store[key];
    }
  });

  it('HONOURS a pre-existing globalThis entry outside production -- that is exactly what the hot-reload bridge is for', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { hmrSingleton } = await import('../../lib/data/connection');
    const key = freshKey();
    const store = globalThis as unknown as Record<string, unknown>;

    try {
      store[key] = { id: 'FROM_PREVIOUS_RELOAD' };

      const create = vi.fn(() => ({ id: 'REBUILT' }));
      const instance = hmrSingleton(key, create) as { id: string };

      expect(instance.id).toBe('FROM_PREVIOUS_RELOAD');
      expect(create).not.toHaveBeenCalled();
    } finally {
      delete store[key];
    }
  });

  it('DOES publish the client on globalThis outside production, so dev hot-reload can find it', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { hmrSingleton } = await import('../../lib/data/connection');
    const key = freshKey();

    const instance = hmrSingleton(key, () => ({ value: 'real' }));
    expect(instance.value).toBe('real'); // force construction

    expect(Object.hasOwn(globalThis, key)).toBe(true);
    expect((globalThis as unknown as Record<string, { value: string }>)[key].value).toBe('real');
  });

  /**
   * The hot-reload scenario itself, simulated rather than described:
   * `vi.resetModules()` + a fresh dynamic import gives `connection.ts` a
   * brand-new module scope -- exactly what Next.js dev does on save, and
   * exactly what empties any module-scoped memo. Only the `globalThis`
   * entry can bridge that, so this test is what makes the global write
   * non-vacuous: delete the write and this goes red while every test in
   * the matrix above stays green.
   */
  it('recovers the SAME client across a simulated hot-reload (fresh module scope, dev)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const key = freshKey();

    const before = await import('../../lib/data/connection');
    const first = before.hmrSingleton(key, () => ({ id: 'original' }));
    expect(first.id).toBe('original'); // force construction + global write

    vi.resetModules();
    const after = await import('../../lib/data/connection');
    expect(after.hmrSingleton).not.toBe(before.hmrSingleton); // genuinely re-evaluated

    const create2 = vi.fn(() => ({ id: 'rebuilt' }));
    const second = after.hmrSingleton(key, create2);

    expect(second.id).toBe('original');
    expect(create2).not.toHaveBeenCalled();
  });

  /**
   * The converse, pinned deliberately rather than left as an unstated
   * assumption: in production a fresh module scope gets its OWN client,
   * because there is no global to recover from. This is UNCHANGED
   * pre-existing behaviour -- before the lazy Proxy, the production memo
   * was the `export const` binding in each caller module, which is equally
   * per-module-instance -- and it is the price of the hygiene above. It
   * only bites if the bundler ever emits two copies of
   * `lib/data/connection.ts` into one process; see D-158.
   */
  it('in production a fresh module scope constructs its own client (no global to recover from) -- D-158', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const key = freshKey();

    const before = await import('../../lib/data/connection');
    const first = before.hmrSingleton(key, () => ({ id: 'original' }));
    expect(first.id).toBe('original');

    vi.resetModules();
    const after = await import('../../lib/data/connection');

    const create2 = vi.fn(() => ({ id: 'rebuilt' }));
    const second = after.hmrSingleton(key, create2);

    expect(second.id).toBe('rebuilt');
    expect(create2).toHaveBeenCalledTimes(1);
  });
});

/**
 * ADR-0009. `assertUnprivilegedRole` is the one check that compares a lane's
 * configuration with reality: it asks the LIVE connection who it is. `withOrg` runs it
 * on the app lane (memoised once per process) and `verifyDatabaseRoles` runs it on both
 * lanes from `instrumentation.ts#register`, so a privileged URL stops the server before
 * it serves anything. Stubbed here so each refusal reason is pinned on its own.
 */
describe('assertUnprivilegedRole', () => {
  const stub = (row: Record<string, unknown> | undefined) => ({
    $queryRaw: async <T>(): Promise<T> => (row === undefined ? [] : [row]) as T,
  });

  it('assertUnprivilegedRole refuses a superuser connection', async () => {
    const { assertUnprivilegedRole } = await import('../../lib/data/connection');
    await expect(
      assertUnprivilegedRole(
        stub({ current_user: 'makrai', rolsuper: true, rolbypassrls: true }),
        'IDENTITY_DATABASE_URL',
      ),
    ).rejects.toThrow(/refuses to run.*'makrai'.*IDENTITY_DATABASE_URL/);
  });

  it('names current_user, rolsuper, rolbypassrls and the URL in its refusal', async () => {
    const { assertUnprivilegedRole } = await import('../../lib/data/connection');
    const err = await assertUnprivilegedRole(
      stub({ current_user: 'makrai', rolsuper: false, rolbypassrls: true, privileged_member: false }),
      'APP_DATABASE_URL',
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/'makrai'/);
    expect((err as Error).message).toMatch(/rolsuper=false/);
    expect((err as Error).message).toMatch(/rolbypassrls=true/);
    expect((err as Error).message).toMatch(/APP_DATABASE_URL/);
  });

  it('refuses a role that is a member of a superuser or BYPASSRLS role', async () => {
    // rolsuper and rolbypassrls are not inherited, but a member can SET ROLE to the
    // privileged role, so the credential is privileged all the same.
    const { assertUnprivilegedRole } = await import('../../lib/data/connection');
    await expect(
      assertUnprivilegedRole(
        stub({ current_user: 'makrai_identity', rolsuper: false, rolbypassrls: false, privileged_member: true }),
        'IDENTITY_DATABASE_URL',
      ),
    ).rejects.toThrow(/refuses to run.*'makrai_identity'.*privileged_member=true.*IDENTITY_DATABASE_URL/);
  });

  it('refuses when the role row is missing, or a flag is not a plain false', async () => {
    const { assertUnprivilegedRole } = await import('../../lib/data/connection');
    await expect(assertUnprivilegedRole(stub(undefined), 'IDENTITY_DATABASE_URL')).rejects.toThrow(/'unknown'/);
    await expect(
      assertUnprivilegedRole(stub({ current_user: 'x', rolsuper: false, rolbypassrls: false }), 'IDENTITY_DATABASE_URL'),
    ).rejects.toThrow(/refuses to run/);
  });

  it('refuses a REPLICATION role, which can stream every database it can reach', async () => {
    const { assertUnprivilegedRole } = await import('../../lib/data/connection');
    await expect(
      assertUnprivilegedRole(
        stub({
          current_user: 'makrai_identity', rolsuper: false, rolbypassrls: false,
          rolreplication: true, privileged_member: false,
        }),
        'IDENTITY_DATABASE_URL',
      ),
    ).rejects.toThrow(/refuses to run.*'makrai_identity'.*rolreplication=true.*IDENTITY_DATABASE_URL/);
  });

  it('accepts an unprivileged role', async () => {
    const { assertUnprivilegedRole } = await import('../../lib/data/connection');
    await expect(
      assertUnprivilegedRole(
        stub({
          current_user: 'makrai_identity', rolsuper: false, rolbypassrls: false,
          rolreplication: false, privileged_member: false,
        }),
        'IDENTITY_DATABASE_URL',
      ),
    ).resolves.toBeUndefined();
  });
});

describe('requireDatabaseUrl for the identity lane', () => {
  it('throws, naming IDENTITY_DATABASE_URL, when it is unset', async () => {
    const { requireDatabaseUrl } = await import('../../lib/data/connection');
    expect(() => requireDatabaseUrl('IDENTITY_DATABASE_URL', {})).toThrow(/IDENTITY_DATABASE_URL is not set/);
  });

  it('applies the same partial-URL refusal as the other lanes', async () => {
    const { requireDatabaseUrl } = await import('../../lib/data/connection');
    expect(() =>
      requireDatabaseUrl('IDENTITY_DATABASE_URL', { IDENTITY_DATABASE_URL: 'postgresql://localhost:5432/makrai' }),
    ).toThrow(/IDENTITY_DATABASE_URL must specify user, host and database/);
  });

  it('returns a complete URL from the environment it is given', async () => {
    const { requireDatabaseUrl } = await import('../../lib/data/connection');
    const url = 'postgresql://makrai_identity:pw@db:5432/makrai';
    expect(requireDatabaseUrl('IDENTITY_DATABASE_URL', { IDENTITY_DATABASE_URL: url })).toBe(url);
  });
});
