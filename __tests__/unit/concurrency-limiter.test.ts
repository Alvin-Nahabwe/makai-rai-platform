import { describe, expect, it } from 'vitest';
import { createLimiter } from '@/lib/concurrency/limiter';

/**
 * Task 16 fix (path to outputs; design §5, the workshop): the working report's draft read and render run behind a limiter, so a burst
 * of downloads never holds more than a few database connections or render threads, and a request waiting for its turn holds nothing:
 * its work has not started. Deterministic: every task is a promise the case settles by hand, no timer decides anything.
 */

type Deferred = { promise: Promise<string>; resolve: (v: string) => void; reject: (e: Error) => void };
function deferred(): Deferred {
  let resolve!: (v: string) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
/** Lets every queued promise callback run, so a permit handed over is seen before the next assertion. */
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('createLimiter', () => {
  it('runs at most `size` tasks at once; a waiting task has not been started', async () => {
    const limiter = createLimiter(2);
    const tasks = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = tasks.map((t, i) => limiter.run(() => { started.push(i); return t.promise; }));
    await settle();
    expect(started).toEqual([0, 1]);
    expect({ active: limiter.active, waiting: limiter.waiting }).toEqual({ active: 2, waiting: 1 });

    tasks[1].resolve('b');
    await settle();
    expect(started).toEqual([0, 1, 2]);
    expect({ active: limiter.active, waiting: limiter.waiting }).toEqual({ active: 2, waiting: 0 });

    tasks[0].resolve('a');
    tasks[2].resolve('c');
    expect(await Promise.all(runs)).toEqual(['a', 'b', 'c']);
    expect({ active: limiter.active, waiting: limiter.waiting }).toEqual({ active: 0, waiting: 0 });
  });

  it('hands freed permits to waiting tasks in arrival order', async () => {
    const limiter = createLimiter(1);
    const first = deferred();
    const order: string[] = [];
    const runs = [limiter.run(() => first.promise)];
    for (const name of ['w1', 'w2', 'w3']) runs.push(limiter.run(async () => { order.push(name); return name; }));
    await settle();
    expect(order).toEqual([]);
    first.resolve('first');
    await Promise.all(runs);
    expect(order).toEqual(['w1', 'w2', 'w3']);
  });

  it('frees the permit when a task rejects or throws, and passes the failure to its caller', async () => {
    const limiter = createLimiter(1);
    const failing = deferred();
    const a = limiter.run(() => failing.promise);
    const b = limiter.run(() => { throw new Error('thrown before any await'); });
    const c = limiter.run(async () => 'ran');
    failing.reject(new Error('rejected'));
    await expect(a).rejects.toThrow('rejected');
    await expect(b).rejects.toThrow('thrown before any await');
    await expect(c).resolves.toBe('ran');
    expect({ active: limiter.active, waiting: limiter.waiting }).toEqual({ active: 0, waiting: 0 });
  });

  it('refuses a size that is not a positive whole number', () => {
    for (const size of [0, -1, 1.5, Number.NaN]) expect(() => createLimiter(size), String(size)).toThrow(/size/);
  });
});
