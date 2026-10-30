import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  draftKey, openDraftStore, DRAFT_PREFIX, DRAFT_TTL_DAYS, type DraftKey, type StoredDraft,
} from '@/lib/client/drafts';

/** A `Map`-backed Storage. */
function fakeStorage(): Storage & { keys(): string[] } {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
    keys: () => [...m.keys()],
  };
}
/** A Storage on which every call throws, as a browser with storage blocked does. */
function throwingStorage(): Storage {
  const boom = () => { throw new DOMException('blocked', 'SecurityError'); };
  return { get length(): number { return boom(); }, key: boom, getItem: boom, setItem: boom, removeItem: boom, clear: boom };
}
/** A Storage that works until `breakNow()`, as one does when the quota fills or the site data is cleared. */
function flakyStorage(): Storage & { breakNow(): void } {
  const inner = fakeStorage();
  let broken = false;
  const guard = <A extends unknown[], R>(f: (...a: A) => R) => (...a: A): R => {
    if (broken) throw new DOMException('gone', 'QuotaExceededError');
    return f(...a);
  };
  return {
    get length(): number { if (broken) throw new DOMException('gone', 'QuotaExceededError'); return inner.length; },
    key: guard(inner.key), getItem: guard(inner.getItem), setItem: guard(inner.setItem),
    removeItem: guard(inner.removeItem), clear: guard(inner.clear), breakNow: () => { broken = true; },
  };
}

/** `base` with some keys' reads or removals failing, as an unreadable entry or a locked record does. */
function withFaults(
  base: ReturnType<typeof fakeStorage>, faults: { get?: (key: string) => boolean; remove?: (key: string) => boolean },
): Storage & { keys(): string[] } {
  return {
    get length() { return base.length; },
    key: (i: number) => base.key(i),
    getItem: (k: string) => { if (faults.get?.(k)) throw new DOMException('unreadable', 'InvalidStateError'); return base.getItem(k); },
    setItem: (k: string, v: string) => base.setItem(k, v),
    removeItem: (k: string) => { if (faults.remove?.(k)) throw new DOMException('locked', 'InvalidStateError'); base.removeItem(k); },
    clear: () => base.clear(),
    keys: () => base.keys(),
  };
}

const NOW = new Date('2026-11-02T09:00:00Z');
const K = (userId: string, q = 'Q-PP-01'): DraftKey => ({ userId, orgId: 'o1', projectId: 'p1', target: { kind: 'question', questionId: q } });
const draft = (o: Partial<StoredDraft<unknown>> = {}): StoredDraft<unknown> => ({
  baseVersionNumber: 2, value: { status: 'partly', reason: 'half way' }, savedAt: '2026-11-02T08:00:00.000Z',
  savePressedAt: null, retry: { requestId: null, sentBody: null }, ...o,
});

afterEach(() => vi.unstubAllGlobals());

