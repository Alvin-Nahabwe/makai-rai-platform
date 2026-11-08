import { canonicalJson } from '@/lib/integrity/canonical.mjs';
import type { ApiErrorBody } from '@/types/api';

/**
 * The client half of a retry-safe write (NFR-INT-02, UX-27, FR-DEC-07). Plain TypeScript with no React and
 * no server import, so client components import it.
 *
 * A write carries a request id. The server returns the first result for the same id and the same body, and
 * answers 409 `request_id_reused` for the same id with another body, so the page must send the SAME id
 * when the person presses Retry on an unchanged request and a NEW id once the draft changed after a send.
 */

/** Without a reply for this long the page shows M-02 ("still saving"). */
export const SLOW_MS = 10_000;
/** Without a reply for this long the page stops waiting and shows M-06 ("not saved"). */
export const TIMEOUT_MS = 30_000;

/** The id last sent for a draft and the body it was sent with, without `requestId` (canonical JSON). */
export type RetryState = { requestId: string | null; sentBody: string | null };

/** What the body is, as the server will receive it: JSON-safe, and without the id itself. */
function bodyKey(body: Record<string, unknown>): string {
  // The round trip through JSON is what `sendWrite` transmits: a property that is `undefined` is not sent,
  // so it must not make two equal requests differ, and `canonicalJson` refuses `undefined`.
  const { requestId: _requestId, ...rest } = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  return canonicalJson(rest);
}

/**
 * The id to send for `body`: `state.requestId` again when the body is the one that id was sent with (an
 * unchanged retry), otherwise a new id. Returns the id and the state to keep for the next press.
 */
export function requestIdFor(
  state: RetryState,
  body: Record<string, unknown>,
  newId: () => string = () => crypto.randomUUID(),
): { requestId: string; state: RetryState } {
  const sentBody = bodyKey(body);
  const requestId = state.requestId !== null && state.sentBody === sentBody ? state.requestId : newId();
  return { requestId, state: { requestId, sentBody } };
}

export type SendOutcome<T> =
  | { kind: 'saved'; status: number; body: T }
  | { kind: 'rejected'; status: number; body: ApiErrorBody }
  | { kind: 'not_saved'; reason: 'timeout' | 'network' };

function isApiErrorBody(v: unknown): v is ApiErrorBody {
  return typeof v === 'object' && v !== null
    && typeof (v as ApiErrorBody).error === 'string' && typeof (v as ApiErrorBody).code === 'string';
}

/**
 * Sends one write and says what became of it. `saved` is a 2xx reply that is JSON, or a 204 (`body` is
 * `undefined` for 204), and was not reached through a redirect;
 * `rejected` is the API's own error body; `not_saved` is "we do not know it was saved": no reply within
 * `timeoutMs` (the request is aborted), a network failure, or any other reply (a gateway page, a redirect,
 * an unreadable or empty body say nothing about whether the write happened). In all three the person may press
 * Retry with the same id and nothing is written twice. `onSlow` is called once if there is no reply after
 * `slowMs`.
 */
export async function sendWrite<T>(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body: Record<string, unknown>,
  opts: { onSlow: () => void; fetchImpl?: typeof fetch; slowMs?: number; timeoutMs?: number },
): Promise<SendOutcome<T>> {
  const doFetch = opts.fetchImpl ?? fetch;
  // Outside every try: a body that cannot be written as JSON is the caller's bug, not a failed connection.
  const payload = JSON.stringify(body);
  const controller = new AbortController();
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  // The timeout is raced as well as signalled: a fetch that ignores its signal must not hold the page.
  const timedOut = new Promise<SendOutcome<T>>((resolve) => {
    timeoutTimer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'not_saved', reason: 'timeout' });
    }, opts.timeoutMs ?? TIMEOUT_MS);
  });
  const slowTimer = setTimeout(opts.onSlow, opts.slowMs ?? SLOW_MS);

  const attempt = (async (): Promise<SendOutcome<T>> => {
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: controller.signal,
      });
    } catch {
      // An abort by the timer is answered by `timedOut` first; anything else is a failed connection.
      return { kind: 'not_saved', reason: 'network' };
    }
    const text = await res.text().catch(() => '');
    // `null` when the reply is not JSON; an empty reply (204) is JSON with no value.
    let json: { value: unknown } | null;
    try {
      json = { value: text === '' ? undefined : JSON.parse(text) };
    } catch {
      json = null;
    }
    // Saved only on a real reply: 204, or JSON with a value. A page, an empty 200 or a redirected GET that
    // landed on a 200 says nothing about what the server wrote, and the draft is deleted on "saved".
    if (res.ok && !res.redirected && json !== null && (res.status === 204 || json.value !== undefined)) {
      return { kind: 'saved', status: res.status, body: json.value as T };
    }
    if (json !== null && isApiErrorBody(json.value)) return { kind: 'rejected', status: res.status, body: json.value };
    return { kind: 'not_saved', reason: 'network' };
  })();

  try {
    return await Promise.race([attempt, timedOut]);
  } finally {
    clearTimeout(slowTimer);
    clearTimeout(timeoutTimer);
  }
}
