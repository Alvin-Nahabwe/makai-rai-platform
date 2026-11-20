import { describe, expect, it } from 'vitest';
import { createLimiter, LimiterRefusedError, RequestAbortedError, type LimiterTimers } from '@/lib/concurrency/limiter';

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

/**
 * Task 16 fix, round 2 (controller's ruling on review M1, the reviewer's values): a download waits at most 25 s for a permit, at most
 * 40 wait at once, and one whose client has gone is dropped. Every timer here is the case's own (`fakeTimers`), fired by hand.
 */
type FakeTimer = { id: number; fn: () => void; ms: number };
function fakeTimers(): LimiterTimers & { pending: Map<number, FakeTimer>; made: FakeTimer[]; fire(t: FakeTimer): void } {
  const pending = new Map<number, FakeTimer>();
  const made: FakeTimer[] = [];
  let n = 0;
  return {
    pending, made,
    setTimeout(fn, ms) { const t = { id: ++n, fn, ms }; pending.set(t.id, t); made.push(t); return t.id; },
    clearTimeout(id) { pending.delete(id as number); },
    fire(t) { pending.delete(t.id); t.fn(); },
  };
}

describe('createLimiter: wait limit, queue cap and gone clients', () => {
  it('accepts the 40th waiting task and refuses the 41st at once, starting no timer for it', async () => {
    const timers = fakeTimers();
    const limiter = createLimiter(1, { maxWaiting: 40, maxWaitMs: 25_000, timers });
    const hold = deferred();
    const running = limiter.run(() => hold.promise);
    const waiting = Array.from({ length: 40 }, (_, i) => limiter.run(async () => `w${i}`));
    expect({ waiting: limiter.waiting, timers: timers.made.length }).toEqual({ waiting: 40, timers: 40 });
    const started: string[] = [];
    const refused = limiter.run(async () => { started.push('41st'); return 'x'; });
    await expect(refused).rejects.toBeInstanceOf(LimiterRefusedError);
    await expect(refused).rejects.toMatchObject({ reason: 'full' });
    expect({ waiting: limiter.waiting, timers: timers.made.length, started }).toEqual({ waiting: 40, timers: 40, started: [] });
    hold.resolve('h');
    await running;
    await Promise.all(waiting);
    expect({ active: limiter.active, waiting: limiter.waiting, timersLeft: timers.pending.size }).toEqual({ active: 0, waiting: 0, timersLeft: 0 });
  });

  it('refuses a task still waiting after maxWaitMs, never starts it, and the permit it never got is not handed to it later', async () => {
    const timers = fakeTimers();
    const limiter = createLimiter(1, { maxWaiting: 40, maxWaitMs: 25_000, timers });
    const hold = deferred();
    const running = limiter.run(() => hold.promise);
    let started = false;
    const late = limiter.run(async () => { started = true; return 'late'; });
    expect(timers.made.map((t) => t.ms)).toEqual([25_000]);
    timers.fire(timers.made[0]);
    await expect(late).rejects.toMatchObject({ reason: 'timed_out' });
    expect(limiter.waiting).toBe(0);
    hold.resolve('h');
    await running;
    await settle();
    expect({ started, active: limiter.active, waiting: limiter.waiting }).toEqual({ started: false, active: 0, waiting: 0 });
    await expect(limiter.run(async () => 'next')).resolves.toBe('next');
  });

  it('a waiting task that gets its permit clears its timer and its abort listener: a later abort or timer changes nothing', async () => {
    const timers = fakeTimers();
    const limiter = createLimiter(1, { maxWaiting: 40, maxWaitMs: 25_000, timers });
    const hold = deferred();
    const running = limiter.run(() => hold.promise);
    const gone = new AbortController();
    const second = deferred();
    const granted = limiter.run(() => second.promise, { signal: gone.signal });
    hold.resolve('h');
    await running;
    await settle();
    expect(timers.pending.size).toBe(0);
    gone.abort();
    timers.made[0].fn(); // the same tick as the grant: a timer that fires anyway settles nothing twice
    second.resolve('ran');
    await expect(granted).resolves.toBe('ran');
    expect({ active: limiter.active, waiting: limiter.waiting }).toEqual({ active: 0, waiting: 0 });
  });

  it('drops a waiting task whose client has gone: it is never started, and leaves the queue at once', async () => {
    const timers = fakeTimers();
    const limiter = createLimiter(1, { maxWaiting: 40, maxWaitMs: 25_000, timers });
    const hold = deferred();
    const running = limiter.run(() => hold.promise);
    const gone = new AbortController();
    let started = false;
    const dropped = limiter.run(async () => { started = true; return 'x'; }, { signal: gone.signal });
    const after = limiter.run(async () => 'after');
    gone.abort();
    await expect(dropped).rejects.toBeInstanceOf(RequestAbortedError);
    expect({ waiting: limiter.waiting, timers: timers.pending.size }).toEqual({ waiting: 1, timers: 1 });
    hold.resolve('h');
    await running;
    await expect(after).resolves.toBe('after');
    expect({ started, active: limiter.active, waiting: limiter.waiting }).toEqual({ started: false, active: 0, waiting: 0 });
  });

  it('a client gone just after its task was granted the permit: the task never starts, the permit passes on, the counts return to zero', async () => {
    const timers = fakeTimers();
    const limiter = createLimiter(1, { maxWaiting: 40, maxWaitMs: 25_000, timers });
    const hold = deferred();
    const running = limiter.run(() => hold.promise);
    const gone = new AbortController();
    let started = false;
    const granted = limiter.run(async () => { started = true; return 'x'; }, { signal: gone.signal });
    const third = deferred();
    const after = limiter.run(() => third.promise);
    // Registered after `running`'s own reaction, so it runs once the permit has been handed to `granted` (it has left the queue,
    // its timer and abort listener are gone) and before `granted`'s task can start.
    let waitingAtAbort = -1;
    void hold.promise.then(() => { waitingAtAbort = limiter.waiting; gone.abort(); });
    hold.resolve('h');
    await running;
    await expect(granted).rejects.toBeInstanceOf(RequestAbortedError);
    expect(waitingAtAbort).toBe(1); // only `after` still waited: the abort landed after the grant, not in the queue
    await settle();
    expect({ started, active: limiter.active, waiting: limiter.waiting }).toEqual({ started: false, active: 1, waiting: 0 });
    third.resolve('third');
    await expect(after).resolves.toBe('third');
    expect({ active: limiter.active, waiting: limiter.waiting, timersLeft: timers.pending.size }).toEqual({ active: 0, waiting: 0, timersLeft: 0 });
  });

  it('a task whose client has already gone never runs, even with a permit free', async () => {
    const limiter = createLimiter(1, { maxWaiting: 40, maxWaitMs: 25_000, timers: fakeTimers() });
    const gone = new AbortController();
    gone.abort();
    let started = false;
    await expect(limiter.run(async () => { started = true; return 'x'; }, { signal: gone.signal })).rejects.toBeInstanceOf(RequestAbortedError);
    expect({ started, active: limiter.active, waiting: limiter.waiting }).toEqual({ started: false, active: 0, waiting: 0 });
  });

  it('refuses a queue cap or a wait limit that is not a whole number of at least 0 and 1', () => {
    for (const maxWaiting of [-1, 1.5, Number.NaN]) expect(() => createLimiter(1, { maxWaiting }), String(maxWaiting)).toThrow(/maxWaiting/);
    for (const maxWaitMs of [0, -5, Number.NaN]) expect(() => createLimiter(1, { maxWaitMs }), String(maxWaitMs)).toThrow(/maxWaitMs/);
  });
});
