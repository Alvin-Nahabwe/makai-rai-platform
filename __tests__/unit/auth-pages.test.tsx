import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * S-01, S-02 and S-03 (FR-ACC-05, FR-ACC-06; M-20, M-21, M-22; obligations B9 and B17).
 *
 * vitest runs in the `node` environment and @testing-library/react and jsdom are not installed (an install is a download,
 * G-23; the approach of __tests__/unit/acceptances-form.test.tsx): this file reads each screen's markup from
 * react-dom/server and drives the pure functions the screens call on submit, with a recording fetch and fake
 * window/history/storage objects. What a click, a paste and a focus move do in a real browser is e2e/account.spec.ts's.
 */
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('next-auth/react', () => ({ signIn: vi.fn(), getSession: vi.fn() }));

const { LoginView, signInErrorText, purgeOtherAccountsAfterSignIn, submitSignIn, purgeDraftsAfterSignIn } = await import('@/app/(public)/login/LoginClient');
const { ForgotPasswordView, requestResetLink } = await import('@/app/(public)/forgot-password/ForgotPasswordClient');
const { ResetPasswordView, takeResetToken, setNewPassword, resetTokenStore } = await import('@/app/(public)/reset-password/ResetPasswordClient');
const messages = await import('@/lib/http/messages');
const { openDraftStore } = await import('@/lib/client/drafts');

const M20 = 'The email or password is not right, or the account is locked after too many attempts. Try again in 15 minutes, or reset your password.';
const M21 = 'If an account exists for this email, we have sent a link. It works once and expires in 30 minutes.';
const M22 = 'This link has expired or has already been used. Ask for a new one.';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const tagOf = (markup: string, id: string) => markup.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? '';
const noop = () => {};

const loginView = (over: Partial<Parameters<typeof LoginView>[0]> = {}) => html(
  <LoginView email="" password="" showPassword={false} error="" notice={null} loading={false}
    onEmail={noop} onPassword={noop} onToggleShow={noop} onSubmit={noop} {...over} />);

