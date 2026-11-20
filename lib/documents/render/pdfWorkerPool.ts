import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { pdfFontSource } from './font';
import type { PdfTree } from './pdfTree';

/**
 * The working report's PDFs, rendered on worker threads (Task 16 fix; design §5, the workshop; owner decision 20 Nov 2026,
 * "Limiter + worker thread"). react-pdf's render is synchronous work: a whole report held the main thread's event loop for
 * 350–480 ms, so with 21 downloads in flight every other page waited behind them, and the reads the renders held up kept their
 * database connections until the pool ran out. Here the main thread only posts the composed tree (pdfTree.ts) and waits.
 *
 * The shape is lib/auth/passwordHash.ts's pool, kept separate because that one gates sign-in:
 * - `size` workers, started on first use; idle workers do not keep the process alive.
 * - A job is rejected when its worker dies, cannot start, answers something that is not bytes, or runs longer than `timeoutMs`;
 *   that worker is ended and a new one takes the next job. There is no fallback to rendering on the main thread: a rejected job
 *   fails its request (500 with a support reference, lib/http/toResponse.ts), which is what this pool exists to avoid holding up.
 */

/** A whole report renders in well under a second here; this bounds a worker that hangs, not a slow render. */
export const PDF_JOB_TIMEOUT_MS = 60_000;

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
type Slot = { worker: Worker | null; job: Job | null; jobId: number; timer: NodeJS.Timeout | null };

export function createPdfWorkerPool(o: { size: number; workerPath?: string; timeoutMs?: number }): PdfWorkerPool {
  const workerPath = o.workerPath ?? WORKER_PATH;
  const timeoutMs = o.timeoutMs ?? PDF_JOB_TIMEOUT_MS;
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
    const worker = new (workerThreads().Worker)(workerPath, { workerData: { font: pdfFontSource() } });
    worker.unref();
    worker.on('message', (m: { id: number; pdf?: unknown; error?: string }) => {
      if (slot.worker !== worker || !slot.job || m.id !== slot.jobId) return;
      const job = finish(slot)!;
      if (m.error !== undefined) job.reject(new Error(`pdf render failed: ${m.error}`));
      else if (!(m.pdf instanceof Uint8Array)) job.reject(new Error('pdf worker answered something that is not bytes'));
      else job.resolve(Buffer.from(m.pdf.buffer, m.pdf.byteOffset, m.pdf.byteLength));
      pump();
    });
    worker.on('error', (e) => fail(slot, worker, new Error(`pdf worker failed: ${e.message}`)));
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
      slot.timer = setTimeout(() => fail(slot, worker, new Error(`pdf render timed out after ${timeoutMs} ms`)), timeoutMs);
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
