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
});
