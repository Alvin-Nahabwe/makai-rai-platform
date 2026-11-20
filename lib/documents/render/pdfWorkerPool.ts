import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { pdfFontSource } from './font';
import type { PdfTree } from './pdfTree';
import type { LimiterTimers } from '@/lib/concurrency/limiter';
import { CLASS_NAME, FRAME, MAX_FRAMES } from '@/lib/http/stackFrames.mjs';

/**
 * The working report's PDFs, rendered on worker threads (Task 16 fix; design §5, the workshop; owner decision 20 Nov 2026,
 * "Limiter + worker thread"). react-pdf's render is synchronous work: a whole report held the main thread's event loop for
 * 350–480 ms, so with 21 downloads in flight every other page waited behind them, and the reads the renders held up kept their
 * database connections until the pool ran out. Here the main thread only posts the composed tree (pdfTree.ts) and waits.
 *
 * The shape is lib/auth/passwordHash.ts's pool, kept separate because that one gates sign-in:
 * - `size` workers, started on first use; idle workers do not keep the process alive.
 * - A job is rejected when its worker dies, cannot start, answers something that is not a non-empty PDF, sends an answer that
 *   cannot be read (`messageerror`), or runs longer than `timeoutMs`; that worker is ended and a new one takes the next job.
 * - A render that throws in the worker is rejected with a PdfRenderFailedError: the worker's error class as a code, and the worker's
 *   own stack frames, so the request's log line (lib/http/toResponse.ts, which logs the code and frames, never the message) names
 *   where in the worker it failed. The worker sends no message and no raw stack, and the pool keeps only what it can check: a class
 *   name, and lines in V8's frame shape (lib/http/stackFrames.mjs). There is no fallback to rendering on the main thread: a rejected job
 *   fails its request (500 with a support reference, lib/http/toResponse.ts), which is what this pool exists to avoid holding up.
 */

/**
 * A whole report renders in well under a second here (0.35–0.48 s, Task 16 fix report); this bounds a worker that hangs, not a slow
 * render. 15 s, the reviewer's value (Task 16 review M1): with the limiter's 25 s wait and the read's ~17 s worst case it stays under
 * nginx's 60 s proxy default, so a hung render's 500 with a support reference reaches the person instead of nginx's bare 504.
 */
export const PDF_JOB_TIMEOUT_MS = 15_000;

/**
 * Each render thread's heap limit (Task 16 review M3), so a runaway render ends its worker (and its job, as a failure) instead of
 * growing the server's memory. Measured on the fixture's whole report (82,029 bytes; the workshop's 24-page report is 89 KB) over
 * 20 renders on one worker: with no limit the heap grew to 214 MB before V8 collected it; with 128 or 256 MB the heap held at
 * 88–90 MB with a live set of about 56 MB, every render succeeded, and 20 renders took the same time (7.7 s). 256 MB leaves about
 * three times the observed heap for a larger bank, and two lanes cap the render threads' heaps at about 0.5 GB.
 */
export const PDF_WORKER_RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 256 });

const PDF_MAGIC = '%PDF-';
/** True for a non-empty byte array that begins with the PDF magic; anything else is never served as a PDF. */
function isPdf(bytes: unknown): bytes is Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) if (bytes[i] !== PDF_MAGIC.charCodeAt(i)) return false;
  return true;
}

/** A worker class name short enough that `PDF_WORKER_<NAME>` is a code toResponse's log line keeps (at most 41 characters). */
const CODE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,29}$/;

/**
 * A render that threw on its worker. The worker's message is never carried: it can hold the report's text, and the log line must
 * not. `code` is the fixed classification in its place, `PDF_WORKER_` and the worker's error class (`PDF_WORKER_ERROR` for a name
 * that is not a plain class name), and the stack is this error's head, then the worker's frames, then the main thread's own. Of
 * what the worker sent, only strings in V8's frame shape are kept, at most ten: the pool splits no stack and trusts no other text.
 */
export class PdfRenderFailedError extends Error {
  readonly code: string;
  constructor(workerName: unknown, workerFrames: unknown) {
    const name = typeof workerName === 'string' && CLASS_NAME.test(workerName) && CODE_NAME.test(workerName) ? workerName : 'Error';
    const code = `PDF_WORKER_${name.toUpperCase()}`;
    super(`pdf render failed in the worker (${code})`);
    this.name = 'PdfRenderFailedError';
    this.code = code;
    const frames = Array.isArray(workerFrames)
      ? workerFrames.filter((l): l is string => typeof l === 'string' && FRAME.test(l)).slice(0, MAX_FRAMES)
      : [];
    // The main thread's own stack has only the fixed message above it, so its frame-shaped lines are frames.
    const own = (this.stack ?? '').split('\n').filter((l) => FRAME.test(l));
    this.stack = [`${this.name}: ${this.message}`, ...frames, ...own].join('\n');
  }
}

