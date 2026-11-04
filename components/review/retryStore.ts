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
export const sealRetryKey = (reviewId: string) => `makrai.retry.v1:seal:${reviewId}`;
export const openRetryKey = (projectId: string) => `makrai.retry.v1:open:${projectId}`;

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
    return typeof requestId === 'string' && typeof sentBody === 'string' ? { requestId, sentBody } : NONE;
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