describe('client drafts (UX-26, NFR-PRIV-06)', () => {
  it('UX-26 (helper): the key holds account, organisation, project and question; the base version is inside the value', () => {
    expect(draftKey(K('u1'))).toBe('makrai.draft.v1:u1:o1:p1:q:Q-PP-01');
    expect(draftKey({ ...K('u1'), target: { kind: 'mitigation', findingId: 'f1', mitigationId: null } })).toBe('makrai.draft.v1:u1:o1:p1:m:f1:new');
    expect(draftKey({ ...K('u1'), target: { kind: 'mitigation', findingId: 'f1', mitigationId: 'm9' } })).toBe('makrai.draft.v1:u1:o1:p1:m:f1:m9');
    expect([DRAFT_PREFIX, DRAFT_TTL_DAYS]).toEqual(['makrai.draft.v1:', 7]);
    const s = fakeStorage();
    openDraftStore(s)!.write(K('u1'), draft({ baseVersionNumber: 4 }));
    expect(JSON.parse(s.getItem('makrai.draft.v1:u1:o1:p1:q:Q-PP-01')!)).toMatchObject({ baseVersionNumber: 4 });
  });

  it('UX-26 NFR-PRIV-06 (helper): drafts of another account are never read and are purged', () => {
    const s = openDraftStore(fakeStorage())!;
    s.write(K('a'), draft({ savedAt: '2026-11-02T08:00:00.000Z' }));
    expect(s.read({ ...K('a'), userId: 'b' }, NOW)).toBeNull();
    expect(s.list('b', NOW)).toEqual([]);
    expect(s.purgeOtherAccounts('b')).toBe(1);
    expect(s.list('a', NOW)).toEqual([]);
  });

  it('UX-26 NFR-PRIV-06 (helper): a draft older than 7 days is dropped and listed ones say kept until', () => {
    const s = openDraftStore(fakeStorage())!;
    s.write(K('a'), draft({ savedAt: '2026-11-02T08:00:00.000Z' }));
    expect(s.list('a', new Date('2026-11-05T00:00:00Z'))[0].keptUntil).toBe('2026-11-09');
    expect(s.read(K('a'), new Date('2026-11-10T00:00:00Z'))).toBeNull();
  });

  it('UX-26 (helper): unavailable storage gives no store, and a store whose storage starts throwing acts as empty', () => {
    expect(openDraftStore(null)).toBeNull();
    expect(openDraftStore(throwingStorage())).toBeNull();
    const flaky = flakyStorage(); const s = openDraftStore(flaky)!; flaky.breakNow();
    expect(() => s.write(K('a'), draft())).not.toThrow();
    expect(s.count('a', NOW)).toBe(0);
  });

  it('UX-26 (helper): without an argument the store is the browser\'s localStorage, and none where there is none', () => {
    expect(openDraftStore()).toBeNull(); // the node test environment has no localStorage
    const local = fakeStorage();
    vi.stubGlobal('localStorage', local);
    openDraftStore()!.write(K('a'), draft());
    expect(local.keys()).toEqual(['makrai.draft.v1:a:o1:p1:q:Q-PP-01']);
    // a localStorage whose very access throws (a blocked site) is no store, not an exception
    vi.stubGlobal('localStorage', undefined);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
    expect(openDraftStore()).toBeNull();
  });

  it('UX-26 (helper): a write is read back whole, and the probe the store makes leaves nothing behind', () => {
    const storage = fakeStorage();
    const s = openDraftStore(storage)!;
    expect(storage.keys()).toEqual([]);
    const d = draft({ savePressedAt: '2026-11-02T08:30:00.000Z', retry: { requestId: 'r1', sentBody: '{"a":1}' }, baseVersionNumber: null });
    s.write(K('a'), d);
    expect(s.read(K('a'), NOW)).toEqual(d);
    expect(s.read(K('a', 'Q-PP-02'), NOW)).toBeNull();
    s.remove(K('a'));
    expect(s.read(K('a'), NOW)).toBeNull();
    expect(storage.keys()).toEqual([]);
  });

  it('UX-26 (helper): a mitigation draft and a question draft of one account are two drafts, listed with their keys', () => {
    const s = openDraftStore(fakeStorage())!;
    const mk: DraftKey = { ...K('a'), target: { kind: 'mitigation', findingId: 'f1', mitigationId: null } };
    s.write(K('a'), draft({ savedAt: '2026-11-02T07:00:00.000Z' }));
    s.write(mk, draft({ savedAt: '2026-11-02T08:00:00.000Z' }));
    const listed = s.list('a', NOW);
    expect(listed.map((l) => l.key)).toEqual([mk, K('a')]); // newest first
    expect(s.count('a', NOW)).toBe(2);
  });

  it('UX-26 (helper): list and count filter by organisation and project, and never cross accounts', () => {
    const s = openDraftStore(fakeStorage())!;
    s.write({ ...K('a'), orgId: 'o1', projectId: 'p1' }, draft());
    s.write({ ...K('a', 'Q-PP-02'), orgId: 'o1', projectId: 'p2' }, draft());
    s.write({ ...K('a', 'Q-PP-03'), orgId: 'o2', projectId: 'p3' }, draft());
    s.write(K('b'), draft());
    expect(s.count('a', NOW)).toBe(3);
    expect(s.count('a', NOW, { orgId: 'o1' })).toBe(2);
    expect(s.count('a', NOW, { orgId: 'o1', projectId: 'p2' })).toBe(1);
    expect(s.count('a', NOW, { projectId: 'p9' })).toBe(0);
    expect(s.count('b', NOW)).toBe(1);
  });

  it('UX-26 NFR-PRIV-06 (helper): purgeAccount removes one account\'s drafts, purgeOtherAccounts keeps only one, purgeExpired drops the old', () => {
    const storage = fakeStorage();
    const s = openDraftStore(storage)!;
    s.write(K('a'), draft());
    s.write(K('a', 'Q-PP-02'), draft({ savedAt: '2026-10-01T00:00:00.000Z' }));
    s.write(K('b'), draft());
    storage.setItem('unrelated', 'kept');
    expect(s.purgeExpired(NOW)).toBe(1);
    expect(s.count('a', NOW)).toBe(1);
    expect(s.purgeAccount('a')).toBe(1);
    expect(s.count('a', NOW)).toBe(0);
    expect(s.count('b', NOW)).toBe(1);
    s.write(K('c'), draft());
    expect(s.purgeOtherAccounts('c')).toBe(1);
    expect(storage.keys().sort()).toEqual(['makrai.draft.v1:c:o1:p1:q:Q-PP-01', 'unrelated']);
  });

  it('NFR-PRIV-06 (helper): a draft is kept up to seven days and dropped after, and a draft from the future is kept', () => {
    const s = openDraftStore(fakeStorage())!;
    s.write(K('a'), draft({ savedAt: '2026-11-02T08:00:00.000Z' }));
    expect(s.read(K('a'), new Date('2026-11-09T08:00:00.000Z'))).not.toBeNull();
    expect(s.read(K('a'), new Date('2026-11-09T08:00:00.001Z'))).toBeNull();
    s.write(K('a', 'Q-PP-02'), draft({ savedAt: '2027-01-01T00:00:00.000Z' }));
    expect(s.read(K('a', 'Q-PP-02'), NOW)).not.toBeNull();
  });

  it('UX-26 (helper): a value that is not a draft reads as absent, is not listed, and is cleared by purgeExpired', () => {
    const storage = fakeStorage();
    const s = openDraftStore(storage)!;
    const key = draftKey(K('a'));
    for (const junk of ['not json', 'null', '[]', '{"savedAt":"2026-11-02T08:00:00.000Z"}', JSON.stringify({ ...draft(), savedAt: 'yesterday' }),
      JSON.stringify({ ...draft(), retry: 'r1' }), JSON.stringify({ ...draft(), baseVersionNumber: '2' })]) {
      storage.setItem(key, junk);
      expect(s.read(K('a'), NOW), junk).toBeNull();
      expect(s.list('a', NOW), junk).toEqual([]);
    }
    expect(s.purgeExpired(NOW)).toBe(1);
    expect(storage.keys()).toEqual([]);
  });

  it('UX-26 NFR-PRIV-06 (helper): another account\'s drafts cannot be read by an id that merely starts with this one\'s', () => {
    const s = openDraftStore(fakeStorage())!;
    s.write(K('user-1'), draft());
    s.write(K('user-10'), draft());
    expect(s.count('user-1', NOW)).toBe(1);
    expect(s.count('user-10', NOW)).toBe(1);
    expect(s.purgeOtherAccounts('user-1')).toBe(1);
    expect(s.count('user-10', NOW)).toBe(0);
    expect(s.count('user-1', NOW)).toBe(1);
  });

  it('NFR-PRIV-06 (helper): an empty account id reads nothing and purges nothing', () => {
    const s = openDraftStore(fakeStorage())!;
    s.write(K('a'), draft());
    expect(s.read(K(''), NOW)).toBeNull();
    expect(s.list('', NOW)).toEqual([]);
    expect(s.purgeOtherAccounts('')).toBe(0);
    expect(s.purgeAccount('')).toBe(0);
    expect(s.count('a', NOW)).toBe(1);
  });

  it('UX-26 (helper): one draft that cannot be read does not hide the account\'s others, and a draft too far in the future to date is ignored', () => {
    const base = fakeStorage();
    const wrapped = withFaults(base, { get: (k) => k.endsWith(':Q-PP-02') });
    const s = openDraftStore(wrapped)!;
    s.write(K('a'), draft());
    s.write(K('a', 'Q-PP-02'), draft());
    s.write(K('a', 'Q-PP-03'), draft({ savedAt: '+275760-09-13T00:00:00.000Z' })); // the largest date there is: seven more days is not a date
    s.write(K('a', 'Q-PP-04'), draft());
    expect(s.list('a', NOW).map((l) => (l.key.target as { questionId: string }).questionId)).toEqual(['Q-PP-01', 'Q-PP-04']);
    expect(s.count('a', NOW)).toBe(2);
    expect(s.read(K('a', 'Q-PP-02'), NOW)).toBeNull();
  });

  it('NFR-PRIV-06 (helper): a purge removes what it can when one removal fails, and says how many it removed', () => {
    const base = fakeStorage();
    const wrapped = withFaults(base, { remove: (k) => k.endsWith(':Q-PP-02') });
    const s = openDraftStore(wrapped)!;
    for (const q of ['Q-PP-01', 'Q-PP-02', 'Q-PP-03']) s.write(K('a', q), draft());
    s.write(K('b'), draft());
    expect(s.purgeOtherAccounts('b')).toBe(2);
    expect(base.keys().sort()).toEqual(['makrai.draft.v1:a:o1:p1:q:Q-PP-02', 'makrai.draft.v1:b:o1:p1:q:Q-PP-01']);
  });

  it('UX-26 (helper): a draft whose value cannot be written as JSON is the caller\'s bug and throws, with the older draft left as it was', () => {
    const s = openDraftStore(fakeStorage())!;
    s.write(K('a'), draft({ value: 'first' }));
    expect(() => s.write(K('a'), draft({ value: BigInt(1) }))).toThrow(TypeError);
    expect(s.read(K('a'), NOW)?.value).toBe('first');
  });

  it('UX-26 (helper): every method acts as absent when the storage throws mid-use', () => {
    const flaky = flakyStorage();
    const s = openDraftStore(flaky)!;
    s.write(K('a'), draft());
    flaky.breakNow();
    expect(s.read(K('a'), NOW)).toBeNull();
    expect(s.list('a', NOW)).toEqual([]);
    expect(s.count('a', NOW)).toBe(0);
    expect(() => s.remove(K('a'))).not.toThrow();
    expect([s.purgeOtherAccounts('b'), s.purgeAccount('a'), s.purgeExpired(NOW)]).toEqual([0, 0, 0]);
  });
});
