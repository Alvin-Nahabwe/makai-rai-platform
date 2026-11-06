import { test, expect } from '@playwright/test';

/**
 * NFR-SEC password-in-URL (unit FIXPW). Before React has hydrated, a native submit of the sign-in form must not put
 * the password in a URL. Two layers hold that: the submit button is disabled until hydration, and the form names
 * method="post" for a submit that gets past the button (a password manager or extension calling form.submit(), or a
 * later change that drops the gate). Each test below holds one layer in place and checks the other's outcome.
 */
test.describe('Sign-in form before hydration', () => {
  test('NFR-SEC: with JavaScript off, the Sign In button is disabled and pressing it sends no request holding the password', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: { 'x-forwarded-for': '10.46.7.1' } });
    const page = await context.newPage();
    const urls: string[] = [];
    const statuses: number[] = [];
    page.on('request', (r) => urls.push(r.url()));
    page.on('response', (r) => statuses.push(r.status()));

    const res = await page.goto('/login');
    expect(res?.status()).toBe(200);
    await page.fill('#email', 'nobody@example.test');
    await page.fill('#password', 'Not-A-Real-Pw-1');
    const button = page.getByRole('button', { name: 'Sign In' });
    await expect(button).toBeDisabled();
    const before = urls.length;
    // Both ways a person submits: the button, and Enter in the password field.
    await button.click({ force: true });
    await page.locator('#password').press('Enter');
    // Nothing is sent: give a wrongly enabled form time to navigate, then the request count must be unchanged.
    await page.waitForTimeout(500);
    expect(urls.length).toBe(before);

    expect(urls.filter((u) => /password=/i.test(u) || /email=/i.test(u))).toEqual([]);
    expect(new URL(page.url()).search).toBe('');
    expect(statuses.filter((s) => s >= 500)).toEqual([]);
    await context.close();
  });

  test('NFR-SEC: with hydration blocked, a form.submit() that bypasses the button is a POST and no URL holds the password', async ({ browser }) => {
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '10.46.7.3' } });
    const page = await context.newPage();
    // JavaScript is on, but the app's chunks never load, so the page stays as the server rendered it.
    await page.route('**/_next/static/chunks/**', (route) => route.abort());
    await page.goto('/login');
    await page.fill('#email', 'nobody@example.test');
    await page.fill('#password', 'Not-A-Real-Pw-1');
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeDisabled();

    // The page has loaded, so the next main-frame navigation request is the submit.
    const navigation = page.waitForRequest((r) => r.isNavigationRequest() && r.frame() === page.mainFrame());
    await page.locator('form').evaluate((f) => (f as HTMLFormElement).submit());
    const sent = await navigation;

    expect(sent.method()).toBe('POST');
    expect(sent.url()).not.toMatch(/password=|email=/i);
    expect(new URL(page.url()).search).toBe('');
    await context.close();
  });

  test('NFR-SEC: a form-encoded POST to /login is answered without a server error', async ({ browser }) => {
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '10.46.7.2' } });
    const res = await context.request.post('/login', { form: { email: 'nobody@example.test', password: 'Not-A-Real-Pw-1' }, maxRedirects: 0 });
    expect(res.status()).toBeLessThan(500);
    await context.close();
  });
});
