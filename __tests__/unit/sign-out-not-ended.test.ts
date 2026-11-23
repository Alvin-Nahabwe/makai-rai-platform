import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lead's ruling L5-11 (option a; silent-failure reviews d1-sfh F3, d2-sfh-1 findings 1, 7, 8 and d2-sfh-2): a sign-out
 * counts only when next-auth's answer says the session ended, a url with no `error` parameter outside /api/auth/. Any
 * other answer (MissingCSRF after a failed token fetch, a 400 or 500 body with no url, a timeout) throws a named error:
 * the one press (lib/client/signOutPress.ts) then says the person is still signed in and navigates nowhere, and a second
 * press tries again. The drafts are removed before the sign-out is asked for, as before.
 */
const signOut = vi.fn();
/** What happened, in order: the store's purges and the sign-out requests. */
let order: string[] = [];
let location: { href: string; reload: ReturnType<typeof vi.fn> };

beforeEach(() => {
  signOut.mockReset();
  location = { href: 'http://localhost/acceptances', reload: vi.fn() };
  vi.stubGlobal('window', { location });
  vi.resetModules();
  vi.doMock('next-auth/react', () => ({ signOut }));
  order = [];
  vi.doMock('@/lib/client/drafts', () => ({ openDraftStore: () => ({ purgeAccount: (id: string) => { order.push(`purge ${id}`); return 1; } }) }));
});
afterEach(() => {
  vi.doUnmock('@/lib/client/drafts');
  vi.doUnmock('next-auth/react');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const load = () => import('@/lib/client/signOutClearingDrafts');

describe('L5-11: signOutClearingDrafts', () => {
  it('asks next-auth with redirect off and the same callback, and navigates to its url when the session ended', async () => {
    signOut.mockResolvedValue({ url: 'https://rai.example/login' });
    const { signOutClearingDrafts } = await load();
    await signOutClearingDrafts('u-1', '/login');
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/login', redirect: false });
    expect(location.href).toBe('https://rai.example/login');
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('MissingCSRF (the token fetch failed): throws SignOutNotEnded and never navigates', async () => {
    signOut.mockResolvedValue({ url: 'https://rai.example/login?error=MissingCSRF' });
    const { signOutClearingDrafts } = await load();
    await expect(signOutClearingDrafts('u-1', '/login')).rejects.toMatchObject({ name: 'SignOutNotEnded' });
    expect(location.href).toBe('http://localhost/acceptances');
  });

  it.each([
    ['no answer body', undefined],
    ['a 500 body with no url', { message: 'There was a problem with the server configuration.' }],
    ['a url that is not a string', { url: 42 }],
    ['a url that does not parse', { url: 'not a url' }],
    ['next-auth\'s own sign-out page', { url: 'https://rai.example/api/auth/signout?csrf=true' }],
    ['an error page', { url: 'https://rai.example/api/auth/error?error=Configuration' }],
  ])('%s: throws SignOutNotEnded and never navigates', async (_label, answer) => {
    signOut.mockResolvedValue(answer);
    const { signOutClearingDrafts } = await load();
    await expect(signOutClearingDrafts('u-1', '/login')).rejects.toMatchObject({ name: 'SignOutNotEnded' });
    expect(location.href).toBe('http://localhost/acceptances');
  });

  it('a request that rejects (offline, a 502 page that is not JSON) rejects as it did, and never navigates', async () => {
    signOut.mockRejectedValue(new TypeError('Failed to fetch'));
    const { signOutClearingDrafts } = await load();
    await expect(signOutClearingDrafts('u-1', '/login')).rejects.toBeInstanceOf(TypeError);
    expect(location.href).toBe('http://localhost/acceptances');
  });

  it('a sign-out that has not answered in 30 s throws SignOutTimedOut and never navigates', async () => {
    vi.useFakeTimers();
    signOut.mockReturnValue(new Promise(() => {}));
    const { signOutClearingDrafts, SIGN_OUT_TIMEOUT_MS } = await load();
    expect(SIGN_OUT_TIMEOUT_MS).toBe(30_000);
    const outcome = signOutClearingDrafts('u-1', '/login').then(() => 'resolved', (e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toBe('SignOutTimedOut');
    expect(location.href).toBe('http://localhost/acceptances');
  });

  it('a url with a fragment reloads, as next-auth\'s own redirect does', async () => {
    signOut.mockResolvedValue({ url: 'https://rai.example/invitations/t#x' });
    const { signOutClearingDrafts } = await load();
    await signOutClearingDrafts('u-1', '/invitations/t#x');
    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  it('the drafts are removed before the sign-out is asked for, also when it then fails', async () => {
    signOut.mockImplementation(async () => { order.push('signOut'); return { url: 'https://rai.example/login?error=MissingCSRF' }; });
    const { signOutClearingDrafts } = await load();
    await expect(signOutClearingDrafts('u-1', '/login')).rejects.toMatchObject({ name: 'SignOutNotEnded' });
    expect(order).toEqual(['purge u-1', 'signOut']);
  });

  it('a draft store that never loads is given 10 s, then the drafts are swept directly and the sign-out still asked for', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.doMock('next-auth/react', () => ({ signOut }));
    // Unmock first: vitest resolves consecutive queued mocks in parallel and the last to resolve wins, so without this
    // the beforeEach's purging mock sometimes replaced this one (12 of 42 runs failed at vitest 4.1.12). An unmock between
    // them splits the queue into groups that run in order.
    vi.doUnmock('@/lib/client/drafts');
    vi.doMock('@/lib/client/drafts', () => new Promise(() => {}));
    signOut.mockResolvedValue({ url: 'https://rai.example/login' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { signOutClearingDrafts } = await load();
    const done = signOutClearingDrafts('u-1', '/login');
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/login', redirect: false });
    expect(location.href).toBe('https://rai.example/login');
    expect(order).toEqual([]);                                  // the store never opened
    expect(warn).toHaveBeenCalledWith('Draft store unavailable at sign-out; drafts were removed directly.');
    warn.mockRestore();
  });

  it('no callback a caller passes carries an error parameter of its own (it would read as never ended)', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['components/layout/GateSignOut.tsx', 'components/legal/AcceptancesForm.tsx', 'app/(public)/login/LoginClient.tsx',
      'components/layout/Rail.tsx', 'components/decision/SignOutWithDraftsGuard.tsx']) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:useSignOutPress|signOutClearingDrafts)\([^,]+,\s*'([^']*)'/g)) expect(m[1], f).not.toMatch(/[?&]error=/);
    }
  });
});

describe('L5-11: the press says still signed in, navigates nowhere, and a second press retries', () => {
  it('a sign-out that did not end shows stillSignedIn; the next press signs out', async () => {
    const { signOutPress, signOutMessage } = await import('@/lib/client/signOutPress');
    const shown: string[] = [];
    const attempt = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'SignOutNotEnded' }))
      .mockResolvedValueOnce(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const press = signOutPress(async () => ({ signOutClearingDrafts: attempt }), (p) => shown.push(p));
    await press('u-1', '/login');
    expect(shown).toEqual(['working', 'stillSignedIn']);
    expect(signOutMessage('stillSignedIn')).not.toBeNull();
    expect(String(warn.mock.calls[0]?.[1])).toBe('SignOutNotEnded');
    await press('u-1', '/login');
    expect(shown).toEqual(['working', 'stillSignedIn', 'working']);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(location.href).toBe('http://localhost/acceptances');
    warn.mockRestore();
  });
});
