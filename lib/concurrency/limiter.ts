/**
 * A first-come, first-served limit on how many tasks run at once (Task 16 fix; design §5, the workshop). A task beyond the limit
 * waits before it starts, so whatever it would hold (a database connection, a render thread) it does not hold while it waits. The
 * permit is given back however the task ends.
 */
export interface Limiter {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks running now. */
  readonly active: number;
  /** Tasks waiting for a permit. */
  readonly waiting: number;
}

export function createLimiter(size: number): Limiter {
  if (!Number.isInteger(size) || size < 1) throw new Error(`createLimiter: size must be a positive whole number, not ${size}`);
  let active = 0;
  const queue: Array<() => void> = [];

  const release = (): void => {
    const next = queue.shift();
    if (next) next(); // the permit passes straight to the next task: `active` stays the same
    else active -= 1;
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active < size) active += 1;
      else await new Promise<void>((grant) => queue.push(grant));
      try {
        return await task();
      } finally {
        release();
      }
    },
    get active() { return active; },
    get waiting() { return queue.length; },
  };
}
