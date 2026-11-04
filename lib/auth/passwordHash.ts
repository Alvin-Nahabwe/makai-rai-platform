import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';

/**
 * bcryptjs's `compare` and `hash`, run on worker threads (FR-ACC-05, coordinator ruling: option 1). bcryptjs is pure
 * JavaScript, so on the main thread one cost-12 comparison held the event loop for about 250 ms and four at once for about
 * a second, and every other request waited behind them (a health read's p95 was about 1 s during a sign-in burst). Here
 * the main thread only posts a message and waits.
 *
 * - The work is bcryptjs itself (lib/auth/passwordHashWorker.js), so stored hashes stay valid and new ones are the same.
 * - The pool is `max(1, min(2, cores - 1))` workers, leaving a core for the main thread. The sign-in admission
 *   (lib/auth/signInAdmission.ts) still lets four comparisons run at once; those above the pool size queue here.
 * - A job is rejected when its worker dies or when it runs longer than HASH_JOB_TIMEOUT_MS; that worker is ended and a
 *   new one takes the next job. A rejected comparison is never a match: the sign-in throws, which NextAuth answers as a
 *   server problem.
 * - Workers start on first use and do not keep the process alive while idle.
 */
export const HASH_JOB_TIMEOUT_MS = 10_000;

/** lib/auth/passwordHashWorker.js, resolved from the working directory: the project root, or .next/standalone in the image. */
const WORKER_PATH = join(process.cwd(), 'lib', 'auth', 'passwordHashWorker.js');

/**
 * worker_threads, fetched at run time. A `new Worker(path)` the bundler can see is taken for a worker entry: Turbopack
 * globbed this computed path over the whole project and failed the build (a `turbopackIgnore` comment did not stop it).
 * The worker file reaches the image through next.config.ts's trace includes instead.
 */
function workerThreads(): typeof import('node:worker_threads') {
  return process.getBuiltinModule('node:worker_threads');
}

export interface PasswordHashPool {
  compare(password: string, passwordHash: string): Promise<boolean>;
  hash(password: string, cost: number): Promise<string>;
  /** Ends every worker and rejects what is still waiting. */
  close(): Promise<void>;
}

/** `max(1, min(2, cores - 1))`; PASSWORD_HASH_POOL_SIZE replaces it when NODE_ENV is `test`, and nowhere else. */
export function passwordHashPoolSize(cores: number, env: Record<string, string | undefined>): number {
  const override = Number(env.PASSWORD_HASH_POOL_SIZE);
  if (env.NODE_ENV === 'test' && Number.isInteger(override) && override >= 1) return override;
  return Math.max(1, Math.min(2, cores - 1));
}

type Job = { op: 'compare' | 'hash'; a: string; b: string | number; resolve: (v: never) => void; reject: (e: Error) => void };
type Slot = { worker: Worker | null; job: Job | null; jobId: number; timer: NodeJS.Timeout | null };

export function createPasswordHashPool(o: { size: number; workerPath?: string; timeoutMs?: number }): PasswordHashPool {
  const workerPath = o.workerPath ?? WORKER_PATH;
  const timeoutMs = o.timeoutMs ?? HASH_JOB_TIMEOUT_MS;
  const slots: Slot[] = Array.from({ length: o.size }, () => ({ worker: null, job: null, jobId: -1, timer: null }));
  const queue: Job[] = [];
  let nextId = 0;
  let closed = false;

  /** Rejects the slot's job, if any, with `error`, ends its worker so the next job starts a new one, and moves the queue on. */
  function fail(slot: Slot, worker: Worker, error: Error): void {
    if (slot.worker !== worker) return; // a worker already replaced: its late exit says nothing about the new one
    slot.worker = null;
    void worker.terminate();
    finish(slot)?.reject(error);
    pump();
  }

  /** Clears the slot's job and timer and lets an idle worker stop holding the process open; returns the job. */
  function finish(slot: Slot): Job | null {
    const job = slot.job;
    if (slot.timer) clearTimeout(slot.timer);
    slot.job = null;
    slot.timer = null;
    slot.worker?.unref();
    return job;
  }

  function spawn(slot: Slot): Worker {
    const worker = new (workerThreads().Worker)(workerPath);
    worker.unref();
    worker.on('message', (m: { id: number; value?: unknown; error?: string }) => {
      if (slot.worker !== worker || !slot.job || m.id !== slot.jobId) return;
      const job = finish(slot)!;
      if (m.error !== undefined) job.reject(new Error(`password hash failed: ${m.error}`));
      else job.resolve(m.value as never);
      pump();
    });
    worker.on('error', (e) => fail(slot, worker, new Error(`password hash worker failed: ${e.message}`)));
    worker.on('exit', (code) => fail(slot, worker, new Error(`password hash worker exited (code ${code})`)));
    slot.worker = worker;
    return worker;
  }

  function pump(): void {
    for (const slot of slots) {
      if (closed || queue.length === 0) return;
      if (slot.job) continue;
      const job = queue.shift()!;
      const worker = slot.worker ?? spawn(slot);
      slot.jobId = nextId++;
      slot.job = job;
      worker.ref(); // a job in flight keeps the process alive until it is answered
      slot.timer = setTimeout(() => fail(slot, worker, new Error(`password hash job timed out after ${timeoutMs} ms`)), timeoutMs);
      worker.postMessage({ id: slot.jobId, op: job.op, a: job.a, b: job.b });
    }
  }

  function run<T>(op: Job['op'], a: string, b: string | number): Promise<T> {
    if (closed) return Promise.reject(new Error('password hash pool is closed'));
    return new Promise<T>((resolve, reject) => {
      queue.push({ op, a, b, resolve: resolve as (v: never) => void, reject });
      pump();
    });
  }

  return {
    compare: (password, passwordHash) => run<boolean>('compare', password, passwordHash),
    hash: (password, cost) => run<string>('hash', password, cost),
    async close() {
      closed = true;
      for (const job of queue.splice(0)) job.reject(new Error('password hash pool is closed'));
      await Promise.all(slots.map(async (slot) => {
        const worker = slot.worker;
        slot.worker = null;
        finish(slot)?.reject(new Error('password hash pool is closed'));
        if (worker) await worker.terminate();
      }));
    },
  };
}

let shared: PasswordHashPool | null = null;
function sharedPool(): PasswordHashPool {
  shared ??= createPasswordHashPool({ size: passwordHashPoolSize(availableParallelism(), process.env) });
  return shared;
}

/** bcryptjs `compare`, on the shared pool. */
export function compare(password: string, passwordHash: string): Promise<boolean> {
  return sharedPool().compare(password, passwordHash);
}

/** bcryptjs `hash` at `cost`, on the shared pool. */
export function hash(password: string, cost: number): Promise<string> {
  return sharedPool().hash(password, cost);
}
