import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createLimiter, type LimiterTimers } from '@/lib/concurrency/limiter';
import { WORKING_REPORT_QUEUE, WORKING_REPORT_BUSY_MESSAGE } from '@/lib/data/workingReportPdf';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addProject, buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { callRoute, sessionAs } from '../helpers/routeDriver';

/**
 * Task 16 fix, round 2 (the controller's ruling on review M1, the reviewer's values): a download that cannot get a render lane is
 * shed, never left hanging behind nginx's 60 s. At most 40 wait; the 41st, and one still waiting after 25 s, answer 503 with
 * `Retry-After` and a plain message. A download whose client has gone leaves the queue and is never read or rendered, and it is not
 * logged as a failure. The route's lanes live on globalThis (lib/data/workingReportPdf.ts), so each case puts its own there: a
 * limiter whose one permit a held task keeps, timers the case fires by hand, and a pool that records whether it was asked to render.
 */

vi.setConfig({ testTimeout: 120_000 });

const ROUTE = 'app/api/v1/orgs/[slug]/projects/[id]/working-report/route.ts';
const LANES = Symbol.for('makrai.workingReportPdf.lanes');
type Lanes = { limiter: ReturnType<typeof createLimiter>; pool: { render: (t: unknown) => Promise<Buffer>; close: () => Promise<void> } };
const store = globalThis as unknown as Record<symbol, Lanes | undefined>;
let saved: Lanes | undefined;
let releaseHeld: () => void = () => {};
const renders: unknown[] = [];

type FakeTimer = { fn: () => void; ms: number };
const made: FakeTimer[] = [];
const timers: LimiterTimers = {
  setTimeout(fn, ms) { const t = { fn, ms }; made.push(t); return t; },
  clearTimeout() {},
};

/** Lanes whose one permit is held until the case ends, so the next download waits (or is refused). */
function heldLanes(o: { maxWaiting: number }): void {
  const limiter = createLimiter(1, { maxWaiting: o.maxWaiting, maxWaitMs: WORKING_REPORT_QUEUE.maxWaitMs, timers });
  void limiter.run(() => new Promise<void>((resolve) => { releaseHeld = resolve; }));
  store[LANES] = { limiter, pool: { render: async (t) => { renders.push(t); return Buffer.from('%PDF-1.4 stub'); }, close: async () => {} } };
}

async function seedProject(contentVersionId: string): Promise<{ fx: OrgFixture; projectId: string }> {
  const fx = await buildOrg({ label: 'wrb' });
  const projectId = (await addProject(fx)).id;
  await addDecision(fx, projectId, {
    stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'done',
    decidedBy: { kind: 'member', userId: fx.members.owner.userId }, declaredDate: '2026-10-30',
  });
  sessionAs(fx.members.viewer.userId);
  return { fx, projectId };
}

beforeEach(async () => {
  await resetDb();
  saved = store[LANES];
  made.length = 0;
  renders.length = 0;
});
afterEach(() => {
  releaseHeld();
  vi.restoreAllMocks();
  store[LANES] = saved;
});

it('the lanes take the reviewer\'s values: 40 waiting, 25 s, then retry after 10 s', () => {
  expect(WORKING_REPORT_QUEUE).toEqual({ maxWaiting: 40, maxWaitMs: 25_000, retryAfterSeconds: 10 });
});

it('a download past the queue cap answers 503 at once, with Retry-After and a plain message, and nothing is rendered', async () => {
  const { fx, projectId } = await seedProject((await useFixtureContent('0.0.1-fixture')).contentVersionId);
  heldLanes({ maxWaiting: 0 });
  const r = await callRoute(ROUTE, 'GET', { slug: fx.org.slug, params: { id: projectId }, query: {} });
  const body = await r.json();
  expect({ status: r.status, retryAfter: r.headers.get('retry-after'), code: body.code, error: body.error, retryAfterSeconds: body.retryAfterSeconds })
    .toEqual({ status: 503, retryAfter: '10', code: 'report_busy', error: WORKING_REPORT_BUSY_MESSAGE, retryAfterSeconds: 10 });
  expect(made).toHaveLength(0);
  expect(renders).toHaveLength(0);
});

it('a download still waiting when its 25 s run out answers 503 with Retry-After, never hangs, and is not rendered', async () => {
  const { fx, projectId } = await seedProject((await useFixtureContent('0.0.1-fixture')).contentVersionId);
  heldLanes({ maxWaiting: 40 });
  const pending = callRoute(ROUTE, 'GET', { slug: fx.org.slug, params: { id: projectId }, query: {} });
  await vi.waitFor(() => expect(made).toHaveLength(1));
  expect(made[0].ms).toBe(25_000);
  made[0].fn();
  const r = await pending;
  const body = await r.json();
  expect({ status: r.status, retryAfter: r.headers.get('retry-after'), code: body.code }).toEqual({ status: 503, retryAfter: '10', code: 'report_busy' });
  expect(renders).toHaveLength(0);
});

it('a download whose client has gone leaves the queue, is never rendered, and is not logged as a failure', async () => {
  const { fx, projectId } = await seedProject((await useFixtureContent('0.0.1-fixture')).contentVersionId);
  heldLanes({ maxWaiting: 40 });
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  const gone = new AbortController();
  const { GET } = await import('@/app/api/v1/orgs/[slug]/projects/[id]/working-report/route');
  const url = `http://localhost/api/v1/orgs/${fx.org.slug}/projects/${projectId}/working-report`;
  const pending = GET(new NextRequest(url, { method: 'GET', headers: { host: 'localhost', origin: 'http://localhost' }, signal: gone.signal }),
    { params: Promise.resolve({ slug: fx.org.slug, id: projectId }) });
  await vi.waitFor(() => expect(store[LANES]?.limiter.waiting).toBe(1));
  gone.abort();
  const r = await pending;
  expect(r.status).toBe(499);
  expect(store[LANES]?.limiter.waiting).toBe(0);
  releaseHeld();
  await new Promise((resolve) => setImmediate(resolve));
  expect(renders).toHaveLength(0);
  expect(lines.filter((l) => l.includes('REQUEST_FAILED'))).toEqual([]);
});
