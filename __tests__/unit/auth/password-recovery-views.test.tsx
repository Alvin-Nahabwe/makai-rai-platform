import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Plan 1B Task 2: S-02 Forgot password and S-03 Set a new password in the gate frame (rulings L5-6, L5-7, L5-8). The
 * answers themselves (M-21, M-22, T2.5, T2.6) are __tests__/unit/auth-pages.test.tsx's; this file reads the new structure.
 */
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const { ForgotPasswordView } = await import('@/app/(public)/forgot-password/ForgotPasswordClient');
const { ResetPasswordView } = await import('@/app/(public)/reset-password/ResetPasswordClient');
const { AUTH_COPY, AUTH_MESSAGE_COPY, FORGOT_COPY } = await import('@/lib/auth/copy');
const { GATE_COPY } = await import('@/lib/shell/copy');

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (el: React.ReactElement) => html(el).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const noop = () => {};
const forgot = (state: Parameters<typeof ForgotPasswordView>[0]['state']) =>
  <ForgotPasswordView email="a@x.test" state={state} onEmail={noop} onSubmit={noop} />;

describe('S-02 in the gate frame', () => {
  it('S-02 lead and heading, then the form, then the way back', () => {
    const t = text(forgot({ kind: 'idle' }));
    expect(t).toContain(AUTH_COPY.forgotLead);
    expect(html(forgot({ kind: 'idle' }))).toContain(`>${AUTH_COPY.resetHeading}</h1>`);
    expect(t.indexOf(AUTH_COPY.resetHeading)).toBeLessThan(t.indexOf(AUTH_COPY.forgotLead));
    expect(t.indexOf(AUTH_COPY.forgotLead)).toBeLessThan(t.indexOf(FORGOT_COPY.email));
    expect(html(forgot({ kind: 'idle' }))).toMatch(new RegExp(`<a [^>]*href="/login"[^>]*>${AUTH_COPY.backToSignIn}</a>`));
  });

  it('T2.5: the sent answer is M-21 whatever the address, in a status region before the form; an error sits after the button', () => {
    const sent = html(forgot({ kind: 'sent' }));
    expect(sent.indexOf(AUTH_MESSAGE_COPY.resetLinkSent)).toBeLessThan(sent.indexOf('<form'));
    const failed = html(forgot({ kind: 'error', message: FORGOT_COPY.serverProblem }));
    const form = /<form[^>]*>([\s\S]*?)<\/form>/.exec(failed)?.[1] ?? '';
    expect(form.indexOf('<div role="alert"')).toBeGreaterThan(form.indexOf('type="submit"'));
    expect(form).toContain(FORGOT_COPY.serverProblem);
  });
});

describe('S-03 in the gate frame', () => {
  it('S-03 uses new-password', () => {
    expect(html(<ResetPasswordView token="x" password="" showPassword={false} state={{ kind: 'idle' }} onPassword={noop} onToggleShow={noop} onSubmit={noop} />))
      .toMatch(/autocomplete="new-password"/i);
  });

  it('M-22 with "Ask for a new link" when the link is used', () => {
    const h = html(<ResetPasswordView token="x" password="" showPassword={false} state={{ kind: 'unusable' }} onPassword={noop} onToggleShow={noop} onSubmit={noop} />);
    expect(h).toContain(AUTH_MESSAGE_COPY.resetLinkUnusable);
    expect(h).toMatch(/<a [^>]*href="\/forgot-password"/);
  });

  it('T2.6: the page source puts the token in no title, log or aria text', () => {
    const src = readFileSync('app/(public)/reset-password/page.tsx', 'utf8') + readFileSync('app/(public)/reset-password/ResetPasswordClient.tsx', 'utf8');
    expect(src).not.toMatch(/console\.\w+\([^)]*token/i);
    expect(src).not.toMatch(/aria-[a-z]+=\{[^}]*token/i);
    expect(src).not.toMatch(/title[^\n]*token/i);
  });
});

describe('L5-6 and L5-8: the three door pages render the public gate frame, its route, and no logo in the card', () => {
  const PAGES: Array<[string, string[]]> = [
    ['app/(public)/login/page.tsx', ['GATE_COPY.stops.signIn']],
    ['app/(public)/forgot-password/page.tsx', ['GATE_COPY.stops.askForLink', 'GATE_COPY.stops.setNewPassword', 'GATE_COPY.stops.signIn']],
    ['app/(public)/reset-password/page.tsx', ['GATE_COPY.stops.askForLink', 'GATE_COPY.stops.setNewPassword', 'GATE_COPY.stops.signIn']],
  ];
  it.each(PAGES)('%s', (page, stops) => {
    const src = readFileSync(page, 'utf8');
    expect(src).toMatch(/<GateFrame variant="public" route=\{ROUTE\}>/);
    let at = -1;
    for (const s of stops) {
      const next = src.indexOf(s, at + 1);
      expect(next, s).toBeGreaterThan(at);
      at = next;
    }
    expect(src).not.toMatch(/<img\b|auth-container|auth-card|auth-logo/);
    expect(src).not.toMatch(/from 'next\/image'/);
  });

  it('the route words are GATE_COPY\'s', () => {
    expect(GATE_COPY.stops.askForLink).toBe('Ask for a link');
    expect(GATE_COPY.stops.setNewPassword).toBe('Set a new password');
    expect(GATE_COPY.stops.signIn).toBe('Sign in');
  });
});
