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
const { ResetPasswordView, ResetRouteView } = await import('@/app/(public)/reset-password/ResetPasswordClient');
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

  it('D2 review A-r2-2, A-L1: once the form is replaced by the sent answer, the card\'s h1 can take focus (tabindex -1), the status region does not, and the client moves focus to the h1', () => {
    // The Send reset link button is removed with the form, so focus would fall to the body (WCAG 2.4.3). The target is the
    // h1, not the status region: a screen reader would read M-21 again if focus went into its live region. No jsdom here (see
    // acceptances-form.test.tsx): the markup carries the target, and the client's source is read for the move.
    const sent = html(forgot({ kind: 'sent' }));
    expect(sent).toMatch(new RegExp(`<h1 tabindex="-1">${AUTH_COPY.resetHeading}</h1>`));
    expect(sent).toMatch(new RegExp(`<div role="status"[^>]*>${AUTH_MESSAGE_COPY.resetLinkSent}</div>`));
    expect(sent.match(/tabindex/g)).toHaveLength(1);
    // Before it is sent nothing takes focus: no tabindex, so no tab stop or focus ring appears.
    expect(html(forgot({ kind: 'idle' }))).not.toMatch(/tabindex/);
    expect(html(forgot({ kind: 'error', message: 'x' }))).not.toMatch(/tabindex/);
    const src = readFileSync('app/(public)/forgot-password/ForgotPasswordClient.tsx', 'utf8');
    expect(src).toMatch(/useEffect\(\(\) => \{ if \(state\.kind === 'sent'\) headingEl\.current\?\.focus\(\); \}, \[state\.kind\]\)/);
    expect(src).not.toContain('focusRef');
  });

  it('T2.5 and I-5: the sent answer is M-21 whatever the address, in a status region that replaces the form; an error sits after the button', () => {
    const sent = html(forgot({ kind: 'sent' }));
    expect(sent).toMatch(new RegExp(`<div role="status"[^>]*>${AUTH_MESSAGE_COPY.resetLinkSent}</div>`));
    expect(sent).not.toMatch(/<form\b|<input\b|ui-button--primary/);
    expect(sent).toMatch(new RegExp(`<a [^>]*href="/login"[^>]*>${AUTH_COPY.backToSignIn}</a>`));
    // The region is in the page before it is filled (ruling T16-6), so the sent answer is announced.
    expect(html(forgot({ kind: 'idle' }))).toMatch(/<div role="status" class="ui-status"><\/div>/);
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

  it('I-6: M-22, then "Ask for a new link" as the card\'s primary button-link, and Back to sign in', () => {
    const h = html(<ResetPasswordView token="x" password="" showPassword={false} state={{ kind: 'unusable' }} onPassword={noop} onToggleShow={noop} onSubmit={noop} />);
    expect(h).toContain(AUTH_MESSAGE_COPY.resetLinkUnusable);
    expect(h).toMatch(/<a class="ui-button ui-button--primary" href="\/forgot-password">Ask for a new link<\/a>/);
    expect(h).toMatch(new RegExp(`<a [^>]*href="/login"[^>]*>${AUTH_COPY.backToSignIn}</a>`));
  });

  it('I-6: a link that cannot be used makes Ask for a link the current stop again; a good one has it done', () => {
    const current = (h: string) => /aria-current="step"><span class="gate-route__here">[^<]*<\/span> ([^<]*)</.exec(h)?.[1];
    expect(current(html(<ResetRouteView step="unusable" />))).toBe(AUTH_COPY.recoveryStops.askForLink);
    expect(current(html(<ResetRouteView step="form" />))).toBe(AUTH_COPY.recoveryStops.setNewPassword);
    expect(AUTH_COPY.linkUnusableHeading).toBe('This link cannot be used');
  });

  it('M-8: the valid link\'s card leads back to sign in too', () => {
    const h = html(<ResetPasswordView token="x" password="" showPassword={false} state={{ kind: 'idle' }} onPassword={noop} onToggleShow={noop} onSubmit={noop} />);
    expect(h).toMatch(new RegExp(`<a [^>]*href="/login"[^>]*>${AUTH_COPY.backToSignIn}</a>`));
  });

  it('T2.6: the page source puts the token in no title, log or aria text', () => {
    const src = readFileSync('app/(public)/reset-password/page.tsx', 'utf8') + readFileSync('app/(public)/reset-password/ResetPasswordClient.tsx', 'utf8');
    expect(src).not.toMatch(/console\.\w+\([^)]*token/i);
    expect(src).not.toMatch(/aria-[a-z]+=\{[^}]*token/i);
    expect(src).not.toMatch(/title[^\n]*token/i);
  });
});

describe('L5-6 and L5-8: the three door pages render the public gate frame, its route, and no logo in the card', () => {
  // A page whose step changes in the browser draws its route from its client module (routeSlot); the stops are there.
  const PAGES: Array<[string, RegExp, string, string[]]> = [
    ['app/(public)/login/page.tsx', /<GatePublicFrame routeSlot=\{<LoginRoute \/>\}>/, 'app/(public)/login/LoginClient.tsx', ['GATE_COPY.stops.signIn']],
    ['app/(public)/forgot-password/page.tsx', /<GatePublicFrame route=\{ROUTE\}>/, 'app/(public)/forgot-password/page.tsx', ['AUTH_COPY.recoveryStops.askForLink', 'AUTH_COPY.recoveryStops.setNewPassword', 'GATE_COPY.stops.signIn']],
    ['app/(public)/reset-password/page.tsx', /<GatePublicFrame routeSlot=\{<ResetRoute \/>\}>/, 'app/(public)/reset-password/ResetPasswordClient.tsx', ['AUTH_COPY.recoveryStops.askForLink', 'AUTH_COPY.recoveryStops.setNewPassword', 'GATE_COPY.stops.signIn']],
  ];
  it.each(PAGES)('%s', (page, frame, routeFile, stops) => {
    expect(readFileSync(page, 'utf8')).toMatch(frame);
    // Public pages draw only the public frame: GateFrame would bring the signed-in sheet (gate-signed-in.css) with it (D3 fix round 1).
    expect(readFileSync(page, 'utf8')).not.toMatch(/\bGateFrame\b/);
    const src = readFileSync(routeFile, 'utf8');
    let at = -1;
    for (const s of stops) {
      const next = src.indexOf(s, at + 1);
      expect(next, s).toBeGreaterThan(at);
      at = next;
    }
    const pageSrc = readFileSync(page, 'utf8');
    expect(pageSrc).not.toMatch(/<img\b|auth-container|auth-card|auth-logo/);
    expect(pageSrc).not.toMatch(/from 'next\/image'/);
  });

  it('the route words: S-02 and S-03\'s own stops are AUTH_COPY\'s (off S-04\'s first visit), Sign in is GATE_COPY\'s', () => {
    expect(AUTH_COPY.recoveryStops.askForLink).toBe('Ask for a link');
    expect(AUTH_COPY.recoveryStops.setNewPassword).toBe('Set a new password');
    expect(GATE_COPY.stops.signIn).toBe('Sign in');
    expect(JSON.stringify(GATE_COPY)).not.toMatch(/Ask for a link|Set a new password/);
  });
});
