import { describe, expect, it, vi } from 'vitest';

vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));

const { signOutEverywhere } = await import('@/components/account/SignOutEverywhere');

/**
 * NFR-PRIV-06 FIX-7: the sign-outs other than the sidebar's also clear this device's drafts. Sign out everywhere takes
 * the purge as its third argument and calls it before each sign-out it makes; the two-argument form still works.
 */
describe('NFR-PRIV-06 FIX-7: sign out everywhere clears this device\'s drafts before it signs out', () => {
  const run = async (answer: () => Promise<Response>) => {
    const calls: string[] = [];
    const purge = vi.fn(() => { calls.push('purge'); });
    const signOutImpl = vi.fn(async () => { calls.push('signOut'); });
    await signOutEverywhere(vi.fn(answer) as unknown as typeof fetch, signOutImpl, purge);
    return { calls, purge, signOutImpl };
  };

  it('NFR-PRIV-06 FIX-7: a 200 purges, then signs out', async () => {
    expect((await run(async () => new Response('{}', { status: 200 }))).calls).toEqual(['purge', 'signOut']);
  });

  it('NFR-PRIV-06 FIX-7: a 401 purges, then signs this browser out', async () => {
    expect((await run(async () => new Response('{}', { status: 401 }))).calls).toEqual(['purge', 'signOut']);
  });

  it('NFR-PRIV-06 FIX-7: a 500 signs nothing out and keeps the drafts', async () => {
    const r = await run(async () => new Response('{}', { status: 500 }));
    expect(r.purge).not.toHaveBeenCalled();
    expect(r.signOutImpl).not.toHaveBeenCalled();
  });

  it('NFR-PRIV-06 FIX-7: a network failure signs nothing out and keeps the drafts', async () => {
    const r = await run(async () => { throw new TypeError('Failed to fetch'); });
    expect(r.purge).not.toHaveBeenCalled();
    expect(r.signOutImpl).not.toHaveBeenCalled();
  });

  it('NFR-PRIV-06 FIX-7: without a purge it still signs out (two-argument form)', async () => {
    const signOutImpl = vi.fn(async () => {});
    await signOutEverywhere(vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch, signOutImpl);
    expect(signOutImpl).toHaveBeenCalledWith({ callbackUrl: '/login' });
  });
});
