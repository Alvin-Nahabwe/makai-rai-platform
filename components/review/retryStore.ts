import type { RetryState } from '@/lib/client/retrySafeWrite';

/**
 * The request id of a write whose reply was lost, kept in this tab's sessionStorage so that a reload replays it
 * instead of writing again (C4 ruling on hunter H1; FR-DEC-07). S-17 keeps one per review: the id is reused for the
 * next press whatever number the page now shows, since a lost seal usually landed and the page then shows the next
 * number; the server replays the first seal (200) or, if nothing landed, writes it. The open form keeps one per
 * project; `requestIdFor` reuses it only for the same stage and note. Cleared on a 201 or a 200 replay, and when a
 * number another write took makes a new id necessary. A storage that is missing, blocked or holds a damaged value
 * reads as no stored state: the page then keeps its id in memory only, as before (no persistence, never a throw).
 */
export type RetryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const NONE: RetryState = { requestId: null, sentBody: null };
/** Per signed-in account (C4 round 3, F1): another account signing in in this tab must never send this one's id. */
export const sealRetryKey = (userId: string, reviewId: string) => `makrai.retry.v1:seal:${userId}:${reviewId}`;
export const openRetryKey = (userId: string, projectId: string) => `makrai.retry.v1:open:${userId}:${projectId}`;
/** An 8-4-4-4-12 hex request id, as the routes accept (lib/data/idempotency.ts isRequestId; not imported: a server module). */
const REQUEST_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** This tab's sessionStorage, or null where reading the property itself throws (blocked site data) or there is none. */
export function sessionRetryStorage(): RetryStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function loadRetry(storage: RetryStorage | null, key: string): RetryState {
  if (storage === null) return NONE;
  try {
    const v: unknown = JSON.parse(storage.getItem(key) ?? 'null');
    if (typeof v !== 'object' || v === null) return NONE;
    const { requestId, sentBody } = v as Record<string, unknown>;
    // A requestId the route would refuse (not a UUID) is no stored state, so it cannot lock the page (C4 round 3, F3).
    return typeof requestId === 'string' && REQUEST_ID.test(requestId) && typeof sentBody === 'string' ? { requestId, sentBody } : NONE;
  } catch {
    return NONE;   // a damaged value or a blocked storage: nothing stored
  }
}

export function saveRetry(storage: RetryStorage | null, key: string, state: RetryState): void {
  try {
    storage?.setItem(key, JSON.stringify(state));
  } catch {
    // A full or blocked storage: the id stays in memory only, so Retry on this page still replays.
  }
}

export function clearRetry(storage: RetryStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // A blocked storage holds nothing of ours to clear.
  }
}

/**
 * What happens to the stored id after a reply (C4 round 3, F2): cleared once the write is known (a seal or review in a
 * 2xx), and when the id can no longer succeed (another write took the number; the id was used for another request or
 * account); kept while the write may still have landed (a lost reply, a 2xx that is not the object, a server failure)
 * and on a refusal the same id may meet again (a role or archive change cannot make a new id succeed either).
 */
export function retryAfter(o: { kind: 'saved'; bodyOk: boolean } | { kind: 'not_saved' } | { kind: 'rejected'; status: number; code: string }): 'clear' | 'keep' {
  if (o.kind === 'saved') return o.bodyOk ? 'clear' : 'keep';
  if (o.kind === 'not_saved') return 'keep';
  return o.code === 'number_taken' || o.code === 'request_id_reused' ? 'clear' : 'keep';
}
