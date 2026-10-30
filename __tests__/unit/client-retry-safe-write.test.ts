import { describe, it, expect, vi, afterEach } from 'vitest';
import { requestIdFor, sendWrite, SLOW_MS, TIMEOUT_MS } from '@/lib/client/retrySafeWrite';

afterEach(() => vi.useRealTimers());

/** A fetch that never answers and rejects with an AbortError when its signal aborts, as the platform's does. */
const neverAnswers: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
});
/** A fetch that never answers and ignores its signal. */
const deaf: typeof fetch = () => new Promise(() => {});
const answers = (status: number, body: unknown, raw?: string): typeof fetch => () =>
  Promise.resolve(new Response(raw ?? (body === undefined ? null : JSON.stringify(body)), { status }));

describe('requestIdFor', () => {
  it('UX-27 FR-DEC-07 (helper): an unchanged retry reuses the id; an edit after a send makes a new one', () => {
    const ids = ['r1', 'r2']; const next = () => ids.shift()!;
    const a = requestIdFor({ requestId: null, sentBody: null }, { reason: 'x' }, next);
    const b = requestIdFor(a.state, { reason: 'x', requestId: a.requestId }, next);
    const c = requestIdFor(b.state, { reason: 'y', requestId: b.requestId }, next);
    expect([a.requestId, b.requestId, c.requestId]).toEqual(['r1', 'r1', 'r2']);
  });

  it('UX-27 (helper): key order, a missing optional field and the id in the body do not make a different request', () => {
    const next = () => { throw new Error('a new id was made'); };
    const first = requestIdFor({ requestId: null, sentBody: null }, { b: 1, a: 'x', c: undefined }, () => 'r1');
    expect(first.state).toEqual({ requestId: 'r1', sentBody: '{"a":"x","b":1}' });
    expect(requestIdFor(first.state, { a: 'x', b: 1 }, next).requestId).toBe('r1');
    expect(requestIdFor(first.state, { b: 1, requestId: 'r1', a: 'x' }, next).requestId).toBe('r1');
    expect(requestIdFor(first.state, { b: 2, a: 'x' }, () => 'r2').requestId).toBe('r2');
  });

  it('UX-27 (helper): the state of an id that was never sent has no body, so the first call makes an id; the default id is a UUID', () => {
    const r = requestIdFor({ requestId: null, sentBody: null }, { a: 1 });
    expect(r.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // an id with no body to compare is not reused
    expect(requestIdFor({ requestId: 'old', sentBody: null }, { a: 1 }, () => 'new').requestId).toBe('new');
  });
});

describe('sendWrite', () => {
  it('UX-27 (helper): M-02 after 10 seconds without a reply, not saved after 30', async () => {
    vi.useFakeTimers(); const onSlow = vi.fn();
    const p = sendWrite('/x', 'POST', { requestId: 'r1' }, { onSlow, fetchImpl: neverAnswers });
    await vi.advanceTimersByTimeAsync(10_000); expect(onSlow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000); await expect(p).resolves.toEqual({ kind: 'not_saved', reason: 'timeout' });
  });

  it('UX-27 (helper): the limits are 10 and 30 seconds, and a fetch that ignores its signal still times out', async () => {
    expect([SLOW_MS, TIMEOUT_MS]).toEqual([10_000, 30_000]);
    vi.useFakeTimers(); const onSlow = vi.fn();
    const p = sendWrite('/x', 'POST', {}, { onSlow, fetchImpl: deaf, slowMs: 5, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(5); expect(onSlow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(45); await expect(p).resolves.toEqual({ kind: 'not_saved', reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(1_000); expect(onSlow).toHaveBeenCalledTimes(1);
  });

  it('UX-27 (helper): a reply before the slow limit never calls onSlow, and no timer is left running', async () => {
    vi.useFakeTimers(); const onSlow = vi.fn();
    const out = await sendWrite('/x', 'POST', { requestId: 'r1' }, { onSlow, fetchImpl: answers(201, { id: 'v1' }) });
    expect(out).toEqual({ kind: 'saved', status: 201, body: { id: 'v1' } });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000); expect(onSlow).not.toHaveBeenCalled();
  });

  it('UX-27 FR-DEC-07 (helper): the request is JSON with the method, the url and the body as given', async () => {
    const seen: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = (url, init) => { seen.push({ url, init }); return Promise.resolve(new Response('{}', { status: 200 })); };
    await sendWrite('/api/v1/orgs/a/projects/p/decisions', 'PATCH', { requestId: 'r1', n: 2 }, { onSlow: () => {}, fetchImpl });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/api/v1/orgs/a/projects/p/decisions');
    expect(seen[0].init).toMatchObject({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"requestId":"r1","n":2}' });
  });

  it('UX-27 (helper): a 4xx or 5xx with an error body is rejected with that body; 204 is saved with no body', async () => {
    const conflict = { error: 'Conflict', code: 'base_version_moved', current: { versionNumber: 3 } };
    expect(await sendWrite('/x', 'POST', {}, { onSlow: () => {}, fetchImpl: answers(409, conflict) })).toEqual({ kind: 'rejected', status: 409, body: conflict });
    const down = { error: 'Service unavailable', code: 'database_unavailable' };
    expect(await sendWrite('/x', 'POST', {}, { onSlow: () => {}, fetchImpl: answers(503, down) })).toEqual({ kind: 'rejected', status: 503, body: down });
    expect(await sendWrite('/x', 'DELETE', {}, { onSlow: () => {}, fetchImpl: answers(204, undefined) })).toEqual({ kind: 'saved', status: 204, body: undefined });
  });

  it('UX-27 (helper): a network failure, and an error reply that is not an API error, are not saved', async () => {
    const offline: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await sendWrite('/x', 'POST', {}, { onSlow: () => {}, fetchImpl: offline })).toEqual({ kind: 'not_saved', reason: 'network' });
    // a gateway page in place of the API's answer says nothing about whether the write happened
    expect(await sendWrite('/x', 'POST', {}, { onSlow: () => {}, fetchImpl: answers(502, undefined, '<html>Bad gateway</html>') })).toEqual({ kind: 'not_saved', reason: 'network' });
    expect(await sendWrite('/x', 'POST', {}, { onSlow: () => {}, fetchImpl: answers(500, undefined, '{"nope":1}') })).toEqual({ kind: 'not_saved', reason: 'network' });
  });

  it('UX-27 (helper): a 2xx is saved only when it is a real reply: JSON with a value, or 204; a page, an empty 200 or a redirect is not', async () => {
    const html = await sendWrite('/x', 'POST', {}, { onSlow: () => {}, fetchImpl: answers(200, undefined, '<html>Please sign in</html>') });
    expect(html).toEqual({ kind: 'not_saved', reason: 'network' });
    expect(await sendWrite('/x', 'POST', {}, { onSlow: () => {}, fetchImpl: answers(200, undefined, '') })).toEqual({ kind: 'not_saved', reason: 'network' });
    // fetch follows a redirect and a POST to a login page becomes a GET that answers 200: nothing was written
    const redirected: typeof fetch = () => {
      const res = new Response('{"fake":"page-as-json"}', { status: 200 });
      Object.defineProperty(res, 'redirected', { value: true });
      return Promise.resolve(res);
    };
    expect(await sendWrite('/x', 'POST', {}, { onSlow: () => {}, fetchImpl: redirected })).toEqual({ kind: 'not_saved', reason: 'network' });
    // a body that cannot be read says nothing about what the server wrote
    const unreadable: typeof fetch = () => Promise.resolve({ ok: true, status: 201, redirected: false, text: () => Promise.reject(new TypeError('terminated')) } as unknown as Response);
    expect(await sendWrite('/x', 'POST', {}, { onSlow: () => {}, fetchImpl: unreadable })).toEqual({ kind: 'not_saved', reason: 'network' });
    expect(await sendWrite('/x', 'POST', {}, { onSlow: () => {}, fetchImpl: answers(201, { id: 'v1' }) })).toEqual({ kind: 'saved', status: 201, body: { id: 'v1' } });
  });

  it('UX-27 (helper): a body that cannot be written as JSON is the caller\'s bug and throws, with no request sent and no timer left', async () => {
    vi.useFakeTimers(); const onSlow = vi.fn(); const fetchImpl = vi.fn();
    await expect(sendWrite('/x', 'POST', { n: BigInt(1) }, { onSlow, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(TypeError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('UX-27 (helper): a fetch that throws at once, or rejects, is a network failure', async () => {
    const throwsNow: typeof fetch = () => { throw new TypeError('Failed to parse URL'); };
    expect(await sendWrite('/x', 'POST', {}, { onSlow: () => {}, fetchImpl: throwsNow })).toEqual({ kind: 'not_saved', reason: 'network' });
  });

  it('UX-27 (helper): a late reply after the timeout changes nothing', async () => {
    vi.useFakeTimers();
    let release!: (r: Response) => void;
    const slowFetch: typeof fetch = () => new Promise((resolve) => { release = resolve; });
    const p = sendWrite('/x', 'POST', {}, { onSlow: () => {}, fetchImpl: slowFetch, slowMs: 1, timeoutMs: 2 });
    await vi.advanceTimersByTimeAsync(5);
    release(new Response('{"id":"late"}', { status: 201 }));
    await expect(p).resolves.toEqual({ kind: 'not_saved', reason: 'timeout' });
  });
});
