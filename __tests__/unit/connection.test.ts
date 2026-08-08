import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Fix round 2 (task-6-report.md). `hmrSingleton` used to call `create()`
 * EAGERLY, the instant it was invoked -- and every one of its four callers
 * (`lib/data/tenant.ts#appClient`, `lib/data/identity.ts#base`/`identityDb`,
 * `lib/data/preauth.ts#ownerClient`) invokes it at MODULE TOP LEVEL
 * (`export const appClient = hmrSingleton(...)`), which runs the instant
 * the module is imported. `next build`'s page-data collection imports
 * every route module, so `create` (which calls `requireDatabaseUrl` and
 * constructs a real `pg.Pool`) ran during the build -- exactly the shape
 * already fixed for `lib/auth.ts#requireAuthSecret` via NextAuth's lazy
 * config pattern, generalised here (D-156).
 *
 * Each test uses its OWN unique globalThis key so tests cannot pollute one
 * another's cached singleton.
 */

let keyCounter = 0;
function freshKey(): string {
  keyCounter += 1;
  return `test-singleton-${keyCounter}`;
}

describe('hmrSingleton laziness', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
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

  it('calls create() exactly once across multiple property accesses (singleton, not re-constructed per access)', async () => {
    const { hmrSingleton } = await import('../../lib/data/connection');
    const create = vi.fn(() => ({ a: 1, b: 2, c: 3 }));

    const instance = hmrSingleton(freshKey(), create);
    void instance.a;
    void instance.b;
    void instance.c;

    expect(create).toHaveBeenCalledTimes(1);
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
