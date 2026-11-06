import { test, expect } from '@playwright/test';

/**
 * NFR-SEC password-in-URL (unit FIXPW). Before React has hydrated, a native submit of the sign-in form must not put
 * the password in a URL: the form names method="post" and its button is disabled until hydration. With JavaScript
 * off the page never hydrates, which is that window held open for good.
 */
test.describe('Sign-in form before hydration', () => {
  test('NFR-SEC: with JavaScript off, pressing Sign in sends no request whose URL holds the password', async ({ browser }) => {
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
    // Both ways a person submits: the button, and Enter in the password field.
    await button.click({ force: true });
    await page.locator('#password').press('Enter');
    await page.waitForTimeout(500);

    expect(urls.filter((u) => /password=/i.test(u) || /email=/i.test(u))).toEqual([]);
    expect(new URL(page.url()).search).toBe('');
    expect(statuses.filter((s) => s >= 500)).toEqual([]);
    await context.close();
  });

  test('NFR-SEC: a native POST of the sign-in form to /login is answered without a server error and without a query', async ({ browser }) => {
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '10.46.7.2' } });
    const res = await context.request.post('/login', { form: { email: 'nobody@example.test', password: 'Not-A-Real-Pw-1' }, maxRedirects: 0 });
    expect(res.status()).toBeLessThan(500);
    expect(new URL(res.url()).search).toBe('');
    await context.close();
  });
});
