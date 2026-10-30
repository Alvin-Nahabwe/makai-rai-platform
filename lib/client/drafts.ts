import { eatDate } from '@/lib/followup/overdue';
import type { CalendarDate, UtcInstant } from '@/types/record';
import type { RetryState } from './retrySafeWrite';

/**
 * The per-account draft store of the browser (UX-26, NFR-PRIV-06, FR-DEC-06). Plain TypeScript with no
 * React and no server import, so client components import it.
 *
 * A draft is what a person typed and has not saved. It lives in the browser's storage under a key that
 * names the account, the organisation, the project and the question or mitigation, so another account on
 * the same browser can neither read it nor, after sign-in, keep it (`purgeOtherAccounts`). A draft not
 * saved for more than seven days is dropped. Storage that is absent, blocked or failing is never an
 * exception: the store acts as if there were no draft, and `openDraftStore` answers `null` when none can
 * be kept at all, so the form can say "This browser cannot keep drafts. Save before leaving this page."
 */

export const DRAFT_PREFIX = 'makrai.draft.v1:';
export const DRAFT_TTL_DAYS = 7;
const DRAFT_TTL_MS = DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000;

export type DraftTarget =
  | { kind: 'question'; questionId: string }
  | { kind: 'mitigation'; findingId: string; mitigationId: string | null };

export interface DraftKey { userId: string; orgId: string; projectId: string; target: DraftTarget }

export interface StoredDraft<V> {
  /** The version the draft was started from; inside the value, never in the key (UX-26). */
  baseVersionNumber: number | null;
  value: V;
  savedAt: UtcInstant;
  savePressedAt: UtcInstant | null;
  retry: RetryState;
}

/** `makrai.draft.v1:<account>:<organisation>:<project>:q:<question>` or `...:m:<finding>:<mitigation or new>`. */
export function draftKey(k: DraftKey): string {
  const head = `${DRAFT_PREFIX}${k.userId}:${k.orgId}:${k.projectId}`;
  return k.target.kind === 'question'
    ? `${head}:q:${k.target.questionId}`
    : `${head}:m:${k.target.findingId}:${k.target.mitigationId ?? 'new'}`;
}

export interface DraftStore {
  read<V>(k: DraftKey, now: Date): StoredDraft<V> | null;
  /**
   * True when the draft was kept. False when the storage refused it (a full quota, blocked site data) or the
   * account id is empty; the form then says "This browser cannot keep drafts. Save before leaving this page."
   * A refused write also removes the older draft under the key (best effort), so a stale one is not restored
   * later as if it were the current one.
   */
  write<V>(k: DraftKey, d: StoredDraft<V>): boolean;
  remove(k: DraftKey): void;
  /** This account's live drafts, newest first. */
  list(userId: string, now: Date, filter?: { orgId?: string; projectId?: string }): Array<{ key: DraftKey; draft: StoredDraft<unknown>; keptUntil: CalendarDate }>;
  count(userId: string, now: Date, filter?: { orgId?: string; projectId?: string }): number;
  /** Removes every draft that is not this account's; returns how many. */
  purgeOtherAccounts(userId: string): number;
  purgeAccount(userId: string): number;
  /** Removes every draft past its seven days, and every value that is not a draft; returns how many. */
  purgeExpired(now: Date): number;
}

const PROBE_KEY = `${DRAFT_PREFIX}probe`;

/** The browser's localStorage, or `null`: reading the property itself throws in a blocked browser. */
function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Parses a storage key back into the key it was made from; `null` unless `draftKey` of the result is the key. */
function parseKey(raw: string): DraftKey | null {
  if (!raw.startsWith(DRAFT_PREFIX)) return null;
  const parts = raw.slice(DRAFT_PREFIX.length).split(':');
  const [userId, orgId, projectId, kind] = parts;
  let target: DraftTarget;
  if (kind === 'q' && parts.length === 5) target = { kind: 'question', questionId: parts[4] };
  else if (kind === 'm' && parts.length === 6) target = { kind: 'mitigation', findingId: parts[4], mitigationId: parts[5] === 'new' ? null : parts[5] };
  else return null;
  const key: DraftKey = { userId, orgId, projectId, target };
  return draftKey(key) === raw ? key : null;
}

/** The latest `savedAt` for which seven days later, and that day in East Africa Time, are still dates. */
const LATEST_SAVED_AT_MS = 8.64e15 - DRAFT_TTL_MS - 24 * 60 * 60 * 1000;
const isDatable = (ms: number): boolean => Number.isFinite(ms) && ms <= LATEST_SAVED_AT_MS;

function isStoredDraft(v: unknown): v is StoredDraft<unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  const retry = d.retry as Record<string, unknown> | null | undefined;
  return (d.baseVersionNumber === null || Number.isInteger(d.baseVersionNumber))
    && 'value' in d
    && typeof d.savedAt === 'string' && isDatable(Date.parse(d.savedAt))
    && (d.savePressedAt === null || typeof d.savePressedAt === 'string')
    && typeof retry === 'object' && retry !== null
    && (retry.requestId === null || typeof retry.requestId === 'string')
    && (retry.sentBody === null || typeof retry.sentBody === 'string');
}

