import { useSyncExternalStore } from 'react';

const noopSubscribe = (): (() => void) => () => {};

/**
 * False in the server render and until React has hydrated, true after (and at once on a client-side mount). A submit
 * button disabled by it does nothing before hydration, so a native submit cannot put a field in a URL.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}
