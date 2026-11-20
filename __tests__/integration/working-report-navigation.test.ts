import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createLimiter } from '@/lib/concurrency/limiter';
import { createPdfWorkerPool } from '@/lib/documents/render/pdfWorkerPool';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addProject, buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { sessionAs } from '../helpers/routeDriver';

/**
 * Fix wave item 8 (silent-failure audit I1; final review M4): the download links on the working report are plain anchors, so a
 * refusal of a browser navigation answered as JSON replaced the page with raw text. A navigation (`Sec-Fetch-Mode: navigate`)
 * refused with 503 `report_busy`, a server fault (500), 422 `part` or 404 now goes back to the report page with the reason in the
 * query, as the team export does for `export_busy` (lib/http/exportRefusal.ts). Every 404 gets the one redirect, whatever its cause.
 * Anything that is not a navigation keeps the route's JSON. Fix wave item 13 (final review M5): HEAD takes no render lane.
 */

vi.setConfig({ testTimeout: 120_000 });

const LANES = Symbol.for('makrai.workingReportPdf.lanes');
type Lanes = { limiter: ReturnType<typeof createLimiter>; pool: { render: (t: never) => Promise<Buffer>; close: () => Promise<void> } };
const store = globalThis as unknown as Record<symbol, Lanes | undefined>;
const ORIGIN = 'https://makrai.example';

let saved: Lanes | undefined;
let fx: OrgFixture;
let projectId: string;
let releaseHeld: () => void = () => {};
const renders: unknown[] = [];

/** Lanes that render a stub, or (held) whose one permit is kept so the next download is refused at once. */
function stubLanes(o: { held: boolean }): void {
  const limiter = createLimiter(1, { maxWaiting: 0 });
  if (o.held) void limiter.run(() => new Promise<void>((resolve) => { releaseHeld = resolve; }));
  store[LANES] = { limiter, pool: { render: async (t) => { renders.push(t); return Buffer.from('%PDF-1.4 stub'); }, close: async () => {} } };
}

async function call(o: { method?: 'GET' | 'HEAD'; id?: string; part?: string; navigate?: boolean }): Promise<Response> {
  const { GET } = await import('@/app/api/v1/orgs/[slug]/projects/[id]/working-report/route');
  const id = o.id ?? projectId;
  const url = new URL(`http://localhost/api/v1/orgs/${fx.org.slug}/projects/${id}/working-report`);
  if (o.part !== undefined) url.searchParams.set('part', o.part);
  const headers: Record<string, string> = { host: 'localhost', origin: 'http://localhost' };
  if (o.navigate) headers['sec-fetch-mode'] = 'navigate';
  return GET(new NextRequest(url, { method: o.method ?? 'GET', headers }), { params: Promise.resolve({ slug: fx.org.slug, id }) });
}

const reportPage = (id = projectId) => `${ORIGIN}/orgs/${fx.org.slug}/projects/${id}/report`;

beforeEach(async () => {
  await resetDb();
  saved = store[LANES];
  renders.length = 0;
  vi.stubEnv('AUTH_URL', ORIGIN);
  vi.stubEnv('NEXTAUTH_URL', ORIGIN);
  const { contentVersionId } = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg({ label: 'wrn' });
  projectId = (await addProject(fx)).id;
  await addDecision(fx, projectId, {
    stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'done',
    decidedBy: { kind: 'member', userId: fx.members.owner.userId }, declaredDate: '2026-10-30',
  });
  sessionAs(fx.members.viewer.userId);
});
afterEach(async () => {
  releaseHeld();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  store[LANES] = saved;
});

describe('a refused download opened as a page goes back to the report page', () => {
  it('503 report_busy: 303 to ?refused=report_busy, no-store; a fetch keeps the JSON 503 with Retry-After', async () => {
    stubLanes({ held: true });
    const nav = await call({ navigate: true });
    expect([nav.status, nav.headers.get('location'), nav.headers.get('cache-control')]).toEqual([303, `${reportPage()}?refused=report_busy`, 'no-store']);
    const fetched = await call({});
    expect([fetched.status, fetched.headers.get('retry-after'), (await fetched.json()).code]).toEqual([503, '10', 'report_busy']);
  });

  it('422 part: 303 to ?refused=part; a fetch keeps the JSON 422', async () => {
    stubLanes({ held: false });
    const nav = await call({ navigate: true, part: 'nonsense' });
    expect([nav.status, nav.headers.get('location')]).toEqual([303, `${reportPage()}?refused=part`]);
    expect((await call({ part: 'nonsense' })).status).toBe(422);
  });

  it('404: a stage plan with no answers and another organisation\'s project get the same redirect shape, ?refused=not_found', async () => {
    stubLanes({ held: false });
    const plan = await call({ navigate: true, part: 'mitigation_plan:post-processing' });
    expect([plan.status, plan.headers.get('location')]).toEqual([303, `${reportPage()}?refused=not_found`]);
    const other = await buildOrg({ label: 'wrn-b' });
    const foreign = (await addProject(other)).id;
    const nav = await call({ navigate: true, id: foreign });
    expect([nav.status, nav.headers.get('location')]).toEqual([303, `${reportPage(foreign)}?refused=not_found`]);
    expect((await call({ id: foreign })).status).toBe(404);
  });

  it('a malformed project id is never echoed into a redirect: it keeps the JSON 404', async () => {
    stubLanes({ held: false });
    const nav = await call({ navigate: true, id: '../x?refused=1' });
    expect([nav.status, nav.headers.get('location'), (await nav.json()).code]).toEqual([404, null, 'not_found']);
  });

  it('500: 303 to ?refused=internal_error&reference=<the logged reference>', async () => {
    store[LANES] = {
      limiter: createLimiter(1),
      pool: createPdfWorkerPool({ size: 1, workerPath: join(process.cwd(), '__tests__', 'fixtures', 'pdf-worker', 'missing.mjs') }),
    };
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    try {
      const nav = await call({ navigate: true });
      const logged = lines.filter((l) => l.includes('REQUEST_FAILED')).map((l) => JSON.parse(l));
      expect(logged).toHaveLength(1);
      expect([nav.status, nav.headers.get('location')]).toEqual([303, `${reportPage()}?refused=internal_error&reference=${logged[0].reference}`]);
    } finally {
      await store[LANES]?.pool.close();
    }
  });

  it('with no public origin configured, a refused navigation keeps the JSON answer and does not fail', async () => {
    vi.stubEnv('AUTH_URL', '');
    vi.stubEnv('NEXTAUTH_URL', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubLanes({ held: true });
    const nav = await call({ navigate: true });
    expect([nav.status, nav.headers.get('location'), nav.headers.get('retry-after'), (await nav.json()).code]).toEqual([503, null, '10', 'report_busy']);
  });
});

describe('HEAD', () => {
  it('answers 405 with Allow: GET and takes no render lane', async () => {
    stubLanes({ held: false });
    const r = await call({ method: 'HEAD' });
    expect([r.status, r.headers.get('allow')]).toEqual([405, 'GET']);
    expect(renders).toHaveLength(0);
  });
});
