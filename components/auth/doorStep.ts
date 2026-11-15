import { useSyncExternalStore } from 'react';

/**
 * Which step of a door page the person is on, when that step changes in the browser and the page's server parts must
 * follow it (plan 1B fix round 2, rulings L5-27 and I-6): the route in the gate frame's column and the card's heading are
 * rendered outside the client form that knows the step. One store per page; the server and the first render see
 * `initial`, so the page's HTML never depends on the browser.
 */
export type DoorStep<T extends string> = {
  readonly initial: T;
  get: () => T;
  set: (next: T) => void;
  subscribe: (onChange: () => void) => () => void;
};

export function createDoorStep<T extends string>(initial: T): DoorStep<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    initial,
    get: () => value,
    set(next) {
      if (next === value) return;
      value = next;
      for (const l of listeners) l();
    },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => { listeners.delete(onChange); };
    },
  };
}

/** The step now, for a component outside the form that sets it. */
export function useDoorStep<T extends string>(store: DoorStep<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, () => store.initial);
}
