import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { strFromU8, unzipSync } from 'fflate';
import { clearSession, sessionFor } from '../helpers/authSession';
import { testDb, resetDb } from '../helpers/db';
import { FIXTURE_QUESTION_IDS, useFixtureContent } from '../helpers/content';
import { HOSTILE_FILE_NAMES } from '../helpers/hostile';
import { addDecision, addEvidence, addProject, buildOrg, type OrgFixture } from '../helpers/recordFixture';
import type { OrgRole } from '@prisma/client';
import { GET } from '../../app/api/v1/orgs/[slug]/export/route';
import * as exportData from '../../lib/data/export';
import { captureLogs } from '../helpers/logCapture';
import { PENDING_ROUTES } from '../../lib/authz/routeActions';
import type { TeamExportJson } from '../../lib/data/export';

/**
 * Route 20 (00-contract.md, Routes row 20; SRS 6.3, ADR-C7): GET the team export of the organisation
 * or of one project as a ZIP streamed from its temporary file. The request URL carries the
 * container's host, as it does behind nginx, so a Location built from it would be visibly wrong.
 */

const EXPORT_FILE = 'app/api/v1/orgs/[slug]/export/route.ts';
const PDF_BYTES = Buffer.from('%PDF-1.4 hostile name fixture');

let fx: OrgFixture;
let projectId: string;
let projectOfB: string;
let q: { stage: 'pre-processing'; questionId: string; contentVersionId: string };

const exportDirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith('makrai-export-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function req(query: { projectId?: string | null }, headers: Record<string, string> = {}, init: { method?: string; signal?: AbortSignal } = {}): NextRequest {
  const url = new URL(`http://1038b2a33d91:3000/api/v1/orgs/${fx.org.slug}/export`);
  if (query.projectId) url.searchParams.set('projectId', query.projectId);
  return new NextRequest(url, { headers, ...init });
}
const params = () => ({ params: Promise.resolve({ slug: fx.org.slug }) });
const as = (role: OrgRole) => sessionFor(fx.members[role].userId);

/** Reads the rest of the stream at about `bytesPerSecond`. */
async function drainAt(reader: ReadableStreamDefaultReader<Uint8Array>, bytesPerSecond: number): Promise<number> {
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return total;
    total += value.byteLength;
    await sleep((value.byteLength / bytesPerSecond) * 1000);
  }
}

/** Local file headers by way of the central directory (fflate writes a data descriptor, so sizes are not in them). */
function rawEntries(buf: Buffer): Array<{ name: string; flags: number }> {
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  const out: Array<{ name: string; flags: number }> = [];
  let at = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i += 1) {
    const local = buf.readUInt32LE(at + 42);
    out.push({ flags: buf.readUInt16LE(local + 6), name: buf.subarray(local + 30, local + 30 + buf.readUInt16LE(local + 26)).toString('utf8') });
    at += 46 + buf.readUInt16LE(at + 28) + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return out;
}

const realTmp = tmpdir();
let ownTmp: string;

afterAll(() => {
  process.env.TMPDIR = realTmp;
  rmSync(ownTmp, { recursive: true, force: true });
});

beforeAll(async () => {
  await resetDb();
  // A temporary directory of this file's own as os.tmpdir(), so another process's exports never count here.
  ownTmp = mkdtempSync(join(realTmp, 'exp-test-'));
  process.env.TMPDIR = ownTmp;
  const content = await useFixtureContent('0.0.1-fixture');
  q = { stage: 'pre-processing', questionId: FIXTURE_QUESTION_IDS[0], contentVersionId: content.contentVersionId };
  fx = await buildOrg({ label: 'expr' });
  projectId = (await addProject(fx)).id;
  projectOfB = (await addProject(await buildOrg({ label: 'exprb' }))).id;
  // About 4 seconds of reading at 50 kB/s, so the stream is still open when the connection count is read.
  const big = await addEvidence(fx, projectId, { kind: 'file', fileName: 'large.pdf', bytes: Buffer.alloc(200_000, 0x41) });
  await addDecision(fx, projectId, { ...q, status: 'done', evidenceIds: [big.id] });
});

beforeEach(() => {
  clearSession();
  as('admin');
});

afterEach(() => {
  vi.unstubAllEnvs();
  expect(exportDirs()).toEqual([]); // every test leaves no export behind
});

