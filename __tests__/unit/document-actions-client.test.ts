import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
import type { RetryState } from '@/lib/client/retrySafeWrite';
const A = await import('@/components/documents/DocumentActions');
const { withdrawSend, copyDocumentText } = A;

/**
 * The client outcomes of "Withdraw document" and "Copy as text" (UX-27, M-06, FR-DOC-06, FR-DOC-07). The logic sits in two plain functions
 * the component calls (`withdrawSend`, `copyDocumentText`), so it is driven here with a stubbed `fetch` through the real `sendWrite` and
 * `requestIdFor`; jsdom is not installed, so the component's own markup is covered by renderToStaticMarkup and the e2e spec.
 */

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const errorBody = (code: string, extra: Record<string, unknown> = {}) => ({ error: code, code, ...extra });
const fakeFetch = (...replies: Array<Response | Error>) => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = replies.shift();
    if (next === undefined) throw new Error('fakeFetch: no reply left');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
};
const NO_RETRY: RetryState = { requestId: null, sentBody: null };
const send = (f: ReturnType<typeof fakeFetch>, retry = NO_RETRY, reason = 'Wrong committee.') =>
  withdrawSend({ orgSlug: 'org-a', documentId: 'doc-1', reason, retry, fetchImpl: f.impl });
const sentBody = (f: ReturnType<typeof fakeFetch>, i: number) => JSON.parse(String(f.calls[i].init?.body)) as { requestId: string; reason: string };

describe('WithdrawConfirm.send outcomes', () => {
  it('UX-27 M-06: a send with no reply says it may have arrived, offers Retry, and Retry resends the same request id', async () => {
    const f = fakeFetch(new TypeError('network down'), json(201, { id: 'doc-1' }));
    const first = await send(f);
    expect(first.result).toEqual({ kind: 'refused', line: A.WITHDRAW_LOST, retry: true });
    const second = await send(f, first.retry);
    expect(second.result).toEqual({ kind: 'done' });
    expect(sentBody(f, 1).requestId).toBe(sentBody(f, 0).requestId);
    expect(f.calls[0].url).toBe('/api/v1/orgs/org-a/documents/doc-1/withdrawal');
  });

  it('UX-27: a changed reason takes a new request id', async () => {
    const f = fakeFetch(new TypeError('x'), json(201, { id: 'doc-1' }));
    const first = await send(f, NO_RETRY, 'One.');
    await send(f, first.retry, 'Two.');
    expect(sentBody(f, 1).requestId).not.toBe(sentBody(f, 0).requestId);
  });

  it('FR-DOC-06 (SF-3): 409 already_withdrawn is "someone else withdrew it first", not a success of this person', async () => {
    const r = await send(fakeFetch(json(409, errorBody('already_withdrawn'))));
    expect(r.result).toEqual({ kind: 'taken' });
  });

  it('FR-PRJ-03: 409 project_archived says the project is archived and offers no Retry', async () => {
    const r = await send(fakeFetch(json(409, errorBody('project_archived'))));
    expect(r.result).toMatchObject({ kind: 'refused', retry: false });
    expect((r.result as { line: string }).line).toContain('archived');
  });

  it('UX-27: 401 says the person is signed out, in the literal words, with no Retry', async () => {
    const r = await send(fakeFetch(json(401, errorBody('unauthenticated'))));
    expect(r.result).toEqual({ kind: 'refused', line: 'Not withdrawn: you are signed out. Sign in again, then come back.', retry: false });
    expect(A.WITHDRAW_SIGNED_OUT).toBe('Not withdrawn: you are signed out. Sign in again, then come back.');
  });

  it('FR-AUTHZ-01: 403 says the role no longer allows this, with no Retry', async () => {
    const r = await send(fakeFetch(json(403, errorBody('forbidden'))));
    expect(r.result).toEqual({ kind: 'refused', line: 'Not withdrawn: your role in this organisation no longer allows this. Ask an owner or admin.', retry: false });
  });

  it('FR-DOC-06: 422 shows the server\'s message for the reason, with no Retry', async () => {
    const r = await send(fakeFetch(json(422, errorBody('validation', { fields: [{ field: 'reason', message: 'Write a reason.' }] }))));
    expect(r.result).toEqual({ kind: 'refused', line: 'Write a reason.', retry: false });
  });

  it('UX-27 M-06 (SF-1): a JSON 503 may have landed, so it says so and offers Retry with the same request id', async () => {
    const f = fakeFetch(json(503, errorBody('database_unavailable')), json(201, { id: 'doc-1' }));
    const first = await send(f);
    expect(first.result).toEqual({ kind: 'refused', line: A.WITHDRAW_LOST, retry: true });
    await send(f, first.retry);
    expect(sentBody(f, 1).requestId).toBe(sentBody(f, 0).requestId);
  });

  it('FR-DOC-06: 404 and request_id_reused give the reload line, with no Retry', async () => {
    for (const reply of [json(404, errorBody('not_found')), json(409, errorBody('request_id_reused'))]) {
      expect((await send(fakeFetch(reply))).result).toEqual({ kind: 'refused', line: A.WITHDRAW_OTHER, retry: false });
    }
  });
});

describe('Copy as text outcomes', () => {
  const copy = (f: ReturnType<typeof fakeFetch>, clipboard?: { writeText(t: string): Promise<void> }) =>
    copyDocumentText({ orgSlug: 'org-a', documentId: 'doc-1', fetchImpl: f.impl, clipboard });
  const ok = (text = 'Copy of the data card\n\nBody') => new Response(text, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });

  it('FR-DOC-07: a good answer is written to the clipboard and reported as copied', async () => {
    const written: string[] = [];
    const r = await copy(fakeFetch(ok()), { writeText: async (t) => { written.push(t); } });
    expect(r).toEqual({ kind: 'copied' });
    expect(written).toEqual(['Copy of the data card\n\nBody']);
  });

  it('FR-DOC-07 (SF-2): each refusal names its cause: 401 signed out, 410 erased (and the list refreshes), 429 too many, any other reload', async () => {
    expect(await copy(fakeFetch(json(401, errorBody('unauthenticated'))))).toEqual({ kind: 'refused', line: 'Not copied: you are signed out. Sign in again, then come back.', erased: false });
    expect(await copy(fakeFetch(json(410, errorBody('erased', { erasedOn: '2026-11-04' }))))).toEqual({ kind: 'refused', line: "Not copied: this document's text was erased.", erased: true });
    expect(await copy(fakeFetch(json(429, errorBody('rate_limited', { retryAfterSeconds: 30 }))))).toEqual({ kind: 'refused', line: 'Not copied: too many requests. Wait a minute, then try again.', erased: false });
    for (const status of [403, 404, 500]) {
      expect(await copy(fakeFetch(json(status, errorBody('x'))))).toEqual({ kind: 'refused', line: 'Not copied. Reload the page and try again.', erased: false });
    }
  });

  it('FR-DOC-07: a fetch that throws says the connection was lost', async () => {
    expect(await copy(fakeFetch(new TypeError('offline')))).toEqual({ kind: 'refused', line: 'Not copied: connection lost.', erased: false });
  });

  it('FR-DOC-07 NFR-SEC-11: a clipboard that rejects, or none at all, gives the text for copying by hand', async () => {
    const text = '<script>alert(1)</script>';
    expect(await copy(fakeFetch(ok(text)), { writeText: async () => { throw new DOMException('denied', 'NotAllowedError'); } })).toEqual({ kind: 'fallback', text });
    expect(await copy(fakeFetch(ok(text)), undefined)).toEqual({ kind: 'fallback', text });
  });
});
