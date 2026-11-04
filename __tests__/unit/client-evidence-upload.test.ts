import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  evidenceUploadUrl, failureOf, postEvidenceLink, requestIdForFile, uploadEvidenceFile, UPLOAD_STALL_MS, type UploadOutcome,
} from '@/lib/client/evidenceUpload';
import type { EvidenceItemView } from '@/types/api';

const R1 = '0b3f6c1e-5a2d-4f7b-9d41-6a1f2c3d4e51';
const F = new File([new Uint8Array(1000)], 'a.pdf', { type: 'application/pdf' });
const FILE_META = { name: 'a.pdf', size: 1000, lastModified: 1_700_000_000_000 };
const VIEW = { id: 'e1', kind: 'file', fileName: 'a.pdf' } as EvidenceItemView;

/** An XMLHttpRequest whose upload emits progress when the test says so. */
function fakeXhr() {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const uploadListeners = new Map<string, Array<(e: unknown) => void>>();
  const on = (m: Map<string, Array<(e: unknown) => void>>) => (t: string, f: (e: unknown) => void) => { m.set(t, [...(m.get(t) ?? []), f]); };
  const emit = (m: Map<string, Array<(e: unknown) => void>>, t: string, e: unknown = {}) => (m.get(t) ?? []).forEach((f) => f(e));
  const x = {
    aborted: false, status: 0, responseText: '', method: '', openedUrl: '', sent: null as unknown,
    upload: { addEventListener: on(uploadListeners) },
    addEventListener: on(listeners),
    open(method: string, url: string) { x.method = method; x.openedUrl = url; },
    send(body: unknown) { x.sent = body; },
    abort() { x.aborted = true; emit(listeners, 'abort'); },
    progress(loaded: number) { emit(uploadListeners, 'progress', { lengthComputable: true, loaded, total: 1000 }); },
    respond(status: number, text: string) { x.status = status; x.responseText = text; emit(listeners, 'load'); },
    fail() { emit(listeners, 'error'); },
  };
  return x;
}

afterEach(() => { vi.useRealTimers(); });

