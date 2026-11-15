import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Plan 1B Task 2: S-01 Sign in in the gate frame (F17 autofill, C12 the signed-out line, 9.7 the wait in words), and the
 * signed-out hint's reader (T2.1). Markup through react-dom/server, as __tests__/unit/auth-pages.test.tsx reads it; what a
 * click does in a browser is e2e/account.spec.ts's.
 */
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('next-auth/react', () => ({ signIn: vi.fn(), getSession: vi.fn() }));

const { LoginView, readSignedOutHint, signInErrorText } = await import('@/app/(public)/login/LoginClient');
const { PasswordField } = await import('@/components/auth/PasswordField');
const { AuthCard } = await import('@/components/auth/AuthCard');
const { AUTH_COPY, SIGN_IN_COPY } = await import('@/lib/auth/copy');
const { SIGNED_OUT_HINT_KEY, signInAgainHref } = await import('@/lib/auth/idle');

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (el: React.ReactElement) => html(el).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const noop = () => {};
const BASE = {
  email: '', password: '', showPassword: false, error: '', notice: null, loading: false, signedOut: null,
  onEmail: noop, onPassword: noop, onToggleShow: noop, onSubmit: noop,
} as const;

const NOW = Date.UTC(2026, 10, 15, 9, 0, 0);
/** A sessionStorage held in a Map. */
function store(value: unknown, raw?: string): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  if (raw !== undefined) map.set(SIGNED_OUT_HINT_KEY, raw);
  else if (value !== undefined) map.set(SIGNED_OUT_HINT_KEY, JSON.stringify(value));
  return {
    map,
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

describe('S-01 in the gate frame (plan 1B Task 2)', () => {
  it('S-01 uses the autofill values (F17)', () => {
    const h = html(<LoginView {...BASE} />);
    expect(h).toMatch(/type="email"[^>]*autocomplete="username"[^>]*spellcheck="false"/i);
    expect(h).toMatch(/autocomplete="current-password"/i);
    expect(h).toMatch(/<form method="post"/);
  });

  it('S-01 says how to get an account, after the form, with the forgotten-password link', () => {
    const t = text(<LoginView {...BASE} />);
    expect(t).toContain(AUTH_COPY.noAccount);
    expect(t.indexOf(AUTH_COPY.noAccount)).toBeGreaterThan(t.indexOf(SIGN_IN_COPY.submit, t.indexOf(SIGN_IN_COPY.password)));
    expect(html(<LoginView {...BASE} />)).toMatch(/<a [^>]*href="\/forgot-password"/);
  });

  it('S-01 has one h1, the heading, and no logo inside the card (L5-8)', () => {
    const h = html(<LoginView {...BASE} />);
    expect(h.match(/<h1\b/g)).toHaveLength(1);
    expect(h).toContain(`>${SIGN_IN_COPY.heading}</h1>`);
    expect(h).not.toMatch(/<img\b/);
  });

  it('C12: a signed-out return shows the line once, before the form; none without a reason', () => {
    const idle = text(<LoginView {...BASE} signedOut="idle" />);
    expect(idle.split(AUTH_COPY.signedOutIdle)).toHaveLength(2);
    expect(idle.indexOf(AUTH_COPY.signedOutIdle)).toBeLessThan(idle.indexOf(SIGN_IN_COPY.email));
    expect(idle).toContain(AUTH_COPY.signedOutKept);
    expect(idle).not.toContain(AUTH_COPY.signedOutAbsolute);
    const absolute = text(<LoginView {...BASE} signedOut="absolute" />);
    expect(absolute).toContain(AUTH_COPY.signedOutAbsolute);
    expect(absolute).not.toContain(AUTH_COPY.signedOutIdle);
    const none = text(<LoginView {...BASE} signedOut={null} />);
    expect(none).not.toContain(AUTH_COPY.signedOutKept);
    expect(none).not.toContain(AUTH_COPY.signedOutIdle);
  });

  it('H3: the sign-in links are unchanged', () => expect(signInAgainHref('/q', '')).toBe('/login?callbackUrl=%2Fq'));

  it('9.7 (L5-9): too many sign-ins says the wait in words, true of the process-wide limit', () => {
    expect(signInErrorText({ error: 'rate_limited', code: '120' })).toBe(AUTH_COPY.tooManyAttempts(2));
    expect(AUTH_COPY.tooManyAttempts(2)).toBe(SIGN_IN_COPY.rateLimited(2));
    expect(AUTH_COPY.tooManyAttempts(1)).toMatch(/Wait 1 minute,/);
    expect(AUTH_COPY.tooManyAttempts(3)).toMatch(/Wait 3 minutes,/);
    // The 429 counts every unknown device's sign-in, never one person's tries (lib/auth/signInAdmission.ts).
    expect(AUTH_COPY.tooManyAttempts(2)).not.toMatch(/attempts|your/i);
  });

  it('the error is in an alert region inside the form, after the submit button', () => {
    const h = html(<LoginView {...BASE} error="E-TEXT" />);
    const form = /<form[^>]*>([\s\S]*?)<\/form>/.exec(h)?.[1] ?? '';
    expect(form.indexOf('type="submit"')).toBeGreaterThan(-1);
    expect(form.indexOf('<div role="alert"')).toBeGreaterThan(form.indexOf('type="submit"'));
    expect(form).toMatch(/<div role="alert"[^>]*>.*E-TEXT/);
    // The region exists before its text (ruling T16-6).
    expect(/<form[^>]*>([\s\S]*?)<\/form>/.exec(html(<LoginView {...BASE} />))?.[1]).toMatch(/<div role="alert" class="ui-status ui-status--error"><\/div>/);
  });

  it('the success notice is a status region before the form', () => {
    const h = html(<LoginView {...BASE} notice={SIGN_IN_COPY.passwordChanged} />);
    expect(h.indexOf('<div role="status"')).toBeLessThan(h.indexOf('<form'));
  });
});

describe('PasswordField and AuthCard (plan 1B Task 2)', () => {
  it('PasswordField toggles type and aria-pressed, keeps the value, and names what it controls', () => {
    const hidden = html(<PasswordField id="pw" name="pw" label="Password" autoComplete="current-password" value="s3cret" onChange={noop} show={false} onToggleShow={noop} />);
    const shown = html(<PasswordField id="pw" name="pw" label="Password" autoComplete="current-password" value="s3cret" onChange={noop} show onToggleShow={noop} />);
    expect(hidden).toMatch(/<input[^>]*id="pw"[^>]*type="password"/);
    expect(shown).toMatch(/<input[^>]*id="pw"[^>]*type="text"/);
    for (const h of [hidden, shown]) expect(h).toMatch(/value="s3cret"/);
    expect(hidden).toMatch(new RegExp(`<button[^>]*type="button"[^>]*aria-controls="pw"[^>]*aria-pressed="false"[^>]*>${AUTH_COPY.showPassword}</button>`));
    expect(shown).toMatch(/aria-pressed="true"/);
    // Uncontrolled, it starts hidden.
    expect(html(<PasswordField id="pw" name="pw" label="Password" autoComplete="new-password" value="" onChange={noop} />)).toMatch(/type="password"/);
  });

  it('AuthCard draws one h1, the lead, the content and the footer, in that order, and no second box (L5-7)', () => {
    const h = html(<AuthCard title="T-1" lead={<p>L-1</p>} footer={<p>F-1</p>}><p>C-1</p></AuthCard>);
    expect(h.match(/<h1\b/g)).toHaveLength(1);
    const at = (s: string) => h.indexOf(s);
    expect(at('T-1')).toBeLessThan(at('L-1'));
    expect(at('L-1')).toBeLessThan(at('C-1'));
    expect(at('C-1')).toBeLessThan(at('F-1'));
    expect(h).not.toMatch(/auth-card"|gate__card/);
  });
});

describe('T2.1: readSignedOutHint', () => {
  it('reads the reason once, and only one of the two words, fresh', () => {
    const s = store({ reason: 'idle', at: NOW - 60_000 });
    expect(readSignedOutHint(s, NOW)).toBe('idle');
    expect(s.map.has(SIGNED_OUT_HINT_KEY)).toBe(false); // read once
    expect(readSignedOutHint(s, NOW)).toBeNull();
    expect(readSignedOutHint(store({ reason: 'absolute', at: NOW }), NOW)).toBe('absolute');
    expect(readSignedOutHint(store({ reason: 'idle', at: NOW - 12 * 3600_000 }), NOW)).toBe('idle');
  });

  it('a stale, future, foreign or malformed value gives null, and is removed', () => {
    for (const [label, s] of [
      ['stale', store({ reason: 'idle', at: NOW - 13 * 3600_000 })],
      ['future', store({ reason: 'idle', at: NOW + 1000 })],
      ['markup', store({ reason: '<b>', at: NOW })],
      ['no at', store({ reason: 'idle' })],
      ['string at', store({ reason: 'idle', at: String(NOW) })],
      ['null', store(undefined, 'null')],
      ['number', store(undefined, '7')],
      ['array', store(undefined, '["idle"]')],
      ['not JSON', store(undefined, '{idle')],
    ] as const) {
      expect(readSignedOutHint(s, NOW), label).toBeNull();
      expect(s.map.has(SIGNED_OUT_HINT_KEY), label).toBe(false);
    }
  });

  it('a throwing or absent storage gives null, and nothing else', () => {
    const throwing = { getItem: () => { throw new Error('SecurityError'); }, removeItem: () => { throw new Error('SecurityError'); } } as unknown as Storage;
    expect(readSignedOutHint(throwing, NOW)).toBeNull();
    expect(readSignedOutHint(null, NOW)).toBeNull();
    // A hint that cannot be removed is not shown, so it cannot be shown twice.
    const stuck = { getItem: () => JSON.stringify({ reason: 'idle', at: NOW }), removeItem: () => { throw new Error('SecurityError'); } } as unknown as Storage;
    expect(readSignedOutHint(stuck, NOW)).toBeNull();
  });

  it('T2.1: the hint\'s value is never rendered: the view takes only the reason', () => {
    const src = readFileSync('app/(public)/login/LoginClient.tsx', 'utf8');
    expect(src).toMatch(/useEffect/);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
  });
});
