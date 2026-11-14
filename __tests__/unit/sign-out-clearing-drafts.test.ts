import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NFR-PRIV-06 SPEC-1 SO-2 SFH-3 CR-1 SFH-4: the person-started sign-outs of S-04 and S-05 clear this account's drafts,
 * and a draft store that cannot load never stops the sign-out.
 */
const calls: string[] = [];
const signOut = vi.fn(async (o: unknown) => { calls.push(`signOut ${JSON.stringify(o)}`); });

beforeEach(() => {
  calls.length = 0;
  signOut.mockClear();
  vi.resetModules();
  vi.doMock('next-auth/react', () => ({ signOut }));
});
afterEach(() => { vi.doUnmock('@/lib/client/drafts'); });

describe('NFR-PRIV-06 CR-1 SFH-4: signOutClearingDrafts', () => {
  it('NFR-PRIV-06 SPEC-1: the purge runs before signOut, with the callback URL, when the store loads', async () => {
    vi.doMock('@/lib/client/drafts', () => ({
      openDraftStore: () => ({ purgeAccount: (id: string) => { calls.push(`purge ${id}`); } }),
    }));
    const { signOutClearingDrafts } = await import('@/lib/client/signOutClearingDrafts');
    await signOutClearingDrafts('u-1', '/invitations/tok');
    expect(calls).toEqual(['purge u-1', 'signOut {"callbackUrl":"/invitations/tok"}']);
  });

  it('NFR-PRIV-06 CR-1 SFH-4: a draft store whose import rejects still signs out, with the callback URL', async () => {
    vi.doMock('@/lib/client/drafts', () => { throw new Error('ChunkLoadError'); });
    const { signOutClearingDrafts } = await import('@/lib/client/signOutClearingDrafts');
    await expect(signOutClearingDrafts('u-1', '/login')).resolves.toBeUndefined();
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/login' });
  });

  it('NFR-PRIV-06 SFH-4: no store in this browser (null) still signs out', async () => {
    vi.doMock('@/lib/client/drafts', () => ({ openDraftStore: () => null }));
    const { signOutClearingDrafts } = await import('@/lib/client/signOutClearingDrafts');
    await signOutClearingDrafts('u-1', '/login');
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/login' });
  });

  it('NFR-PRIV-06 FIX-7: when the store cannot load, this account\'s drafts are still removed, and only this account\'s', async () => {
    // No later sign-in is sure to purge them: the same account's next sign-in keeps its own drafts (purgeOtherAccounts),
    // and the invitation page's sign-in purges nothing (silent-failure hunt F1, F2).
    const keys = new Map<string, string>([
      ['makrai.draft.v1:u-1:o:p:q:Q-PP-01', '{}'], ['makrai.draft.v1:u-1:o:p:m:f:new', '{}'],
      ['makrai.draft.v1:u-2:o:p:q:Q-PP-01', '{}'], ['other', 'kept'],
    ]);
    const storage = {
      get length() { return keys.size; },
      key: (i: number) => [...keys.keys()][i] ?? null,
      removeItem: (k: string) => { keys.delete(k); },
    };
    vi.stubGlobal('localStorage', storage);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.doMock('@/lib/client/drafts', () => { throw new Error('ChunkLoadError'); });
    try {
      const { signOutClearingDrafts } = await import('@/lib/client/signOutClearingDrafts');
      await signOutClearingDrafts('u-1', '/login');
      expect([...keys.keys()].sort()).toEqual(['makrai.draft.v1:u-2:o:p:q:Q-PP-01', 'other']);
      expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/login' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toMatch(/u-1/); // a fixed text, no account id
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('1A Task 12 L2-66 S4: the last-project keys of this account only are removed before signOut, whether or not the store loads', async () => {
    for (const store of ['loads', 'fails'] as const) {
      const keys = new Map<string, string>([
        ['makrai:last-project:u-1:acme', 'p'], ['makrai:last-project:u-1:beta', 'p'],
        ['makrai:last-project:u-10:acme', 'p'], ['makrai:last-project:u-2:acme', 'p'], ['other', 'kept'],
      ]);
      let atSignOut: string[] = [];
      signOut.mockImplementationOnce(async () => { atSignOut = [...keys.keys()].sort(); });
      vi.stubGlobal('localStorage', {
        get length() { return keys.size; },
        key: (i: number) => [...keys.keys()][i] ?? null,
        removeItem: (k: string) => { keys.delete(k); },
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.resetModules();
      if (store === 'loads') vi.doMock('@/lib/client/drafts', () => ({ openDraftStore: () => ({ purgeAccount: () => {} }) }));
      else vi.doMock('@/lib/client/drafts', () => { throw new Error('ChunkLoadError'); });
      try {
        const { signOutClearingDrafts } = await import('@/lib/client/signOutClearingDrafts');
        await signOutClearingDrafts('u-1', '/login');
        expect(atSignOut, store).toEqual(['makrai:last-project:u-10:acme', 'makrai:last-project:u-2:acme', 'other']);
      } finally {
        warn.mockRestore();
        vi.unstubAllGlobals();
      }
    }
  });

  it('NFR-PRIV-06 FIX-7: the prefix this file sweeps is the draft store\'s own', async () => {
    const { DRAFT_PREFIX } = await vi.importActual<typeof import('@/lib/client/drafts')>('@/lib/client/drafts');
    const { DRAFT_KEY_PREFIX } = await import('@/lib/client/signOutClearingDrafts');
    expect(DRAFT_KEY_PREFIX).toBe(DRAFT_PREFIX);
  });
});
