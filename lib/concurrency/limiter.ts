/**
 * A first-come, first-served limit on how many tasks run at once (Task 16 fix; design §5, the workshop). A task beyond the limit
 * waits before it starts, so whatever it would hold (a database connection, a render thread) it does not hold while it waits. The
 * permit is given back however the task ends.
 *
 * The wait is bounded (Task 16 fix, round 2; the controller's ruling on review M1): at most `maxWaiting` tasks wait, and the next is
 * refused at once; a task still waiting after `maxWaitMs` is refused; a task whose `signal` aborts (its client has gone) leaves the
 * queue at once and never starts. A refused or dropped task was never started, so it held nothing and gives nothing back.
 */
export interface Limiter {
  run<T>(task: () => Promise<T>, o?: { signal?: AbortSignal }): Promise<T>;
  /** Tasks running now. */
  readonly active: number;
  /** Tasks waiting for a permit. */
  readonly waiting: number;
}

/** The two timer calls the limiter makes; the tests hand in their own, so no case depends on the clock. */
export interface LimiterTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** A task the limiter would not start: the queue was full, or its wait ran out. */
export class LimiterRefusedError extends Error {
  constructor(readonly reason: 'full' | 'timed_out') {
    super(reason === 'full' ? 'limiter: the queue is full' : 'limiter: the wait for a permit ran out');
    this.name = 'LimiterRefusedError';
  }
}

/** A task dropped because its request was aborted (its client has gone) before it started. */
export class RequestAbortedError extends Error {
  constructor() {
    super('limiter: the request was aborted before its task started');
    this.name = 'RequestAbortedError';
  }
}

const REAL_TIMERS: LimiterTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

type Waiter = { grant: () => void; refuse: (e: Error) => void };

export function createLimiter(
  size: number,
  o: { maxWaiting?: number; maxWaitMs?: number; timers?: LimiterTimers } = {},
): Limiter {
  if (!Number.isInteger(size) || size < 1) throw new Error(`createLimiter: size must be a positive whole number, not ${size}`);
  const maxWaiting = o.maxWaiting ?? Number.POSITIVE_INFINITY;
  const maxWaitMs = o.maxWaitMs ?? null;
  if (maxWaiting !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxWaiting) || maxWaiting < 0)) {
    throw new Error(`createLimiter: maxWaiting must be a whole number of at least 0, not ${maxWaiting}`);
  }
  if (maxWaitMs !== null && !(Number.isFinite(maxWaitMs) && maxWaitMs >= 1)) {
    throw new Error(`createLimiter: maxWaitMs must be a number of at least 1, not ${maxWaitMs}`);
  }
  const timers = o.timers ?? REAL_TIMERS;
  let active = 0;
  const queue: Waiter[] = [];

  const release = (): void => {
    const next = queue.shift();
    if (next) next.grant(); // the permit passes straight to the next task: `active` stays the same
    else active -= 1;
  };

  /** Waits in the queue until a permit is handed over, or refuses: full, timed out, or aborted. Settles once. */
  function waitForPermit(signal: AbortSignal | undefined): Promise<void> {
    if (queue.length >= maxWaiting) return Promise.reject(new LimiterRefusedError('full'));
    return new Promise<void>((resolve, reject) => {
      let timer: unknown = null;
      const leave = (): void => {
        const at = queue.indexOf(waiter);
        if (at !== -1) queue.splice(at, 1);
        if (timer !== null) timers.clearTimeout(timer);
        timer = null;
        signal?.removeEventListener('abort', onAbort);
      };
      const waiter: Waiter = {
        grant: () => { leave(); resolve(); },
        refuse: (e) => { leave(); reject(e); },
      };
      // Only a waiter still in the queue can be refused: one already granted holds a permit its task must give back.
      const refuseIfWaiting = (e: Error): void => { if (queue.includes(waiter)) waiter.refuse(e); };
      const onAbort = (): void => refuseIfWaiting(new RequestAbortedError());
      queue.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (maxWaitMs !== null) timer = timers.setTimeout(() => refuseIfWaiting(new LimiterRefusedError('timed_out')), maxWaitMs);
    });
  }

  return {
    async run<T>(task: () => Promise<T>, ro: { signal?: AbortSignal } = {}): Promise<T> {
      if (ro.signal?.aborted) throw new RequestAbortedError();
      if (active < size) active += 1;
      else await waitForPermit(ro.signal);
      try {
        // Aborted between the grant and here: the permit goes straight back, the task never starts.
        if (ro.signal?.aborted) throw new RequestAbortedError();
        return await task();
      } finally {
        release();
      }
    },
    get active() { return active; },
    get waiting() { return queue.length; },
  };
}