function parseDraft(text: string | null): StoredDraft<unknown> | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isStoredDraft(v) ? v : null;
  } catch {
    return null;
  }
}

const expired = (d: StoredDraft<unknown>, now: Date): boolean => now.getTime() - Date.parse(d.savedAt) > DRAFT_TTL_MS;

/**
 * The store over `storage` (default: the browser's localStorage), or `null` when no draft can be kept: the
 * storage is absent, or a probe write and removal throws (blocked site data, a full quota). A storage that
 * fails later costs a draft, never the page: every call into the storage below is caught on its own, so one
 * unreadable or locked entry leaves the account's other drafts alone. Only the storage calls are caught; a
 * mistake in this module's own code, or a draft value that cannot be written as JSON, is an exception.
 *
 * A key is read back by splitting it on ':', so an id that contains one makes its draft invisible to `list`
 * (ids are cuids and UUIDs). A value that does not have the shape of a `StoredDraft` is treated as absent
 * and `purgeExpired` removes it, so a change to that shape must change `DRAFT_PREFIX` as well.
 */
export function openDraftStore(storage?: Storage | null): DraftStore | null {
  const store = storage === undefined ? browserStorage() : storage;
  if (store === null) return null;
  try {
    store.setItem(PROBE_KEY, '1');
    store.removeItem(PROBE_KEY);
  } catch {
    return null;
  }

  /** `fallback` when the storage call throws: the store acts as if the draft were absent. */
  const attempt = <R>(fallback: R, call: () => R): R => {
    try {
      return call();
    } catch {
      return fallback;
    }
  };
  const getRaw = (key: string): string | null => attempt(null, () => store.getItem(key));
  const setRaw = (key: string, value: string): boolean => attempt(false, () => { store.setItem(key, value); return true; });
  const removeRaw = (key: string): boolean => attempt(false, () => { store.removeItem(key); return true; });

  /** Every storage key in this store's namespace, collected first: removing while iterating shifts indexes. */
  const draftStorageKeys = (): string[] => attempt([], () => {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k !== null && k.startsWith(DRAFT_PREFIX)) keys.push(k);
    }
    return keys;
  });

  /** Removes what it can; the count is the removals that worked. */
  const removeAll = (keys: string[]): number => keys.filter(removeRaw).length;

  const listLive = (userId: string, now: Date, filter?: { orgId?: string; projectId?: string }) => {
    const live: Array<{ key: DraftKey; draft: StoredDraft<unknown>; keptUntil: CalendarDate }> = [];
    if (userId === '') return live;
    for (const raw of draftStorageKeys()) {
      const key = parseKey(raw);
      if (key === null || key.userId !== userId) continue;
      if (filter?.orgId !== undefined && key.orgId !== filter.orgId) continue;
      if (filter?.projectId !== undefined && key.projectId !== filter.projectId) continue;
      const draft = parseDraft(getRaw(raw));
      if (draft === null) continue;
      if (expired(draft, now)) {
        removeRaw(raw);
        continue;
      }
      live.push({ key, draft, keptUntil: eatDate(new Date(Date.parse(draft.savedAt) + DRAFT_TTL_MS)) });
    }
    return live.sort((a, b) => Date.parse(b.draft.savedAt) - Date.parse(a.draft.savedAt) || draftKey(a.key).localeCompare(draftKey(b.key)));
  };

  return {
    read<V>(k: DraftKey, now: Date): StoredDraft<V> | null {
      if (k.userId === '') return null;
      const raw = draftKey(k);
      const draft = parseDraft(getRaw(raw));
      if (draft === null) return null;
      if (expired(draft, now)) {
        removeRaw(raw);
        return null;
      }
      return draft as StoredDraft<V>;
    },
    write<V>(k: DraftKey, d: StoredDraft<V>): boolean {
      if (k.userId === '') return false;
      const key = draftKey(k);
      const text = JSON.stringify(d); // a value that cannot be written as JSON throws here, before the storage is touched
      if (setRaw(key, text)) return true;
      removeRaw(key);
      return false;
    },
    remove(k: DraftKey): void {
      removeRaw(draftKey(k));
    },
    list: listLive,
    count: (userId, now, filter) => listLive(userId, now, filter).length,
    purgeOtherAccounts(userId: string): number {
      // An empty account id is a caller's mistake; deleting everyone's drafts for it is the wrong answer.
      if (userId === '') return 0;
      const mine = `${DRAFT_PREFIX}${userId}:`;
      return removeAll(draftStorageKeys().filter((k) => !k.startsWith(mine)));
    },
    purgeAccount(userId: string): number {
      if (userId === '') return 0;
      const mine = `${DRAFT_PREFIX}${userId}:`;
      return removeAll(draftStorageKeys().filter((k) => k.startsWith(mine)));
    },
    purgeExpired(now: Date): number {
      return removeAll(draftStorageKeys().filter((k) => {
        const draft = parseDraft(getRaw(k));
        return draft === null || expired(draft, now);
      }));
    },
  };
}
