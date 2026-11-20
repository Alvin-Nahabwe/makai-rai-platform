import { join } from 'node:path';
import { Fragment, createElement, type ReactElement } from 'react';
import { Document, Link, Page, Text, View } from '@react-pdf/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadContent } from '@/lib/content/loader';
import { composeWorkingReport, renderWorkingReportPdf, workingReportDocument } from '@/lib/documents/render/workingReport';
import { toPdfTree } from '@/lib/documents/render/pdfTree';
import { createPdfWorkerPool, pdfRenderLanes, type PdfWorkerPool } from '@/lib/documents/render/pdfWorkerPool';
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
    expect([...(await within(p.render(toPdfTree(docTitled('fine'))), 10_000))]).toEqual([1, 2, 3, 4]);
  }, 30_000);

  it('a job that outlives the timeout is rejected, its worker ended, and the queue goes on', async () => {
    const p = pool({ size: 1, workerPath: FAULTY_WORKER, timeoutMs: 1500 });
    const hung = p.render(toPdfTree(docTitled('hang')));
    const queued = p.render(toPdfTree(docTitled('fine')));
    await expect(within(hung, 10_000)).rejects.toThrow(/timed out after 1500 ms/);
    expect([...(await within(queued, 10_000))]).toEqual([1, 2, 3, 4]);
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
    await expect(within(p.render(toPdfTree(docTitled('fine'))), 5_000)).rejects.toThrow(/pdf worker could not start: ERR_WORKER_INIT_FAILED/);
  });

  it('the worker draws only the report: a tree with another element type is refused by the worker too', async () => {
    const p = pool({ size: 1 });
    const tree = { t: 'DOCUMENT', k: null, p: {}, c: { t: 'IMAGE', k: null, p: { src: 'x' } } };
    await expect(within(p.render(tree as never), 30_000)).rejects.toThrow(/pdf render failed: .*element type IMAGE/);
  }, 40_000);

  it('runs max(1, min(2, cores - 1)) render lanes: two measured best on the workshop burst, and a core is left for the main thread', () => {
    expect([1, 2, 3, 4, 12, 64].map(pdfRenderLanes)).toEqual([1, 1, 2, 2, 2, 2]);
  });
});
