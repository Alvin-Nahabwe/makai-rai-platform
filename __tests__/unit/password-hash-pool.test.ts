import { join } from 'node:path';
import { compareSync, hashSync } from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPasswordHashPool, passwordHashPoolSize, type PasswordHashPool } from '@/lib/auth/passwordHash';

/**
 * FR-ACC-05 (coordinator ruling, option 1): bcryptjs runs in a pool of worker threads, so a comparison never holds the
 * main thread's event loop and a health read or any other request answers while sign-ins are compared. The hashes are
 * bcryptjs's own, so the stored cost-12 hashes stay valid.
 *
 * The fault cases use a test worker (`__tests__/fixtures/password-hash/faulty-worker.js`) that speaks the same protocol
 * and crashes or never answers on a marked password, so the pool's restart is driven by a real dying thread.
 */
const FAULTY_WORKER = join(process.cwd(), '__tests__', 'fixtures', 'password-hash', 'faulty-worker.js');
const RIGHT = 'correct horse battery';
const STORED = hashSync(RIGHT, 12); // as a sign-up before the pool would have stored it

const pools: PasswordHashPool[] = [];
function pool(...a: Parameters<typeof createPasswordHashPool>): PasswordHashPool {
  const p = createPasswordHashPool(...a);
  pools.push(p);
  return p;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

/** Makes every later `new Worker` throw, as thread creation does under EAGAIN (ERR_WORKER_INIT_FAILED). */
function workersCannotStart(): void {
  const real = process.getBuiltinModule.bind(process);
  vi.spyOn(process, 'getBuiltinModule').mockImplementation(((id: string) =>
    id === 'node:worker_threads'
      ? { Worker: function Worker() { throw new Error('ERR_WORKER_INIT_FAILED EAGAIN'); } }
      : real(id)) as typeof process.getBuiltinModule);
}

/** `p`, or a rejection after `ms`, so a job that is never settled fails the case instead of hanging it. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms))]);
}

/** The longest gap between ticks of a 1 ms interval while `work` runs: how long the event loop was held. */
async function longestStall(work: () => Promise<unknown>): Promise<{ stallMs: number; result: unknown }> {
  let last = performance.now();
  let stallMs = 0;
  const tick = setInterval(() => {
    const t = performance.now();
    stallMs = Math.max(stallMs, t - last);
    last = t;
  }, 1);
  try {
    const result = await work();
    return { stallMs: Math.max(stallMs, performance.now() - last), result };
  } finally {
    clearInterval(tick);
  }
}

describe('password hash pool', () => {
  it('FR-ACC-05: four cost-12 comparisons at once hold the event loop under 50 ms', async () => {
    const p = pool({ size: 2 });
    await Promise.all([p.compare(RIGHT, STORED), p.compare(RIGHT, STORED)]); // both workers started before measuring
    const { stallMs, result } = await longestStall(() =>
      Promise.all([p.compare(RIGHT, STORED), p.compare('wrong', STORED), p.compare(RIGHT, STORED), p.compare('wrong', STORED)]));
    expect(result).toEqual([true, false, true, false]);
    expect(stallMs).toBeLessThan(50);
  }, 20_000);

  it('FR-ACC-05: a hash made in the pool is a bcryptjs cost-12 hash, and stored hashes still compare', async () => {
    const p = pool({ size: 1 });
    const made = await p.hash(RIGHT, 12);
    expect(made).toMatch(/^\$2[aby]\$12\$/);
    expect(compareSync(RIGHT, made)).toBe(true);
    expect(await p.compare(RIGHT, STORED)).toBe(true);
    expect(await p.compare('wrong', STORED)).toBe(false);
  }, 20_000);

  it('FR-ACC-05: jobs above the pool size wait their turn and all answer', async () => {
    const p = pool({ size: 1 });
    const answers = await Promise.all([RIGHT, 'a', RIGHT, 'b', RIGHT].map((pw) => p.compare(pw, STORED)));
    expect(answers).toEqual([true, false, true, false, true]);
  }, 30_000);

  it('FR-ACC-05: a worker that dies rejects its job, and the next job runs on a new worker', async () => {
    const p = pool({ size: 1, workerPath: FAULTY_WORKER });
    await expect(p.compare('crash', STORED)).rejects.toThrow(/password hash worker/);
    expect(await p.compare(RIGHT, STORED)).toBe(true);
  }, 20_000);

  it('FR-ACC-05: a job that outlives the timeout is rejected, its worker replaced, and the queue goes on', async () => {
    const p = pool({ size: 1, workerPath: FAULTY_WORKER, timeoutMs: 1500 }); // room for a new worker's start and one cost-12 compare
    const hung = p.compare('hang', STORED);
    const queued = p.compare(RIGHT, STORED); // waits behind the hung job, then runs on the replacement
    await expect(hung).rejects.toThrow(/timed out/);
    expect(await queued).toBe(true);
  }, 20_000);

  it('FR-ACC-05 (C4 m1): a worker that cannot start rejects the job it took, on a first start and on a restart', async () => {
    const fresh = pool({ size: 1 });
    workersCannotStart();
    await expect(within(fresh.compare(RIGHT, STORED), 5_000)).rejects.toThrow(/password hash worker could not start: ERR_WORKER_INIT_FAILED/);
    vi.restoreAllMocks();

    // The restart after a crash runs from the worker's exit handler, outside any caller's promise.
    const p = pool({ size: 1, workerPath: FAULTY_WORKER });
    const crashed = p.compare('crash', STORED); // dispatched now, on a worker that started
    const next = p.compare(RIGHT, STORED); // queued; the crash's handler starts a worker for it
    const after = p.compare(RIGHT, STORED); // queued behind it: not stranded when no worker can start
    workersCannotStart();
    await expect(crashed).rejects.toThrow(/password hash worker/);
    await expect(within(next, 5_000)).rejects.toThrow(/could not start/);
    await expect(within(after, 5_000)).rejects.toThrow(/could not start/);
    vi.restoreAllMocks();
    expect(await within(p.compare(RIGHT, STORED), 10_000)).toBe(true); // and the pool recovers once workers start again
  }, 30_000);

  it('FR-ACC-05 (C4 m3): an answer of the wrong type is rejected, never read as a match', async () => {
    const p = pool({ size: 1, workerPath: FAULTY_WORKER });
    await expect(p.compare('answer-a-string', STORED)).rejects.toThrow(/wrong type/);
    await expect(p.hash('answer-a-boolean', 12)).rejects.toThrow(/wrong type/);
    expect(await p.compare(RIGHT, STORED)).toBe(true);
  }, 20_000);

  it('FR-ACC-05: an error inside the worker rejects the job without a restart', async () => {
    const p = pool({ size: 1 });
    await expect(p.compare(RIGHT, 12 as unknown as string)).rejects.toThrow(/Illegal arguments/); // bcryptjs refuses a non-string hash
    expect(await p.compare(RIGHT, STORED)).toBe(true);
  }, 20_000);
});

describe('password hash pool size', () => {
  it('FR-ACC-05: one less than the cores, at least 1 and at most 2', () => {
    const prod = { NODE_ENV: 'production' };
    expect([1, 2, 3, 4, 16].map((cores) => passwordHashPoolSize(cores, prod))).toEqual([1, 1, 2, 2, 2]);
  });

  it('FR-ACC-05: PASSWORD_HASH_POOL_SIZE is honoured in tests only', () => {
    expect(passwordHashPoolSize(8, { NODE_ENV: 'test', PASSWORD_HASH_POOL_SIZE: '3' })).toBe(3);
    expect(passwordHashPoolSize(8, { NODE_ENV: 'production', PASSWORD_HASH_POOL_SIZE: '3' })).toBe(2);
    expect(passwordHashPoolSize(8, { NODE_ENV: 'test', PASSWORD_HASH_POOL_SIZE: 'lots' })).toBe(2);
  });
});
