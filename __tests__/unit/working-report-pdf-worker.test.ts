import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Fragment, createElement, type ReactElement } from 'react';
import { Document, Link, Page, Text, View } from '@react-pdf/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadContent } from '@/lib/content/loader';
import { composeWorkingReport, renderWorkingReportPdf, workingReportDocument } from '@/lib/documents/render/workingReport';
import { toPdfTree } from '@/lib/documents/render/pdfTree';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { createPdfWorkerPool, pdfRenderLanes, PDF_JOB_TIMEOUT_MS, PDF_WORKER_RESOURCE_LIMITS, type PdfWorkerPool } from '@/lib/documents/render/pdfWorkerPool';
import { toResponse } from '@/lib/http/toResponse';
import { pdfPageRuns } from '../helpers/pdfText';
import { fullRecord } from '../helpers/draftRecord';

/**
 * Task 16 fix (path to outputs; design §5, the workshop): a whole working report took 350–480 ms of the main thread's event loop to
 * render, and 21 at once kept every other page waiting. The PDF is now rendered on a worker thread, from the same composed pages: the
 * main thread composes them with the existing composer and posts the tree, so what the report says cannot change. These cases pin
 * that the worker's PDF reads the same as the inline renderer's, and that a worker which fails makes the request fail, never hang.
 * The running content of the unit tests is the 0.0.1 fixture.
 */

const running = loadContent('0.0.1-fixture');
const FAULTY_WORKER = join(process.cwd(), '__tests__', 'fixtures', 'pdf-worker', 'faulty-worker.mjs');

