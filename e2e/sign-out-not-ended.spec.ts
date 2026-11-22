import 'dotenv/config';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import { buildOrg, type FixtureAccount } from '../__tests__/helpers/recordFixture';
import { signInWith } from './helpers/session';
import { ACCEPTANCES_COPY } from '../lib/legal/acceptances/copy';
import { GATE_COPY, SHELL_COPY } from '../lib/shell/copy';
import { closeOpenedContexts } from './helpers/contexts';

// Every context a test opened is closed after it (helpers/contexts.ts says why).
test.afterEach(closeOpenedContexts);

/**
 * Lead's ruling L5-11 (d1-sfh F3): when next-auth cannot fetch its CSRF token, its sign-out answers with
 * `/login?error=MissingCSRF` and the session is NOT ended. A sign-out then never navigates: the gate frame's Sign out says
 * the person is still signed in and stays on the page, and a second press, once the token can be fetched, signs out. The
 * rail's Sign out stays on the page too (it has no failure line of its own yet: a lane-3 row). The failed fetch is forced
 * with a route that answers /api/auth/csrf with a gateway's HTML error page.
 */
let ipSeq = 0;
async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': `10.74.0.${++ipSeq}` }, viewport: { width: 1280, height: 800 } });
  return context.newPage();
}
const CSRF = /\/api\/auth\/csrf(\?|$)/;
const failCsrf = (page: Page) => page.route(CSRF, (r) => r.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }));

async function signIn(page: Page, a: Pick<FixtureAccount, 'email' | 'password'>): Promise<void> {
  await page.goto('/login');
  await signInWith(page, a.email, a.password);
}

test.afterAll(async () => { await testDb.$disconnect(); });

test('L5-11: a gate-frame sign-out whose CSRF token cannot be fetched says still signed in, stays, and signs out on the retry', async ({ browser }) => {
  const fx = await buildOrg({ label: 'l511gate' });
  const a = fx.members.viewer;
  await testDb.user.update({ where: { id: a.userId }, data: { mustChangePassword: true } });
  const page = await newPage(browser);
  await signIn(page, a);
  await page.goto('/change-password');
  await expect(page).toHaveURL(/\/change-password$/);
  await page.waitForLoadState('networkidle');

  await failCsrf(page);
  const signOut = page.getByRole('banner').getByRole('button', { name: GATE_COPY.signOut });
  await signOut.click();
  await expect(page.getByRole('alert').filter({ hasText: ACCEPTANCES_COPY.stillSignedIn })).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe('/change-password');
  // Still signed in, as the line says: the server still serves the gated page.
  const res = await page.request.get('/change-password', { maxRedirects: 0 });
  expect(res.status()).toBe(200);

  await page.unroute(CSRF);
  await signOut.click();
  await page.waitForURL(/\/login(\?|$)/, { timeout: 30_000 });
  expect(new URL(page.url()).searchParams.has('error')).toBe(false);
  await page.goto('/change-password');
  await expect(page).toHaveURL(/\/login/);
  await page.context().close();
});

test('L5-11: the rail\'s Sign out with no CSRF token stays on the page, signed in', async ({ browser }) => {
  const fx = await buildOrg({ label: 'l511rail' });
  const page = await newPage(browser);
  await signIn(page, fx.members.assessor);
  await page.goto('/account');
  await page.waitForLoadState('networkidle');
  await failCsrf(page);
  const signOutRequests: string[] = [];
  page.on('request', (r) => { if (/\/api\/auth\/signout/.test(r.url())) signOutRequests.push(r.method()); });
  await page.getByRole('button', { name: SHELL_COPY.signOut, exact: true }).click();
  await expect.poll(() => signOutRequests.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  expect(new URL(page.url()).pathname).toBe('/account');
  const res = await page.request.get('/account', { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  await page.context().close();
});
