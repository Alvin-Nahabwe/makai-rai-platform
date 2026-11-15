import 'dotenv/config';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import { buildOrg } from '../__tests__/helpers/recordFixture';
import { failOnDialog } from './helpers/dialogs';
import { signInWith } from './helpers/session';

/**
 * Security review 0.7.0, L-1 (UX-01, FR-ACC-04, A7): a client-side navigation from Framework to Controls runs the gates.
 * explore/layout.tsx is shared by both pages, so Next does not re-render it on that navigation; each page now calls
 * requireIdentity itself. Each case opens Framework while the account may still use it, then ends that (sign out
 * everywhere, or a password change made due), then follows a Controls link on the open page, which Next fetches without a
 * full page load.
 *
 * The accounts are a fresh organisation's, not the shared fixture seats: sign out everywhere raises the account's
 * sessionEpoch, which would end every saved storage state of a shared seat (as e2e/rf3-signout-everywhere.spec.ts says).
 */

/** A context of its own, with its own client address (the sign-in limit keys on it, e2e/fixtures/auth.setup.ts). */
async function contextFor(browser: Browser, clientIp: string): Promise<Page> {
  const baseURL = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL, extraHTTPHeaders: { 'x-forwarded-for': clientIp } });
  const page = await ctx.newPage();
  failOnDialog(page);
  return page;
}

/** Signs in, opens Framework and waits until its links are Next's client links (the page has hydrated). */
async function openFramework(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto('/login');
  await signInWith(page, account.email, account.password);
  await page.goto('/explore/framework');
  await expect(page).toHaveURL(/\/explore\/framework$/);
  await page.waitForLoadState('networkidle');
}

/** Follows the first Controls link on the open Framework page as a client-side navigation (no document request). */
async function clickControlsLink(page: Page): Promise<boolean> {
  let documentRequested = false;
  page.on('request', (r) => { if (r.resourceType() === 'document' && new URL(r.url()).pathname === '/explore/controls') documentRequested = true; });
  await page.locator('a[href^="/explore/controls#"]').first().click();
  return documentRequested;
}

test.afterAll(async () => {
  await testDb.$disconnect();
});

test('UX-01 FR-ACC-04 (L-1): after sign out everywhere, a client-side navigation from Framework to Controls goes to sign-in', async ({ browser }) => {
  const fx = await buildOrg({ label: 'l1-revoke' });
  const a = fx.members.assessor;
  const page = await contextFor(browser, '10.47.7.1');
  await openFramework(page, a);
  const out = await page.request.delete('/api/users/me/sessions', { headers: { origin: new URL(page.url()).origin } });
  expect(out.status(), await out.text()).toBe(200);
  const fullLoad = await clickControlsLink(page);
  await expect(page).toHaveURL(/\/login(\?|$)/);
  expect(fullLoad, 'the navigation was a client-side one, not a page load').toBe(false);
  await expect(page.locator('#controls-library-page')).toHaveCount(0);
  await page.context().close();
});

test('UX-01 FR-ACC-04 (L-1): a password change made due while Framework is open sends the Controls link to Change password', async ({ browser }) => {
  const fx = await buildOrg({ label: 'l1-flag' });
  const a = fx.members.assessor;
  const page = await contextFor(browser, '10.47.7.2');
  await openFramework(page, a);
  await testDb.user.update({ where: { id: a.userId }, data: { mustChangePassword: true } });
  const fullLoad = await clickControlsLink(page);
  await expect(page).toHaveURL(/\/change-password$/);
  expect(fullLoad, 'the navigation was a client-side one, not a page load').toBe(false);
  await expect(page.locator('#controls-library-page')).toHaveCount(0);
  await page.context().close();
});