const pools: PdfWorkerPool[] = [];
function pool(...a: Parameters<typeof createPdfWorkerPool>): PdfWorkerPool {
  const p = createPdfWorkerPool(...a);
  pools.push(p);
  return p;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

/** `p`, or a rejection after `ms`, so a job that is never settled fails the case instead of hanging it. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms))]);
}

const FINE = [...new TextEncoder().encode('%PDF-1.4 fixture')];
/** The line of lib/documents/render/pdfWorker.mjs that refuses an element type it does not draw. */
const TYPE_CHECK_LINE = readFileSync(join(process.cwd(), 'lib', 'documents', 'render', 'pdfWorker.mjs'), 'utf8')
  .split('\n').findIndex((l) => l.includes('is not one the worker draws')) + 1;

/** Timers the case fires by hand, so no case waits on the clock for a timeout. */
type FakeTimer = { id: number; fn: () => void; ms: number };
function fakeTimers() {
  const pending = new Map<number, FakeTimer>();
  const made: FakeTimer[] = [];
  let n = 0;
  return {
    made,
    setTimeout(fn: () => void, ms: number) { const t = { id: ++n, fn, ms }; pending.set(t.id, t); made.push(t); return t.id; },
    clearTimeout(id: unknown) { pending.delete(id as number); },
    fire(t: FakeTimer) { if (pending.delete(t.id)) t.fn(); },
  };
}

/** Workers the pool starts, through the real constructor, with `limits` in place of the pool's own resource limits when given. */
function spyWorkers(limits?: object): Array<{ worker: Worker; options: Record<string, unknown> }> {
  const real = process.getBuiltinModule.bind(process);
  const RealWorker = (real('node:worker_threads') as { Worker: typeof Worker }).Worker;
  const made: Array<{ worker: Worker; options: Record<string, unknown> }> = [];
  vi.spyOn(process, 'getBuiltinModule').mockImplementation(((id: string) =>
    id === 'node:worker_threads'
      ? { Worker: function W(path: string, options: Record<string, unknown>) {
        const worker = new RealWorker(path, limits ? { ...options, resourceLimits: limits } : options);
        made.push({ worker, options });
        return worker;
      } }
      : real(id)) as typeof process.getBuiltinModule);
  return made;
}

const docTitled = (title: string): ReactElement => createElement(Document, { title }, createElement(Page, { size: 'A4' }, createElement(Text, null, 'x')));

describe('the working report rendered on a worker thread', () => {
  it('reads the same as the inline renderer, page for page, for the whole report and for one part', async () => {
    const r = fullRecord(running);
    const p = pool({ size: 1 });
    for (const part of ['all', 'summary'] as const) {
      const { pages, title } = composeWorkingReport(r, running, part);
      const inline = pdfPageRuns((await renderWorkingReportPdf(pages, title)).pdf);
      const worker = await p.render(toPdfTree(workingReportDocument(pages, title)));
      expect(worker.subarray(0, 5).toString('latin1'), part).toBe('%PDF-');
      const runs = pdfPageRuns(worker);
      expect(runs.length, `${part}: page count`).toBe(inline.length);
      expect(runs, `${part}: text of every page`).toEqual(inline);
    }
    expect(pdfPageRuns((await renderWorkingReportPdf(composeWorkingReport(r, running, 'all').pages, 'x')).pdf).length).toBeGreaterThan(3);
  }, 60_000);

  it('the tree keeps every element, prop, key and child of the document, fragments and absent children included', () => {
    const el = createElement(Document, { title: 'T', language: 'en' }, [
      createElement(Page, { key: 'page-0', size: 'A4', style: { padding: 4 } },
        createElement(View, { fixed: true, wrap: false }, createElement(Text, { style: [{ fontSize: 9 }] }, 'a', 1, null)),
        createElement(Fragment, null, ', ', createElement(Link, { src: 'https://example.org/n' }, 'n')),
        null),
    ]);
    expect(toPdfTree(el)).toEqual({
      t: 'DOCUMENT', k: null, p: { title: 'T', language: 'en' }, c: [
        { t: 'PAGE', k: 'page-0', p: { size: 'A4', style: { padding: 4 } }, c: [
          { t: 'VIEW', k: null, p: { fixed: true, wrap: false }, c: { t: 'TEXT', k: null, p: { style: [{ fontSize: 9 }] }, c: ['a', 1, null] } },
          { t: '#fragment', k: null, p: {}, c: [', ', { t: 'LINK', k: null, p: { src: 'https://example.org/n' }, c: 'n' }] },
          null,
        ] },
      ],
    });
  });

  it('refuses a component, an element type the worker does not draw, and a function in a prop', () => {
    const Comp = (): ReactElement => createElement(Text, null, 'x');
    expect(() => toPdfTree(createElement(Document, null, createElement(Page, null, createElement(Comp))))).toThrow(/element type/);
    expect(() => toPdfTree(createElement('IMAGE', { src: 'x' }))).toThrow(/element type IMAGE/);
    expect(() => toPdfTree(createElement(Document, null, createElement(Text, { render: () => 'x' })))).toThrow(/function in prop render/);
  });

  it('a worker that dies rejects its job, and the next job runs on a new worker', async () => {
    const p = pool({ size: 1, workerPath: FAULTY_WORKER });
    await expect(within(p.render(toPdfTree(docTitled('crash'))), 10_000)).rejects.toThrow(/pdf worker exited/);
    expect([...(await within(p.render(toPdfTree(docTitled('fine'))), 10_000))]).toEqual(FINE);
  }, 30_000);

  it('a job that outlives the 15 s timeout is rejected, its worker ended, and the queue goes on (round 2: was 60 s)', async () => {
    const timers = fakeTimers();
    const p = pool({ size: 1, workerPath: FAULTY_WORKER, timers });
    const hung = p.render(toPdfTree(docTitled('hang')));
    const queued = p.render(toPdfTree(docTitled('fine')));
    expect(PDF_JOB_TIMEOUT_MS).toBe(15_000);
    expect(timers.made.map((t) => t.ms)).toEqual([15_000]);
    timers.fire(timers.made[0]);
    await expect(within(hung, 10_000)).rejects.toThrow(/timed out after 15000 ms/);
    expect([...(await within(queued, 10_000))]).toEqual(FINE);
  }, 30_000);

  it('a worker file that cannot load fails the job loudly, it does not hang or fall back to the main thread', async () => {
    const p = pool({ size: 1, workerPath: join(process.cwd(), '__tests__', 'fixtures', 'pdf-worker', 'missing.mjs') });
    await expect(within(p.render(toPdfTree(docTitled('fine'))), 10_000)).rejects.toThrow(/pdf worker (failed|exited)/);
  }, 30_000);

  it('a worker that cannot start rejects the job it took', async () => {
    const p = pool({ size: 1 });
    const real = process.getBuiltinModule.bind(process);
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(((id: string) =>
      id === 'node:worker_threads'
        ? { Worker: function Worker() { throw new Error('ERR_WORKER_INIT_FAILED EAGAIN'); } }
        : real(id)) as typeof process.getBuiltinModule);
    await expect(within(p.render(toPdfTree(docTitled('fine'))), 5_000)).rejects.toThrow(/^pdf worker could not start$/); // fixed text: the start error's own message is not carried (fix wave item 9)
  });

  it('the worker draws only the report: a tree with another element type is refused by the worker too', async () => {
    const p = pool({ size: 1 });
    const tree = { t: 'DOCUMENT', k: null, p: {}, c: { t: 'IMAGE', k: null, p: { src: 'x' } } };
    // The message is not carried (it can hold the report's text), so the first frame shows where: the worker's type check.
    const e = await within(p.render(tree as never), 30_000).then(() => null, (err: Error) => err);
    expect(e?.message).toBe('pdf render failed in the worker (PDF_WORKER_ERROR)');
    expect((e?.stack ?? '').split('\n')[1]).toMatch(new RegExp(`^\\s+at build \\(.*pdfWorker\\.mjs:${TYPE_CHECK_LINE}:\\d+\\)$`));
  }, 40_000);

  it('runs max(1, min(2, cores - 1)) render lanes: two measured best on the workshop burst, and a core is left for the main thread', () => {
    expect([1, 2, 3, 4, 12, 64].map(pdfRenderLanes)).toEqual([1, 1, 2, 2, 2, 2]);
  });

  it('round 2 (review M2): an answer that is not a non-empty PDF is refused, never served as a PDF', async () => {
    const p = pool({ size: 1, workerPath: FAULTY_WORKER });
    await expect(within(p.render(toPdfTree(docTitled('junk'))), 10_000)).rejects.toThrow(/not a PDF/);
    await expect(within(p.render(toPdfTree(docTitled('empty'))), 10_000)).rejects.toThrow(/not a PDF/);
    expect([...(await within(p.render(toPdfTree(docTitled('fine'))), 10_000))]).toEqual(FINE);
  }, 30_000);

  it('round 2 (review M2): a render that throws keeps the worker\'s own frames on the error, where the log line reads them', async () => {
    const p = pool({ size: 1 });
    const tree = { t: 'DOCUMENT', k: null, p: {}, c: { t: 'IMAGE', k: null, p: { src: 'x' } } };
    const e = await within(p.render(tree as never), 30_000).then(() => null, (err: Error) => err);
    expect(e?.message).toMatch(/^pdf render failed in the worker/);
    const frames = (e?.stack ?? '').split('\n').slice(1);
    expect(frames[0]).toMatch(/^\s+at .*pdfWorker\.mjs:\d+:\d+\)?$/);
  }, 40_000);

  it('a render error whose message holds lines shaped like stack frames: none of that text reaches the error or the log line', async () => {
    // build() puts the element type into its error, so a multi-line type is a message with lines that start `at`, one of them a
    // well-formed V8 frame. Record text in a render error would reach the log the same way.
    const LEAK = 'IMAGE\n    at Evil (secret answer text)\n    at secret answer text (/srv/secret-answer.js:1:2)\n    at Evil.secretAnswer (file:///srv/secret.mjs:3:4)';
    const p = pool({ size: 1 });
    const tree = { t: 'DOCUMENT', k: null, p: {}, c: { t: LEAK, k: null, p: {} } };
    const e = await within(p.render(tree as never), 30_000).then(() => null, (err: Error) => err);
    expect(e).toBeInstanceOf(Error);
    expect(`${e!.message}\n${e!.stack}`).not.toMatch(/secret|Evil/i);
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    toResponse(e);
    const logged = lines.filter((l) => l.includes('REQUEST_FAILED'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toMatch(/secret|Evil/i);
    const entry = JSON.parse(logged[0]);
    // A fixed classification stands where the message would be: the worker's error name, as a code the log line keeps.
    expect({ name: entry.error.name, code: entry.error.code }).toEqual({ name: 'PdfRenderFailedError', code: 'PDF_WORKER_ERROR' });
    expect(entry.error.frames[0]).toMatch(/^at build \(.*pdfWorker\.mjs:\d+:\d+\)$/);
  }, 40_000);

  it('the pool trusts no text from the worker: a raw stack, a message, a made-up name and frames that are not frames are all dropped', async () => {
    const p = pool({ size: 1, workerPath: FAULTY_WORKER });
    const e = await within(p.render(toPdfTree(docTitled('leak'))), 10_000).then(() => null, (err: Error) => err);
    expect(e).toBeInstanceOf(Error);
    expect(`${e!.message}\n${e!.stack}`).not.toMatch(/secret/i);
    expect((e as Error & { code?: string }).code).toBe('PDF_WORKER_ERROR');
    expect((e!.stack ?? '').split('\n').filter((l) => l.includes('/srv/'))).toEqual(['    at failingRender (/srv/fixture.mjs:3:9)']);
    // The worker is still good after an answer like that.
    expect([...(await within(p.render(toPdfTree(docTitled('fine'))), 10_000))]).toEqual(FINE);
  }, 30_000);

  it('round 2 (review M3): an answer the main thread cannot read (messageerror) rejects the job and replaces the worker', async () => {
    // A real messageerror needs a message Node cannot deserialize; this fake worker emits the event the pool listens for instead.
    class FakeWorker extends EventEmitter {
      static made: FakeWorker[] = [];
      terminated = false;
      constructor() { super(); FakeWorker.made.push(this); }
      postMessage(m: { id: number }) {
        const first = FakeWorker.made.length === 1;
        setImmediate(() => first
          ? this.emit('messageerror', new Error('could not deserialize'))
          : this.emit('message', { id: m.id, pdf: new TextEncoder().encode('%PDF-1.4 fake') }));
      }
      ref() {}
      unref() {}
      terminate() { this.terminated = true; return Promise.resolve(0); }
    }
    const real = process.getBuiltinModule.bind(process);
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(((id: string) =>
      id === 'node:worker_threads' ? { Worker: FakeWorker } : real(id)) as typeof process.getBuiltinModule);
    const p = pool({ size: 1, timers: fakeTimers() });
    await expect(within(p.render(toPdfTree(docTitled('fine'))), 5_000)).rejects.toThrow(/^pdf worker answer could not be read$/); // fixed text (fix wave item 9)
    expect(FakeWorker.made[0].terminated).toBe(true);
    expect((await within(p.render(toPdfTree(docTitled('fine'))), 5_000)).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(FakeWorker.made).toHaveLength(2);
  });

  it('round 2 (review M3): each worker runs under a heap limit, and a render that outgrows it ends the job, not the process', async () => {
    const seen = spyWorkers();
    const p = pool({ size: 1, workerPath: FAULTY_WORKER });
    await within(p.render(toPdfTree(docTitled('fine'))), 10_000);
    expect(PDF_WORKER_RESOURCE_LIMITS).toEqual({ maxOldGenerationSizeMb: 256 });
    expect(seen[0].options.resourceLimits).toBe(PDF_WORKER_RESOURCE_LIMITS);
    vi.restoreAllMocks();
    // The same pool shape with a 32 MB limit, so the fixture reaches it quickly.
    spyWorkers({ maxOldGenerationSizeMb: 32 });
    const small = pool({ size: 1, workerPath: FAULTY_WORKER });
    await expect(within(small.render(toPdfTree(docTitled('balloon'))), 30_000)).rejects.toThrow(/pdf worker (failed|exited)/);
    expect([...(await within(small.render(toPdfTree(docTitled('fine'))), 10_000))]).toEqual(FINE);
  }, 60_000);
});

/**
 * Fix wave item 9 (silent-failure audit I2): every way the pool fails a job reaches the request's log line with a code, since that line
 * keeps an error's class, code and frames and never its message. Each failure is a PdfPoolError with a fixed message; a worker
 * error's own errno-shaped code and a worker's exit code are carried in the code, never its message.
 */
describe('every pool failure is a coded PdfPoolError in the log line', () => {
  /** The REQUEST_FAILED line's error entry for `e`, as lib/http/toResponse.ts logs it. */
  function loggedFor(e: unknown): { name: string; code?: string } {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    toResponse(e);
    spy.mockRestore();
    const entry = JSON.parse(lines.find((l) => l.includes('REQUEST_FAILED'))!);
    return { name: entry.error.name, code: entry.error.code };
  }
  const failure = <T,>(p: Promise<T>, ms: number) => within(p, ms).then(() => null, (e: unknown) => e);

  it('a worker that exits: PDF_POOL_EXIT_<exit code>', async () => {
    const p = pool({ size: 1, workerPath: FAULTY_WORKER });
    expect(loggedFor(await failure(p.render(toPdfTree(docTitled('crash'))), 10_000))).toEqual({ name: 'PdfPoolError', code: 'PDF_POOL_EXIT_1' });
  }, 30_000);

  it('a render past the timeout: PDF_POOL_TIMEOUT', async () => {
    const timers = fakeTimers();
    const p = pool({ size: 1, workerPath: FAULTY_WORKER, timers });
    const hung = p.render(toPdfTree(docTitled('hang')));
    timers.fire(timers.made[0]);
    expect(loggedFor(await failure(hung, 10_000))).toEqual({ name: 'PdfPoolError', code: 'PDF_POOL_TIMEOUT' });
  }, 30_000);

  it('an answer that is not a PDF: PDF_POOL_NOT_PDF', async () => {
    const p = pool({ size: 1, workerPath: FAULTY_WORKER });
    expect(loggedFor(await failure(p.render(toPdfTree(docTitled('junk'))), 10_000))).toEqual({ name: 'PdfPoolError', code: 'PDF_POOL_NOT_PDF' });
  }, 30_000);

  it('a worker that runs out of heap: the worker error\'s own code, PDF_POOL_ERR_WORKER_OUT_OF_MEMORY', async () => {
    spyWorkers({ maxOldGenerationSizeMb: 32 });
    const p = pool({ size: 1, workerPath: FAULTY_WORKER });
    expect(loggedFor(await failure(p.render(toPdfTree(docTitled('balloon'))), 30_000))).toEqual({ name: 'PdfPoolError', code: 'PDF_POOL_ERR_WORKER_OUT_OF_MEMORY' });
  }, 60_000);

  it('a worker file that cannot load: a PDF_POOL_ code, never an anonymous Error', async () => {
    const p = pool({ size: 1, workerPath: join(process.cwd(), '__tests__', 'fixtures', 'pdf-worker', 'missing.mjs') });
    const logged = loggedFor(await failure(p.render(toPdfTree(docTitled('fine'))), 10_000));
    expect(logged.name).toBe('PdfPoolError');
    expect(logged.code).toMatch(/^PDF_POOL_(ERR_[A-Z_]+|WORKER_ERROR|EXIT_\d+)$/);
  }, 30_000);

  it('a worker that cannot start, a document that cannot be sent, and a closed pool: PDF_POOL_SPAWN, PDF_POOL_POST, PDF_POOL_CLOSED', async () => {
    const real = process.getBuiltinModule.bind(process);
    const spy = vi.spyOn(process, 'getBuiltinModule').mockImplementation(((id: string) =>
      id === 'node:worker_threads' ? { Worker: function Worker() { throw new Error('secret EAGAIN'); } } : real(id)) as typeof process.getBuiltinModule);
    const spawnFailure = await failure(pool({ size: 1 }).render(toPdfTree(docTitled('fine'))), 5_000);
    spy.mockRestore();
    expect(loggedFor(spawnFailure)).toEqual({ name: 'PdfPoolError', code: 'PDF_POOL_SPAWN' });
    expect(String((spawnFailure as Error).message)).not.toMatch(/secret/);
    const p = pool({ size: 1, workerPath: FAULTY_WORKER });
    const unsendable = { t: 'DOCUMENT', k: null, p: { title: () => 'x' } };
    expect(loggedFor(await failure(p.render(unsendable as never), 10_000))).toEqual({ name: 'PdfPoolError', code: 'PDF_POOL_POST' });
    await p.close();
    expect(loggedFor(await failure(p.render(toPdfTree(docTitled('fine'))), 5_000))).toEqual({ name: 'PdfPoolError', code: 'PDF_POOL_CLOSED' });
  }, 30_000);

  it('an answer the main thread cannot read: PDF_POOL_MESSAGEERROR', async () => {
    class FakeWorker extends EventEmitter {
      postMessage() { setImmediate(() => this.emit('messageerror', new Error('secret could not deserialize'))); }
      ref() {}
      unref() {}
      terminate() { return Promise.resolve(0); }
    }
    const real = process.getBuiltinModule.bind(process);
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(((id: string) =>
      id === 'node:worker_threads' ? { Worker: FakeWorker } : real(id)) as typeof process.getBuiltinModule);
    const e = await failure(pool({ size: 1, timers: fakeTimers() }).render(toPdfTree(docTitled('fine'))), 5_000);
    expect(loggedFor(e)).toEqual({ name: 'PdfPoolError', code: 'PDF_POOL_MESSAGEERROR' });
    expect(String((e as Error).message)).not.toMatch(/secret/);
  });
});
