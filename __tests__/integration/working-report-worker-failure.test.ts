import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLimiter } from '@/lib/concurrency/limiter';
import { createPdfWorkerPool, type PdfWorkerPool } from '@/lib/documents/render/pdfWorkerPool';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addProject, buildOrg } from '../helpers/recordFixture';
import { callRoute, sessionAs } from '../helpers/routeDriver';

/**
 * Task 16 fix: the working report renders on a worker thread (lib/documents/render/pdfWorkerPool.ts). When that worker cannot run,
 * the download fails loudly, as any server fault does: 500 `internal_error` with a support reference, never a PDF drawn some other
 * way. The route's lanes live on globalThis (lib/data/workingReportPdf.ts), so this case puts a pool whose worker file is missing
 * there before the route first runs, and takes it away afterwards.
 */

vi.setConfig({ testTimeout: 120_000 });

const ROUTE = 'app/api/v1/orgs/[slug]/projects/[id]/working-report/route.ts';
const LANES = Symbol.for('makrai.workingReportPdf.lanes');
const store = globalThis as unknown as Record<symbol, { limiter: unknown; pool: PdfWorkerPool } | undefined>;
let saved: (typeof store)[symbol];

beforeEach(async () => {
  await resetDb();
  saved = store[LANES];
  store[LANES] = {
    limiter: createLimiter(1),
    pool: createPdfWorkerPool({ size: 1, workerPath: join(process.cwd(), '__tests__', 'fixtures', 'pdf-worker', 'missing.mjs') }),
  };
});
afterEach(async () => {
  await store[LANES]?.pool.close();
  store[LANES] = saved;
});

it('a render worker that cannot load answers 500 internal_error with a support reference', async () => {
  const { contentVersionId } = await useFixtureContent('0.0.1-fixture');
  const fx = await buildOrg({ label: 'wrw' });
  const projectId = (await addProject(fx)).id;
  await addDecision(fx, projectId, {
    stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'done',
    decidedBy: { kind: 'member', userId: fx.members.owner.userId }, declaredDate: '2026-10-30',
  });
  sessionAs(fx.members.viewer.userId);
  const r = await callRoute(ROUTE, 'GET', { slug: fx.org.slug, params: { id: projectId }, query: {} });
  const body = await r.json();
  expect({ status: r.status, code: body.code, reference: typeof body.reference }).toEqual({ status: 500, code: 'internal_error', reference: 'string' });
  expect(r.headers.get('content-type')).not.toBe('application/pdf');
});

it('round 2 (review M2): a render that throws in the worker is logged with the worker\'s own frames under the reference', async () => {
  await store[LANES]?.pool.close();
  store[LANES] = {
    limiter: createLimiter(1),
    pool: createPdfWorkerPool({ size: 1, workerPath: join(process.cwd(), '__tests__', 'fixtures', 'pdf-worker', 'throwing-worker.mjs') }),
  };
  const { contentVersionId } = await useFixtureContent('0.0.1-fixture');
  const fx = await buildOrg({ label: 'wrt' });
  const projectId = (await addProject(fx)).id;
  await addDecision(fx, projectId, {
    stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'done',
    decidedBy: { kind: 'member', userId: fx.members.owner.userId }, declaredDate: '2026-10-30',
  });
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  sessionAs(fx.members.viewer.userId);
  const r = await callRoute(ROUTE, 'GET', { slug: fx.org.slug, params: { id: projectId }, query: {} });
  const body = await r.json();
  vi.restoreAllMocks();
  expect({ status: r.status, code: body.code }).toEqual({ status: 500, code: 'internal_error' });
  const logged = lines.filter((l) => l.includes('REQUEST_FAILED')).map((l) => JSON.parse(l));
  expect(logged).toHaveLength(1);
  expect(logged[0].reference).toBe(body.reference);
  expect(logged[0].error.frames[0]).toMatch(/throwing-worker\.mjs:\d+:\d+/);
});