describe('route 20, GET team export', () => {
  it('FR-EXP-01: an admin gets the ZIP as an attachment with its length, not cached', async () => {
    const res = await GET(req({ projectId }), params());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="makrai-export-${fx.org.slug}-${projectId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.zip"`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBeNull(); // nginx alone sets security headers (security-headers.test.ts)
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Number(res.headers.get('content-length'))).toBe(buf.byteLength);
    expect(Object.keys(unzipSync(buf))).toContain('export.json');
    expect(exportDirs()).toEqual([]); // released at the end of the stream
  });

  it('FR-EXP-01 ADR-C7: a client reading at 50 kB/s holds no database connection after the first second', async () => {
    const res = await GET(req({}), params());
    const reader = res.body!.getReader();
    await reader.read();
    await sleep(1000);
    expect(await testDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity
      WHERE usename = 'makrai_app' AND state IN ('active', 'idle in transaction')`).toEqual([{ n: BigInt(0) }]);
    expect(exportDirs()).toHaveLength(1); // still streaming from the file
    await drainAt(reader, 50_000);
  });

  it('FR-EXP-01 NFR-SEC-20: a third export while two run answers 429 export_busy, and a slot frees on cancel', async () => {
    const a = await GET(req({}), params());
    const b = await GET(req({}), params());
    const c = await GET(req({}), params());
    expect(c.status).toBe(429);
    expect(await c.json()).toMatchObject({ code: 'export_busy', retryAfterSeconds: 60 });
    await a.body!.cancel();
    const d = await GET(req({}), params());
    expect(d.status).toBe(200);
    await b.body!.cancel();
    await d.body!.cancel();
  });

  it('FR-EXP-01 NFR-SEC-11: hostile and non-ASCII evidence names survive export', async () => {
    const items: Array<{ id: string }> = [];
    for (const name of HOSTILE_FILE_NAMES) items.push(await addEvidence(fx, projectId, { kind: 'file', fileName: name, bytes: PDF_BYTES }, 'assessor'));
    await addDecision(fx, projectId, { ...q, status: 'done', evidenceIds: items.map((e) => e.id), by: 'assessor' });
    const buf = Buffer.from(await (await GET(req({ projectId }), params())).arrayBuffer());
    const files = unzipSync(new Uint8Array(buf));
    for (const entry of Object.keys(files)) {
      expect(entry.split('/')).not.toContain('..');
      expect(entry.startsWith('/')).toBe(false);
      expect(entry).not.toContain('\\');
      expect(entry).not.toContain('‮');
    }
    for (const h of rawEntries(buf)) if (/[^\x00-\x7f]/.test(h.name)) expect(h.flags & 0x800).toBe(0x800);
    expect(rawEntries(buf).some((h) => /[^\x00-\x7f]/.test(h.name))).toBe(true); // the UTF-8 case is exercised
    const json = JSON.parse(strFromU8(files['export.json'])) as TeamExportJson;
    const stored = json.projects.flatMap((p) => p.evidence);
    for (const name of HOSTILE_FILE_NAMES) expect(stored.map((e) => e.fileName)).toContain(name);
    for (const e of stored.filter((x) => items.some((i) => i.id === x.id))) {
      expect(e.file!.startsWith(`evidence/${e.id}-`)).toBe(true);
      expect(Buffer.from(files[e.file!])).toEqual(PDF_BYTES);
    }
    expect(strFromU8(files['README.txt'])).not.toMatch(/</);
  });

  it('FR-EXP-01 (owner question B4, contract row 20, R13-10): a browser navigation refused by export_busy goes back to S-20 of the same scope at the public origin, an API call keeps the 429', async () => {
    vi.stubEnv('AUTH_URL', 'https://makrai.example');
    vi.stubEnv('NEXTAUTH_URL', 'https://makrai.example');
    const a = await GET(req({ projectId }), params());
    const b = await GET(req({ projectId }), params());
    const nav = await GET(req({ projectId }, { 'sec-fetch-mode': 'navigate' }), params());
    expect([nav.status, nav.headers.get('location')]).toEqual([303, `https://makrai.example/orgs/${fx.org.slug}/projects/${projectId}/export?refused=export_busy`]);
    const orgNav = await GET(req({}, { 'sec-fetch-mode': 'navigate' }), params());
    expect([orgNav.status, orgNav.headers.get('location')]).toEqual([303, `https://makrai.example/orgs/${fx.org.slug}/export?refused=export_busy`]);
    const fetched = await GET(req({ projectId }, { 'sec-fetch-mode': 'cors' }), params());
    expect([fetched.status, (await fetched.json()).code]).toEqual([429, 'export_busy']);
    expect((await GET(req({ projectId }), params())).status).toBe(429);
    const bad = await GET(req({ projectId: '../x?refused=1' }, { 'sec-fetch-mode': 'navigate' }), params());
    expect([bad.status, bad.headers.get('location'), (await bad.json()).code]).toEqual([429, null, 'export_busy']);
    await a.body!.cancel();
    await b.body!.cancel();
  });

  it('FR-EXP-01 (contract Routes row 20, R14-13): when the public origin is not configured, a refused navigation keeps the JSON 429 and does not fail', async () => {
    vi.stubEnv('AUTH_URL', '');
    vi.stubEnv('NEXTAUTH_URL', '');
    const a = await GET(req({ projectId }), params());
    const b = await GET(req({ projectId }), params());
    const nav = await GET(req({ projectId }, { 'sec-fetch-mode': 'navigate' }), params());
    expect([nav.status, nav.headers.get('location'), (await nav.json()).code]).toEqual([429, null, 'export_busy']);
    await a.body!.cancel();
    await b.body!.cancel();
  });

  it('FR-EXP-01 FR-AUTHZ-01: assessor, reviewer and viewer get 403 on the export', async () => {
    for (const role of ['assessor', 'reviewer', 'viewer'] as const) {
      as(role);
      for (const query of [{}, { projectId }]) {
        const res = await GET(req(query), params());
        expect([role, res.status, (await res.json()).code]).toEqual([role, 403, 'forbidden']);
        expect(exportDirs()).toEqual([]);
      }
    }
    as('owner');
    const res = await GET(req({}), params());
    expect(res.status).toBe(200);
    await res.body!.cancel();
  });

  it('FR-EXP-01: a caller with no session gets 401 and no file', async () => {
    clearSession();
    expect((await GET(req({}), params())).status).toBe(401);
  });

  it('FR-EXP-01 NFR-SEC-02: a project of organisation B answers 404 and writes no file', async () => {
    const res = await GET(req({ projectId: projectOfB }), params());
    expect([res.status, (await res.json()).code]).toEqual([404, 'not_found']);
  });

  it('FR-EXP-01 ADR-C7: a HEAD request answers 405 and writes no export (Next answers HEAD with GET and never reads its body)', async () => {
    const res = await GET(req({ projectId }, {}, { method: 'HEAD' }), params());
    expect([res.status, res.headers.get('allow')]).toEqual([405, 'GET']);
    expect(exportDirs()).toEqual([]);
  });

  it('FR-EXP-01 ADR-C7: a request whose client left while the export was written releases it at once', async () => {
    const left = new AbortController();
    const pending = GET(req({ projectId }, {}, { signal: left.signal }), params());
    left.abort();
    const res = await pending;
    expect(res.body).toBeNull();
    expect(exportDirs()).toEqual([]);
    const a = await GET(req({}), params()); const b = await GET(req({}), params()); // both slots are free
    expect([a.status, b.status]).toEqual([200, 200]);
    await a.body!.cancel(); await b.body!.cancel();
  });

  it('FR-EXP-01 ADR-C7: a client that leaves mid-stream releases the export', async () => {
    const left = new AbortController();
    const res = await GET(req({}, {}, { signal: left.signal }), params());
    await res.body!.getReader().read();
    left.abort();
    await vi.waitFor(() => expect(exportDirs()).toEqual([]));
  });

  it('FR-EXP-01 ADR-C7: a failed cleanup at the end is logged and does not break a download already delivered', async () => {
    vi.spyOn(exportData, 'releaseTeamExport').mockRejectedValueOnce(new Error('EBUSY: resource busy'));
    const { result: buf, lines } = await captureLogs(async () => new Uint8Array(await (await GET(req({ projectId }), params())).arrayBuffer()));
    expect(Object.keys(unzipSync(buf))).toContain('export.json');
    expect(lines.some((l) => l.includes('team export: releasing the temporary file failed') && l.includes('EBUSY'))).toBe(true);
    vi.restoreAllMocks();
    const [dir] = exportDirs(); // the mocked release did nothing: release it for real
    await exportData.releaseTeamExport(join(tmpdir(), dir, 'export.zip'));
  });

  it('NFR-MNT-01: route 20 is no longer pending', () => {
    expect(PENDING_ROUTES).not.toContain(EXPORT_FILE);
  });
});