const REAL_TIMERS: LimiterTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** lib/documents/render/pdfWorker.mjs, resolved from the working directory: the project root, or .next/standalone in the image. */
const WORKER_PATH = join(process.cwd(), 'lib', 'documents', 'render', 'pdfWorker.mjs');

/**
 * worker_threads, fetched at run time, as the password hash pool does: a `new Worker(path)` the bundler can see is taken for a
 * worker entry, and Turbopack failed the build on it. The worker file reaches the image through next.config.ts's trace includes.
 */
function workerThreads(): { Worker: typeof Worker } {
  return process.getBuiltinModule('node:worker_threads');
}

/**
 * How many reports render at once, and how many render threads there are: `max(1, min(2, cores - 1))`. Two was measured on the
 * 21-download burst (Task 16 fix report): no failed download, and the project page as fast as without the burst, while one more
 * lane only adds database reads in flight; a core is left for the main thread.
 */
export function pdfRenderLanes(cores: number): number {
  return Math.max(1, Math.min(2, cores - 1));
}

export interface PdfWorkerPool {
  render(tree: PdfTree): Promise<Buffer>;
  /** Ends every worker and rejects what is still waiting. */
  close(): Promise<void>;
}

type Job = { tree: PdfTree; resolve: (pdf: Buffer) => void; reject: (e: Error) => void };
type Slot = { worker: Worker | null; job: Job | null; jobId: number; timer: unknown };

export function createPdfWorkerPool(o: { size: number; workerPath?: string; timeoutMs?: number; timers?: LimiterTimers }): PdfWorkerPool {
  const workerPath = o.workerPath ?? WORKER_PATH;
  const timeoutMs = o.timeoutMs ?? PDF_JOB_TIMEOUT_MS;
  const timers = o.timers ?? REAL_TIMERS;
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
    if (slot.timer !== null) timers.clearTimeout(slot.timer);
    slot.job = null;
    slot.timer = null;
    slot.worker?.unref();
    return job;
  }

  function spawn(slot: Slot): Worker {
    const worker = new (workerThreads().Worker)(workerPath, { workerData: { font: pdfFontSource() }, resourceLimits: PDF_WORKER_RESOURCE_LIMITS });
    worker.unref();
    worker.on('message', (m: { id: number; pdf?: unknown; error?: unknown; frames?: unknown }) => {
      if (slot.worker !== worker || !slot.job || m.id !== slot.jobId) return;
      const job = finish(slot)!;
      if (m.error !== undefined) job.reject(new PdfRenderFailedError(m.error, m.frames));
      else if (!isPdf(m.pdf)) job.reject(new Error('pdf worker answered something that is not a PDF'));
      else job.resolve(Buffer.from(m.pdf.buffer, m.pdf.byteOffset, m.pdf.byteLength));
      pump();
    });
    worker.on('error', (e) => fail(slot, worker, new Error(`pdf worker failed: ${e.message}`)));
    // An answer the main thread cannot deserialize: without this the job would wait out the timeout.
    worker.on('messageerror', (e) => fail(slot, worker, new Error(`pdf worker answer could not be read: ${e.message}`)));
    worker.on('exit', (code) => fail(slot, worker, new Error(`pdf worker exited (code ${code})`)));
    slot.worker = worker;
    return worker;
  }

  /** Gives idle slots the queued jobs, those with a live worker first. A worker that cannot start rejects the job it was to take. */
  function pump(): void {
    while (!closed && queue.length > 0) {
      const slot = slots.find((s) => !s.job && s.worker) ?? slots.find((s) => !s.job);
      if (!slot) return;
      const job = queue.shift()!;
      let worker: Worker;
      try {
        worker = slot.worker ?? spawn(slot);
      } catch (e) {
        job.reject(new Error(`pdf worker could not start: ${e instanceof Error ? e.message : String(e)}`));
        continue;
      }
      slot.jobId = nextId++;
      slot.job = job;
      worker.ref(); // a job in flight keeps the process alive until it is answered
      slot.timer = timers.setTimeout(() => fail(slot, worker, new Error(`pdf render timed out after ${timeoutMs} ms`)), timeoutMs);
      try {
        worker.postMessage({ id: slot.jobId, tree: job.tree });
      } catch (e) {
        // A tree that cannot be copied to the thread (DataCloneError): this job fails, the worker is still good.
        finish(slot);
        job.reject(new Error(`pdf worker could not be sent the document: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  }

  return {
    render(tree) {
      if (closed) return Promise.reject(new Error('pdf worker pool is closed'));
      return new Promise<Buffer>((resolve, reject) => {
        queue.push({ tree, resolve, reject });
        pump();
      });
    },
    async close() {
      closed = true;
      for (const job of queue.splice(0)) job.reject(new Error('pdf worker pool is closed'));
      await Promise.all(slots.map(async (slot) => {
        const worker = slot.worker;
        slot.worker = null;
        finish(slot)?.reject(new Error('pdf worker pool is closed'));
        if (worker) await worker.terminate();
      }));
    },
  };
}