describe('the client upload module', () => {
  it('UX-30: the stall limit is 30 seconds and the upload url is built from encoded ids', () => {
    expect(UPLOAD_STALL_MS).toBe(30_000);
    expect(evidenceUploadUrl('my org', 'p/1')).toBe('/api/v1/orgs/my%20org/projects/p%2F1/evidence');
  });

  it('UX-30: progress is reported as bytes move, and 30 seconds without movement is a failed upload', async () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const x = fakeXhr();
    const p = uploadEvidenceFile({ url: '/u', file: F, requestId: R1, onProgress: (l) => seen.push(l), xhrFactory: () => x as unknown as XMLHttpRequest });
    x.progress(100_000);
    await vi.advanceTimersByTimeAsync(29_000);
    x.progress(200_000);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(seen).toEqual([100_000, 200_000]);
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(p).resolves.toEqual({ kind: 'not_uploaded', reason: 'stalled' });
    expect(x.aborted).toBe(true);
  });

  it('UX-30: the timer keeps running after the last byte until the reply', async () => {
    vi.useFakeTimers();
    const x = fakeXhr();
    const p = uploadEvidenceFile({ url: '/u', file: F, requestId: R1, onProgress: () => {}, xhrFactory: () => x as unknown as XMLHttpRequest });
    x.progress(1000);
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(p).resolves.toEqual({ kind: 'not_uploaded', reason: 'stalled' });
  });

  it('FR-DEC-07 UX-30: Retry upload of the same chosen file reuses its request id; a newly chosen file gets a new one', () => {
    const first = requestIdForFile({ requestId: null, sentBody: null }, FILE_META);
    expect(requestIdForFile(first.state, FILE_META).requestId).toBe(first.requestId);
    expect(requestIdForFile({ requestId: null, sentBody: null }, FILE_META).requestId).not.toBe(first.requestId);
  });

  it('UX-30: a 201 is uploaded, a 413 file_too_large is rejected, an abort is not uploaded, a lost connection is not uploaded', async () => {
    const answer = async (status: number, body: unknown) => {
      const x = fakeXhr();
      const p = uploadEvidenceFile({ url: '/u', file: F, requestId: R1, onProgress: () => {}, xhrFactory: () => x as unknown as XMLHttpRequest });
      x.respond(status, JSON.stringify(body));
      return p;
    };
    expect(await answer(201, VIEW)).toEqual({ kind: 'uploaded', status: 201, item: VIEW });
    expect(await answer(200, VIEW)).toEqual({ kind: 'uploaded', status: 200, item: VIEW });
    expect(failureOf(await answer(413, { error: 'x', code: 'file_too_large' }) as Exclude<UploadOutcome, { kind: 'uploaded' }>)).toBe('too_large');

    const ac = new AbortController();
    const x = fakeXhr();
    const p = uploadEvidenceFile({ url: '/u', file: F, requestId: R1, onProgress: () => {}, signal: ac.signal, xhrFactory: () => x as unknown as XMLHttpRequest });
    ac.abort();
    expect(await p).toEqual({ kind: 'not_uploaded', reason: 'aborted' });
    expect(x.aborted).toBe(true);

    const y = fakeXhr();
    const q = uploadEvidenceFile({ url: '/u', file: F, requestId: R1, onProgress: () => {}, xhrFactory: () => y as unknown as XMLHttpRequest });
    y.fail();
    expect(await q).toEqual({ kind: 'not_uploaded', reason: 'network' });
  });

  it('UX-30: the upload posts multipart with the request id and the file to the given url', async () => {
    const x = fakeXhr();
    const p = uploadEvidenceFile({ url: '/u', file: F, requestId: R1, onProgress: () => {}, xhrFactory: () => x as unknown as XMLHttpRequest });
    x.respond(201, JSON.stringify(VIEW));
    await p;
    expect([x.method, x.openedUrl]).toEqual(['POST', '/u']);
    expect((x.sent as FormData).get('requestId')).toBe(R1);
    expect((x.sent as FormData).get('file')).toBeInstanceOf(File);
  });

  it('UX-30: a reply that is not an API error body is still a rejection, and an unreadable 2xx is not uploaded', async () => {
    const x = fakeXhr();
    const p = uploadEvidenceFile({ url: '/u', file: F, requestId: R1, onProgress: () => {}, xhrFactory: () => x as unknown as XMLHttpRequest });
    x.respond(413, '<html>Request Entity Too Large</html>');
    const o = await p;
    expect(o).toMatchObject({ kind: 'rejected', status: 413 });
    expect(failureOf(o as Exclude<UploadOutcome, { kind: 'uploaded' }>)).toBe('too_large');
    const y = fakeXhr();
    const q = uploadEvidenceFile({ url: '/u', file: F, requestId: R1, onProgress: () => {}, xhrFactory: () => y as unknown as XMLHttpRequest });
    y.respond(200, '<html>');
    expect(await q).toEqual({ kind: 'not_uploaded', reason: 'network' });
  });

  it('UX-30: every refusal maps to its failure', () => {
    const rej = (status: number, code: string) => failureOf({ kind: 'rejected', status, body: { error: 'x', code } });
    expect([
      rej(400, 'unsupported_file_type'), rej(429, 'rate_limited'), rej(413, 'storage_full'), rej(409, 'project_archived'),
      rej(403, 'forbidden'), rej(401, 'unauthenticated'), rej(500, 'integrity_failure'), rej(503, 'database_unavailable'),
      failureOf({ kind: 'not_uploaded', reason: 'network' }), failureOf({ kind: 'not_uploaded', reason: 'stalled' }),
    ]).toEqual(['wrong_type', 'rate_limited', 'storage_full', 'archived', 'role_changed', 'signed_out', 'cut_off', 'cut_off', 'cut_off', 'cut_off']);
  });

  it('FR-EVD-03: a link is posted as JSON to the given url and its 201 is uploaded', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = (async (u: string, init?: RequestInit) => { calls.push([u, init]); return new Response(JSON.stringify(VIEW), { status: 201, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    const body = { requestId: R1, kind: 'link' as const, url: 'https://example.org/x', label: null };
    expect(await postEvidenceLink({ url: '/u', body, fetchImpl })).toEqual({ kind: 'uploaded', status: 201, item: VIEW });
    expect(calls[0][0]).toBe('/u');
    expect(JSON.parse(calls[0][1]!.body as string)).toEqual(body);
    const refused = (async () => new Response(JSON.stringify({ error: 'Validation failed', code: 'validation', fields: [] }), { status: 422, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    expect(await postEvidenceLink({ url: '/u', body, fetchImpl: refused })).toMatchObject({ kind: 'rejected', status: 422 });
  });
});
