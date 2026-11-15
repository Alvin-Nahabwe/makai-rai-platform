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

/**
 * Follows the first Controls link on the open Framework page and answers two readings, taken when asked (after the
 * redirect has landed, since Next may still fall back to a full load after the click resolves): whether a document was
 * requested for /explore/controls (a full load), and whether the router fetched it as a flight request (header `rsc: 1`,
 * not a prefetch), which shows the client-side path ran.
 */
async function clickControlsLink(page: Page): Promise<{ fullLoad: () => boolean; clientFetch: () => boolean }> {
  let documentRequested = false;
  let flightFetched = false;
  page.on('request', (r) => {
    if (new URL(r.url()).pathname !== '/explore/controls') return;
    if (r.resourceType() === 'document') documentRequested = true;
    const h = r.headers();
    if (h['rsc'] === '1' && h['next-router-prefetch'] === undefined) flightFetched = true;
  });
  await page.locator('a[href^="/explore/controls#"]').first().click();
  return { fullLoad: () => documentRequested, clientFetch: () => flightFetched };
}

/** After the redirect: the navigation was the router's own flight request, and no page load of Controls happened. */
function expectClientSideNavigation(nav: { fullLoad: () => boolean; clientFetch: () => boolean }): void {
  expect(nav.clientFetch(), 'the router fetched /explore/controls as a flight request').toBe(true);
  expect(nav.fullLoad(), 'no document request for /explore/controls (not a page load)').toBe(false);
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
  const nav = await clickControlsLink(page);
  await expect(page).toHaveURL(/\/login(\?|$)/);
  expectClientSideNavigation(nav);
  await expect(page.locator('#controls-library-page')).toHaveCount(0);
  await page.context().close();
});

test('UX-01 FR-ACC-04 (L-1): a password change made due while Framework is open sends the Controls link to Change password', async ({ browser }) => {
  const fx = await buildOrg({ label: 'l1-flag' });
  const a = fx.members.assessor;
  const page = await contextFor(browser, '10.47.7.2');
  await openFramework(page, a);
  await testDb.user.update({ where: { id: a.userId }, data: { mustChangePassword: true } });
  const nav = await clickControlsLink(page);
  await expect(page).toHaveURL(/\/change-password$/);
  expectClientSideNavigation(nav);
  await expect(page.locator('#controls-library-page')).toHaveCount(0);
  await page.context().close();
});
