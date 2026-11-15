import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Plan 1B Task 3: S-29's forced change and S-21's voluntary change in the gate frame's card (T3.1 to T3.3). The form's
 * answers (422 under the field, 400 at the top) are __tests__/unit/account-page.test.tsx's.
 */
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));

const { ChangePasswordView } = await import('@/app/(gate)/change-password/ChangePasswordForm');
const { AUTH_COPY, CHANGE_PASSWORD_COPY } = await import('@/lib/auth/copy');

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (el: React.ReactElement) => html(el).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const noop = () => {};
const view = (forced: boolean) => (
  <ChangePasswordView forced={forced} currentPassword="" newPassword="" show={false} state={{ kind: 'idle' }}
    onCurrent={noop} onNew={noop} onToggleShow={noop} onSubmit={noop} />
);

describe('S-29 and S-21\'s change in the gate frame (plan 1B Task 3)', () => {
  it('forced: the heading, forcedLead then changeLead, and no link at all (T3.2)', () => {
    const t = text(view(true));
    expect(html(view(true))).toContain(`>${AUTH_COPY.titles.changePassword}</h1>`);
    expect(t.indexOf(AUTH_COPY.forcedLead)).toBeGreaterThan(-1);
    expect(t.indexOf(AUTH_COPY.changeLead)).toBeGreaterThan(t.indexOf(AUTH_COPY.forcedLead));
    expect(html(view(true))).not.toMatch(/<a\b/);
    expect(t).not.toContain(CHANGE_PASSWORD_COPY.backToAccount);
  });

  it('voluntary: changeLead only, and "Back to My account" after the form', () => {
    const t = text(view(false));
    expect(t).toContain(AUTH_COPY.changeLead);
    expect(t).not.toContain(AUTH_COPY.forcedLead);
    expect(html(view(false))).toMatch(new RegExp(`<a [^>]*href="/account"[^>]*>${CHANGE_PASSWORD_COPY.backToAccount}</a>`));
    expect(t.indexOf(CHANGE_PASSWORD_COPY.backToAccount)).toBeGreaterThan(t.indexOf(CHANGE_PASSWORD_COPY.submit));
  });

  it('both use current-password for the current field and new-password for the new one, in a post form', () => {
    for (const forced of [true, false]) {
      const h = html(view(forced));
      expect(h).toMatch(/<input[^>]*id="currentPassword"[^>]*autocomplete="current-password"/i);
      expect(h).toMatch(/<input[^>]*id="newPassword"[^>]*autocomplete="new-password"/i);
      expect(h).toMatch(/<form [^>]*method="post"/);
    }
  });

  it('the error line sits after the submit button (spec 9.7)', () => {
    const h = html(<ChangePasswordView forced={false} currentPassword="x" newPassword="y" show={false} state={{ kind: 'error', message: 'E-1' }}
      onCurrent={noop} onNew={noop} onToggleShow={noop} onSubmit={noop} />);
    const form = /<form[^>]*>([\s\S]*?)<\/form>/.exec(h)?.[1] ?? '';
    expect(form.indexOf('<div role="alert"')).toBeGreaterThan(form.indexOf('type="submit"'));
    expect(form).toContain('E-1');
  });

  it('T3.1: forced comes from the identity on the server, never from the address; the title is the page\'s', () => {
    const page = readFileSync('app/(gate)/change-password/page.tsx', 'utf8');
    expect(page).toMatch(/forced=\{identity\.mustChangePassword\}/);
    expect(page).not.toMatch(/searchParams|useSearchParams/);
    expect(page).toMatch(/title: pageTitle\(AUTH_COPY\.titles\.changePassword\)/);
  });

  it('T3.3: after a change the flow is unchanged: sign out to S-01 with the changed notice, drafts kept', () => {
    const form = readFileSync('app/(gate)/change-password/ChangePasswordForm.tsx', 'utf8');
    expect(form).toContain("await signOut({ callbackUrl: '/login?passwordChanged=1' });");
    expect(form).not.toMatch(/signOutClearingDrafts|purgeAccount/);
  });
});
