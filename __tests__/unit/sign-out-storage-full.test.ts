import { afterEach, expect, it, vi } from 'vitest';

/**
 * Lead's ruling L5-24 (silent-failure review d1-sfh-r1, F2): when the draft store's chunk loads but refuses to open (its
 * probe write fails: storage full, or blocked writes), signOutClearingDrafts still removes this account's drafts, with
 * the same direct sweep it uses when the chunk cannot load. M-41 promised that deletion before the press.
 */
const signOut = vi.fn(async () => ({ url: 'http://localhost/login' }));

afterEach(() => {
  vi.doUnmock('@/lib/client/drafts');
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('L5-24: a full storage (store null) still removes this account\'s drafts, and only this account\'s, before signOut', async () => {
  const keys = new Map<string, string>([
    ['makrai.draft.v1:u-1:o:p:q:Q-PP-01', '{}'], ['makrai.draft.v1:u-1:o:p:m:f:new', '{}'],
    ['makrai.draft.v1:u-2:o:p:q:Q-PP-01', '{}'], ['other', 'kept'],
  ]);
  let atSignOut: string[] = [];
  signOut.mockImplementationOnce(async () => { atSignOut = [...keys.keys()].sort(); return { url: 'http://localhost/login' }; });
  vi.stubGlobal('window', { location: { href: '', reload: () => {} } });
  vi.stubGlobal('localStorage', {
    get length() { return keys.size; },
    key: (i: number) => [...keys.keys()][i] ?? null,
    removeItem: (k: string) => { keys.delete(k); },
    setItem: () => { throw new Error('QuotaExceededError'); },
  });
  vi.resetModules();
  vi.doMock('next-auth/react', () => ({ signOut }));
  vi.doMock('@/lib/client/drafts', () => ({ openDraftStore: () => null }));
  const { signOutClearingDrafts } = await import('@/lib/client/signOutClearingDrafts');
  await signOutClearingDrafts('u-1', '/login');
  expect(atSignOut).toEqual(['makrai.draft.v1:u-2:o:p:q:Q-PP-01', 'other']);
  expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/login', redirect: false });
});