/** A Storage held in a Map, as localStorage behaves. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

describe('S-01 Sign in', () => {
  it('M-20 FR-ACC-05: every refused sign-in shows one text, and there is no Create account link', () => {
    expect(signInErrorText({ error: 'CredentialsSignin' })).toBe(M20);
    const markup = loginView({ error: M20 });
    expect(markup).toMatch(new RegExp(`role="alert"[^>]*>${M20}<`));
    expect(markup).not.toMatch(/create account/i);
    expect(markup).not.toMatch(/href="\/register/);
    expect(markup).toMatch(/<a [^>]*href="\/forgot-password"[^>]*>Forgot your password\?<\/a>/);
    expect(tagOf(markup, 'email')).toMatch(/autoComplete="username"|autocomplete="username"/i);
    expect(tagOf(markup, 'email')).toMatch(/spellcheck="false"/i);
    expect(tagOf(markup, 'email')).toMatch(/type="email"/);
    expect(tagOf(markup, 'email')).toMatch(/required/);
    expect(tagOf(markup, 'password')).toMatch(/autocomplete="current-password"/i);
    expect(tagOf(markup, 'password')).toMatch(/required/);
    expect(tagOf(markup, 'password')).toMatch(/type="password"/);
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*aria-controls="password"[^>]*>Show<\/button>/);
  });

  it('S-01 (a419413): the Create account link and the registered banner are gone from the page source', () => {
    const src = readFileSync('app/(public)/login/page.tsx', 'utf8') + readFileSync('app/(public)/login/LoginClient.tsx', 'utf8');
    expect(src).not.toMatch(/Create account/i);
    expect(src).not.toMatch(/registered/);
    expect(src).not.toMatch(/\/register/);
  });

  it('FR-ACC-05: a busy or rate-limited sign-in says so, and Show reveals the password', () => {
    // Owner copy (C4 ruling SC-1), in the 7.5.7 pattern: what did not happen, what is safe, what to do.
    expect(signInErrorText({ error: 'sign_in_busy' })).toBe('Not signed in: the server is busy with other sign-ins. Nothing was changed. Try again in a minute.');
    // A failure on the server (next-auth answers Configuration when authorize throws, as in a database outage) is not
    // told as a wrong password.
    const SERVER = 'Not signed in: the server had a problem. Nothing was changed. Try again in a few minutes.';
    expect(signInErrorText({ error: 'Configuration' })).toBe(SERVER);
    expect(signInErrorText({})).toBe(SERVER);
    // The wait rides in the refusal url's `code` (and `wait`), the one other field next-auth/react's signIn returns
    // (C4 ruling SC-3); minutes rounded up.
    expect(signInErrorText({ error: 'rate_limited', code: '42' })).toBe('Too many sign-ins right now. Wait 1 minute and try again.');
    expect(signInErrorText({ error: 'rate_limited', code: '90' })).toBe('Too many sign-ins right now. Wait 2 minutes and try again.');
    expect(signInErrorText({ error: 'rate_limited' })).toBe('Too many sign-ins right now. Wait 1 minute and try again.');
    expect(signInErrorText({ error: 'rate_limited', code: 'x9' })).toBe('Too many sign-ins right now. Wait 1 minute and try again.');
    expect(tagOf(loginView({ showPassword: true }), 'password')).toMatch(/type="text"/);
    expect(loginView({ showPassword: true })).toMatch(/aria-pressed="true"/);
  });

  it('FR-ACC-05 (C4 ruling F2): a sign-in that gets no readable answer says the connection was lost and gives the form back', async () => {
    const LOST = 'Not signed in: connection lost. Nothing was changed. Try again.';
    // next-auth/react's signIn parses the answer with res.json(): an nginx 502 page in HTML makes it reject.
    const html502 = vi.fn(async () => { throw new SyntaxError('Unexpected token \'<\', "<html><hea"... is not valid JSON'); });
    expect(await submitSignIn({ signIn: html502, getSession: vi.fn() }, 'a@x.test', 'pw')).toEqual({ kind: 'error', message: LOST });
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await submitSignIn({ signIn: offline, getSession: vi.fn() }, 'a@x.test', 'pw')).toEqual({ kind: 'error', message: LOST });
    // A sign-in that worked but whose session read was lost is still a sign-in: the next page reads the session.
    const ok = vi.fn(async () => ({ error: undefined, ok: true, status: 200, url: 'http://localhost/' }));
    const lostSession = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await submitSignIn({ signIn: ok, getSession: lostSession }, 'a@x.test', 'pw')).toEqual({ kind: 'done', userId: null });
    expect(await submitSignIn({ signIn: ok, getSession: vi.fn(async () => ({ user: { id: 'u1' } })) }, 'a@x.test', 'pw')).toEqual({ kind: 'done', userId: 'u1' });
    const refused = vi.fn(async () => ({ error: 'CredentialsSignin', ok: false, status: 401, url: null }));
    expect(await submitSignIn({ signIn: refused, getSession: vi.fn() }, 'a@x.test', 'pw')).toEqual({ kind: 'error', message: M20 });
  });

  it('FR-ACC-06: after a reset or a change the page says the password changed', () => {
    expect(loginView({ notice: 'Password changed. Please sign in with your new password.' }))
      .toMatch(/role="status"[^>]*>Password changed\. Please sign in with your new password\.</);
  });

  it('UX-26 (helper) FR-ACC-05: sign-in purges other accounts\' drafts', () => {
    const storage = memoryStorage();
    const store = openDraftStore(storage)!;
    const key = (userId: string) => ({ userId, orgId: 'o1', projectId: 'p1', target: { kind: 'question' as const, questionId: 'Q-1' } });
    const draft = { baseVersionNumber: null, value: { reason: 'x' }, savedAt: new Date().toISOString(), savePressedAt: null, retry: { requestId: null, sentBody: null } };
    expect(store.write(key('u1'), draft as never)).toBe(true);
    expect(store.count('u1', new Date())).toBe(1);
    expect(store.write(key('u2'), draft as never)).toBe(true);
    expect(purgeOtherAccountsAfterSignIn(storage, 'u1')).toBe(1);
    expect(store.count('u1', new Date())).toBe(1);
    expect(store.count('u2', new Date())).toBe(0);
    // A browser that keeps no storage signs in all the same.
    expect(purgeOtherAccountsAfterSignIn(null, 'u1')).toBe(0);
  });

  it('UX-26 B17 (C4 m3): a sign-in whose user id cannot be read retries once, then purges every draft, never none', async () => {
    const ok = vi.fn(async () => ({ error: undefined, ok: true, status: 200, url: 'http://localhost/' }));
    // next-auth/react's getSession answers null (never rejects) when the session read fails, a 429 or a 5xx.
    const flaky = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ user: { id: 'u1' } });
    expect(await submitSignIn({ signIn: ok, getSession: flaky }, 'a@x.test', 'pw')).toEqual({ kind: 'done', userId: 'u1' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const dead = vi.fn(async () => null);
    expect(await submitSignIn({ signIn: ok, getSession: dead }, 'a@x.test', 'pw')).toEqual({ kind: 'done', userId: null });
    expect(dead).toHaveBeenCalledTimes(2);

    const storage = memoryStorage();
    const store = openDraftStore(storage)!;
    const key = (userId: string) => ({ userId, orgId: 'o1', projectId: 'p1', target: { kind: 'question' as const, questionId: 'Q-1' } });
    const draft = { baseVersionNumber: null, value: { reason: 'x' }, savedAt: new Date().toISOString(), savePressedAt: null, retry: { requestId: null, sentBody: null } };
    store.write(key('u1'), draft as never);
    store.write(key('u2'), draft as never);
    storage.setItem('unrelated', 'kept');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(purgeDraftsAfterSignIn(storage, null)).toBe(2);
      expect([store.count('u1', new Date()), store.count('u2', new Date()), storage.getItem('unrelated')]).toEqual([0, 0, 'kept']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/session read failed after sign-in/);
      expect(String(warn.mock.calls[0][0])).not.toMatch(/@/);
      // With the id, only the other accounts' drafts go, and nothing is logged.
      store.write(key('u1'), draft as never);
      store.write(key('u2'), draft as never);
      warn.mockClear();
      expect(purgeDraftsAfterSignIn(storage, 'u1')).toBe(1);
      expect(store.count('u1', new Date())).toBe(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('NFR-A11Y-04: S-01 takes pasted passwords', () => {
    const src = readFileSync('app/(public)/login/LoginClient.tsx', 'utf8');
    expect(src).not.toMatch(/onPaste|onCopy|autoComplete="off"/);
  });
});

describe('S-02 Forgot password', () => {
  it('M-21 FR-ACC-06: S-02 answers with one text', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: M21 }), { status: 202 }));
    expect(await requestResetLink(fetchMock as unknown as typeof fetch, 'a@x.test')).toEqual({ kind: 'sent' });
    expect(fetchMock).toHaveBeenCalledWith('/api/password-reset', expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'a@x.test' }) }));
    const sent = html(<ForgotPasswordView email="a@x.test" state={{ kind: 'sent' }} onEmail={noop} onSubmit={noop} />);
    expect(sent).toMatch(new RegExp(`role="status"[^>]*>${M21}<`));
    const idle = html(<ForgotPasswordView email="" state={{ kind: 'idle' }} onEmail={noop} onSubmit={noop} />);
    expect(idle).toMatch(/<button[^>]*type="submit"[^>]*>Send reset link<\/button>/);
    expect(tagOf(idle, 'email')).toMatch(/autocomplete="username"/i);
    expect(tagOf(idle, 'email')).toMatch(/spellcheck="false"/i);
  });

  it('FR-ACC-06: a lost connection or a server fault on S-02 says so and keeps the address', async () => {
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await requestResetLink(offline as unknown as typeof fetch, 'a@x.test')).toMatchObject({ kind: 'error' });
    const fault = vi.fn(async () => new Response('{}', { status: 500 }));
    const r = await requestResetLink(fault as unknown as typeof fetch, 'a@x.test');
    expect(r).toEqual({ kind: 'error', message: 'Not sent: the server had a problem. Try again in a few minutes.' });
    expect(await requestResetLink(offline as unknown as typeof fetch, 'a@x.test')).toEqual({ kind: 'error', message: 'Not sent: the request did not reach the server. Check the connection and try again.' });
    const markup = html(<ForgotPasswordView email="a@x.test" state={r} onEmail={noop} onSubmit={noop} />);
    expect(markup).toMatch(/role="alert"/);
    expect(tagOf(markup, 'email')).toMatch(/value="a@x.test"/);
  });
});

describe('S-03 Set a new password', () => {
  function fakeWindow(hash: string) {
    const calls: string[] = [];
    const win = {
      location: { hash, pathname: '/reset-password' },
      history: { replaceState: (_s: unknown, _t: string, url: string) => { calls.push(`replaceState ${url}`); win.location.hash = ''; } },
    };
    return { win, calls };
  }

  it('FR-ACC-06 NFR-OBS-01: S-03 sends the token in the body and clears it from the address', async () => {
    const raw = 'a'.repeat(64);
    const { win, calls } = fakeWindow(`#token=${raw}`);
    expect(takeResetToken(win)).toBe(raw);
    expect(calls).toEqual(['replaceState /reset-password']);
    expect(win.location.hash).toBe('');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    expect(await setNewPassword(fetchMock as unknown as typeof fetch, raw, 'n'.repeat(12))).toEqual({ kind: 'done' });
    expect(fetchMock).toHaveBeenCalledWith('/api/password-reset/complete', expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: raw, newPassword: 'n'.repeat(12) }) }));
    expect(String(fetchMock.mock.calls[0][0])).not.toContain(raw);
  });

  it('M-22: a used or expired link shows the M-22 text, and so does a missing token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: M22, code: 'reset_link_unusable' }), { status: 410 }));
    const r = await setNewPassword(fetchMock as unknown as typeof fetch, 'a'.repeat(64), 'n'.repeat(12));
    expect(r).toEqual({ kind: 'unusable' });
    const markup = html(<ResetPasswordView token="x" password="" showPassword={false} state={r} onPassword={noop} onToggleShow={noop} onSubmit={noop} />);
    expect(markup).toMatch(new RegExp(`role="alert"[^>]*>${M22}`));
    expect(markup).toMatch(/<a [^>]*href="\/forgot-password"/);
    const { win } = fakeWindow('');
    expect(takeResetToken(win)).toBeNull();
    const missing = html(<ResetPasswordView token={null} password="" showPassword={false} state={{ kind: 'idle' }} onPassword={noop} onToggleShow={noop} onSubmit={noop} />);
    expect(missing).toContain(M22);
    expect(missing).not.toMatch(/id="new-password"/);
  });

  it('NFR-SEC-18 FR-ACC-06: S-03 states the minimum, shows a 422 under the field, and has one new-password field', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Validation failed', code: 'validation', fields: [{ field: 'newPassword', message: 'Password must be at least 12 characters' }] }), { status: 422 }));
    const r = await setNewPassword(fetchMock as unknown as typeof fetch, 'a'.repeat(64), 'short');
    expect(r).toEqual({ kind: 'invalid', message: 'Password must be at least 12 characters' });
    const markup = html(<ResetPasswordView token="x" password="short" showPassword={false} state={r} onPassword={noop} onToggleShow={noop} onSubmit={noop} />);
    expect(markup).toContain('At least 12 characters.');
    expect(tagOf(markup, 'new-password')).toMatch(/autocomplete="new-password"/i);
    expect(tagOf(markup, 'new-password')).toMatch(/aria-describedby="new-password-hint new-password-error"/);
    expect(markup).toMatch(/id="new-password-error"[^>]*>Password must be at least 12 characters</);
    expect(markup.match(/type="password"/g)).toHaveLength(1);
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>Set password<\/button>/);
    expect(markup).toMatch(/aria-controls="new-password"[^>]*>Show</);
  });

  it('FR-ACC-06: S-03 tells a lost request from a server failure', async () => {
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await setNewPassword(offline as unknown as typeof fetch, 'a'.repeat(64), 'n'.repeat(12)))
      .toEqual({ kind: 'error', message: 'Not set: the request did not reach the server. Your link still works; try again.' });
    const fault = vi.fn(async () => new Response('{"error":"Service unavailable","code":"database_unavailable","reference":"0a1b2c3d"}', { status: 503 }));
    expect(await setNewPassword(fault as unknown as typeof fetch, 'a'.repeat(64), 'n'.repeat(12)))
      .toEqual({ kind: 'error', message: 'Not set: the server had a problem. Try again; if the link no longer works, ask for a new one.' });
  });

  it('NFR-A11Y-04: S-01 and S-03 take pasted passwords', () => {
    for (const f of ['app/(public)/login/LoginClient.tsx', 'app/(public)/reset-password/ResetPasswordClient.tsx']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/onPaste|onCopy|autoComplete="off"/);
    }
  });
});

describe('one copy of each message (C4 SI-1)', () => {
  it('M-20 M-21 M-22: the texts live once, in lib/http/messages.ts, and every screen and route imports them', () => {
    expect([messages.M20, messages.M21, messages.M22]).toEqual([M20, M21, M22]);
    const users: Record<string, string[]> = {
      'app/(public)/login/LoginClient.tsx': ['M20'],
      'app/(public)/forgot-password/ForgotPasswordClient.tsx': ['M21'],
      'app/api/password-reset/route.ts': ['M21'],
      'app/(public)/reset-password/ResetPasswordClient.tsx': ['M22'],
      'lib/data/passwordReset.ts': ['M22'],
    };
    for (const [file, names] of Object.entries(users)) {
      const src = readFileSync(file, 'utf8');
      for (const n of names) expect(src, `${file} imports ${n}`).toMatch(new RegExp(`import \\{[^}]*\\b${n}\\b[^}]*\\} from '@/lib/http/messages'`));
      for (const text of [M20, M21, M22]) expect(src.includes(text), `${file} repeats a message text`).toBe(false);
    }
  });
});

describe('S-03 after a successful reset (C4 m4)', () => {
  it('FR-ACC-06: once the password is set, the page never shows M-22, even after the token is forgotten', () => {
    const markup = html(<ResetPasswordView token={null} password="" showPassword={false} state={{ kind: 'done' }} onPassword={noop} onToggleShow={noop} onSubmit={noop} />);
    expect(markup).not.toContain(M22);
    expect(markup).toMatch(/role="status"[^>]*>Password changed\. Please sign in with your new password\.</);
    expect(markup).not.toMatch(/id="new-password"/);
  });
});

describe('the reset token store (C4 CR-6)', () => {
  it('FR-ACC-06 M-22: after the link is used or refused, a later visit with no link shows M-22, not the old token', () => {
    const win = { location: { hash: `#token=${'b'.repeat(64)}` }, history: { replaceState: () => { win.location.hash = ''; } }, addEventListener: () => {}, removeEventListener: () => {} };
    vi.stubGlobal('window', win);
    try {
      expect(resetTokenStore.getSnapshot()).toBe('b'.repeat(64));
      expect(resetTokenStore.getSnapshot()).toBe('b'.repeat(64)); // the address no longer has it; the store keeps it
      resetTokenStore.forget();
      expect(resetTokenStore.getSnapshot()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
