import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { test, expect, type Browser, type Page, type Request, type Route } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import { buildOrg, type FixtureAccount, type OrgFixture } from '../__tests__/helpers/recordFixture';
import { draftKeys } from './helpers/session';
import { INVITATION_COPY } from '../lib/invitations/copy';
import { ACCEPTANCES_COPY } from '../lib/legal/acceptances/copy';
import { closeOpenedContexts } from './helpers/contexts';

// Every context a test opened is closed after it (helpers/contexts.ts says why).
test.afterEach(closeOpenedContexts);

/**
 * NFR-PERF-02 NFR-PRIV-06, ruling T16-Q11: the invitation page's M-24 Sign out, the acceptances form's "sign out" and
 * the sign-in after an account is created load their code only when pressed. These cases hold or fail that late load
 * and read what a person meets: the busy state, one sign-out request, the failure line, a retry with no reload, and the
 * created-account sentence when the sign-in library cannot load.
 *
 * The late chunk is caught without its name (in a production build chunk names are hashed): once the page has settled,
 * every script request under /_next/ is the late load.
 */

let ipSeq = 0;
async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': `10.73.0.${++ipSeq}` } });
  return context.newPage();
}

async function signIn(page: Page, account: Pick<FixtureAccount, 'email' | 'password'>): Promise<void> {
  await page.goto('/login');
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
}

async function invitationFor(fx: OrgFixture, email: string): Promise<string> {
  const raw = randomBytes(32).toString('hex');
  await testDb.invitation.create({ data: {
    orgId: fx.org.id, email, role: 'viewer', tokenHash: createHash('sha256').update(raw).digest('hex'),
    invitedById: fx.members.owner.userId, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  } });
  return raw;
}

const isLateScript = (url: URL, request: Request) => url.pathname.startsWith('/_next/') && request.resourceType() === 'script';

/** From now on, script requests under /_next/ wait until `release` is called; the held URLs are counted. */
async function holdLateScripts(page: Page): Promise<{ held: () => number; release: () => Promise<void> }> {
  const waiting: Route[] = [];
  let count = 0;
  let released = false;
  await page.route((url) => url.pathname.startsWith('/_next/'), async (route) => {
    if (released || !isLateScript(new URL(route.request().url()), route.request())) return route.continue();
    count += 1;
    waiting.push(route);
  });
  return {
    held: () => count,
    release: async () => {
      released = true;
      for (const r of waiting.splice(0)) await r.continue();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    },
  };
}

/** From now on, script requests under /_next/ fail as a lost connection does; the failed URLs are counted. */
async function failLateScripts(page: Page): Promise<{ failed: () => number; stop: () => Promise<void> }> {
  let count = 0;
  const handler = async (route: Route) => {
    if (!isLateScript(new URL(route.request().url()), route.request())) return route.continue();
    count += 1;
    return route.abort('connectionfailed');
  };
  const match = (url: URL) => url.pathname.startsWith('/_next/');
  await page.route(match, handler);
  return { failed: () => count, stop: () => page.unroute(match, handler) };
}

/** The POSTs this page sends to the sign-out endpoint. */
function countSignOutPosts(page: Page): () => number {
  let n = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/auth/signout') n += 1; });
  return () => n;
}

/** Account B, signed in, opens an invitation addressed to someone else: M-24 and its Sign out. */
async function wrongAccountPage(browser: Browser, label: string) {
  const issuer = await buildOrg({ label: `${label}i` });
  const b = await buildOrg({ label: `${label}b` });
  const invited = `${label}-someone-else-${Date.now()}@fixture.test`;
  const raw = await invitationFor(issuer, invited);
  const viewer = b.members.viewer;
  const wrongAccount = INVITATION_COPY.wrongAccount(viewer.email, invited);
  const page = await newPage(browser);
  await signIn(page, viewer);
  await page.goto(`/invitations/${raw}`);
  await expect(page.getByRole('alert').filter({ hasText: wrongAccount })).toBeVisible();
  const key = `makrai.draft.v1:${viewer.userId}:${b.org.id}:p:q:Q-PP-01`;
  await page.evaluate((k) => localStorage.setItem(k, '{"reason":"secret"}'), key);
  await page.waitForLoadState('networkidle');
  return { page, viewer, key, raw, wrongAccount };
}

/** An account missing its acceptances, signed in: /acceptances with its "sign out". */
async function acceptancesPage(browser: Browser, label: string) {
  const fx = await buildOrg({ label, acceptances: 'none' });
  const viewer = fx.members.viewer;
  const page = await newPage(browser);
  await signIn(page, viewer);
  await expect(page).toHaveURL(/\/acceptances/);
  const key = `makrai.draft.v1:${viewer.userId}:${fx.org.id}:p:q:Q-PP-01`;
  await page.evaluate((k) => localStorage.setItem(k, '{"reason":"secret"}'), key);
  await page.waitForLoadState('networkidle');
  return { page, viewer, key };
}

/** Whether the page's own browser context is still signed in, read in a second tab so the first is not reloaded. */
async function stillSignedInAt(page: Page, path: string, signedIn: (tab: Page) => Promise<void>): Promise<void> {
  const tab = await page.context().newPage();
  await tab.goto(path);
  await signedIn(tab);
  await tab.close();
}

test.describe('T16-Q11: the sign-out controls load their code when pressed', () => {
  test('NFR-PERF-02 T16-Q11: a slow load at the acceptances form\'s sign out keeps it busy and focused, and two presses send one sign-out', async ({ browser }) => {
    const { page, viewer } = await acceptancesPage(browser, 'lateslowb');
    const posts = countSignOutPosts(page);
    const control = page.locator('form').getByRole('button', { name: ACCEPTANCES_COPY.signOut, exact: true });
    const hold = await holdLateScripts(page);
    await control.click();
    await expect.poll(hold.held).toBeGreaterThan(0);
    await control.click();
    await expect(control).toHaveAttribute('aria-busy', 'true');
    await expect(control).toBeFocused();
    await expect(control).toBeEnabled();
    expect(posts()).toBe(0);
    await Promise.all([page.waitForURL((url) => url.pathname === '/login'), hold.release()]);
    expect(posts()).toBe(1);
    expect(await draftKeys(page, viewer.userId)).toEqual([]);
    await page.context().close();
  });

  test('NFR-PERF-02 T16-Q11: a slow load at the invitation page\'s Sign out keeps it busy and focused, and two presses send one sign-out', async ({ browser }) => {
    test.setTimeout(120_000);
    const { page, viewer } = await wrongAccountPage(browser, 'lateslowa');
    const posts = countSignOutPosts(page);
    const control = page.getByRole('button', { name: INVITATION_COPY.signOut, exact: true });
    const hold = await holdLateScripts(page);
    await control.click();
    await expect.poll(hold.held).toBeGreaterThan(0);
    await control.click();
    await expect(control).toHaveAttribute('aria-busy', 'true');
    await expect(control).toBeFocused();
    expect(posts()).toBe(0);
    await hold.release();
    // The sign-out returns to this same page, signed out.
    await expect(page.getByRole('heading', { name: INVITATION_COPY.createHeading })).toBeVisible();
    expect(posts()).toBe(1);
    expect(await draftKeys(page, viewer.userId)).toEqual([]);
    await page.context().close();
  });

  test('NFR-PRIV-06 T16-Q11 T16-31: a failed load at the acceptances form\'s sign out says the person is still signed in, keeps the drafts, and a second press signs out', async ({ browser }) => {
    const { page, viewer, key } = await acceptancesPage(browser, 'latefailb');
    const posts = countSignOutPosts(page);
    const control = page.locator('form').getByRole('button', { name: ACCEPTANCES_COPY.signOut, exact: true });
    const alert = page.locator('form [role="alert"]').filter({ hasText: ACCEPTANCES_COPY.stillSignedIn });
    const fail = await failLateScripts(page);
    await control.click();
    await expect(alert).toHaveText(ACCEPTANCES_COPY.stillSignedIn);
    expect(fail.failed()).toBeGreaterThan(0);
    await expect(control).toBeVisible();
    await expect(control).not.toHaveAttribute('aria-busy', 'true');
    await expect(control).toBeFocused();
    expect(new URL(page.url()).pathname).toBe('/acceptances');
    expect(posts()).toBe(0);
    expect(await draftKeys(page, viewer.userId)).toEqual([key]);
    await stillSignedInAt(page, '/acceptances', async (tab) => {
      await expect(tab.getByRole('heading', { level: 1, name: ACCEPTANCES_COPY.legend })).toBeVisible();
    });

    // The same page, no reload: the next press loads the code again and signs out.
    await fail.stop();
    // The scripts the retry requests before its sign-out request (after it, the browser loads the next page).
    const scripts: string[] = [];
    page.on('request', (r) => { if (posts() === 0 && isLateScript(new URL(r.url()), r)) scripts.push(new URL(r.url()).pathname); });
    await Promise.all([page.waitForURL((url) => url.pathname === '/login'), control.click()]);
    console.log(`retry after a failed load requested ${scripts.length} script(s) under /_next/: ${scripts.join(', ')}`);
    expect(scripts.length, 'the retry loads the code again').toBeGreaterThan(0);
    expect(posts()).toBe(1);
    expect(await draftKeys(page, viewer.userId)).toEqual([]);
    await page.context().close();
  });

  test('NFR-PRIV-06 T16-Q11 T16-31: a failed load at the invitation page\'s Sign out says the person is still signed in, keeps the drafts, and a second press signs out', async ({ browser }) => {
    test.setTimeout(120_000);
    const { page, viewer, key, raw, wrongAccount } = await wrongAccountPage(browser, 'latefaila');
    const posts = countSignOutPosts(page);
    const control = page.getByRole('button', { name: INVITATION_COPY.signOut, exact: true });
    const alert = page.getByRole('alert').filter({ hasText: ACCEPTANCES_COPY.stillSignedIn });
    const fail = await failLateScripts(page);
    await control.click();
    await expect(alert).toHaveText(ACCEPTANCES_COPY.stillSignedIn);
    expect(fail.failed()).toBeGreaterThan(0);
    await expect(control).toBeVisible();
    await expect(control).not.toHaveAttribute('aria-busy', 'true');
    await expect(control).toBeFocused();
    expect(posts()).toBe(0);
    expect(await draftKeys(page, viewer.userId)).toEqual([key]);
    await stillSignedInAt(page, `/invitations/${raw}`, async (tab) => {
      await expect(tab.getByRole('alert').filter({ hasText: wrongAccount })).toBeVisible();
    });

    await fail.stop();
    // The scripts the retry requests before its sign-out request (after it, the browser loads the next page).
    const scripts: string[] = [];
    page.on('request', (r) => { if (posts() === 0 && isLateScript(new URL(r.url()), r)) scripts.push(new URL(r.url()).pathname); });
    await control.click();
    await expect(page.getByRole('heading', { name: INVITATION_COPY.createHeading })).toBeVisible();
    console.log(`retry after a failed load requested ${scripts.length} script(s) under /_next/: ${scripts.join(', ')}`);
    expect(scripts.length, 'the retry loads the code again').toBeGreaterThan(0);
    expect(posts()).toBe(1);
    expect(await draftKeys(page, viewer.userId)).toEqual([]);
    await page.context().close();
  });

  test('FR-ACC-01 T16-Q11: when the sign-in library cannot load after Create account, S-04 says the account was created, and signing in with the typed password works', async ({ browser }) => {
    test.setTimeout(120_000);
    const fx = await buildOrg({ label: 'latesignin' });
    const email = `latesignin-${Date.now()}@fixture.test`;
    const password = 'Late-signin-password-ok';
    const raw = await invitationFor(fx, email);
    const page = await newPage(browser);
    let fail: Awaited<ReturnType<typeof failLateScripts>> | null = null;
    const statuses: number[] = [];
    await page.route('**/api/v1/invitations/*/register', async (route) => {
      const reply = await route.fetch();
      statuses.push(reply.status());
      // The account is created; from here the sign-in library's load fails.
      fail = await failLateScripts(page);
      await route.fulfill({ response: reply });
    });
    await page.goto(`/invitations/${raw}`);
    await page.waitForLoadState('networkidle');
    await page.getByLabel(INVITATION_COPY.name).fill('Late Sign In');
    await page.locator('#new-password').fill(password);
    await page.getByRole('button', { name: INVITATION_COPY.continue }).click();
    for (const box of await page.getByRole('checkbox').all()) await box.check();
    await page.getByRole('button', { name: INVITATION_COPY.createAccount }).click();
    const created = page.getByRole('alert').filter({ hasText: INVITATION_COPY.accountCreated });
    await expect(created).toHaveText(INVITATION_COPY.accountCreated);
    expect(statuses).toEqual([201]);
    expect(fail!.failed()).toBeGreaterThan(0);
    // The link follows the alert directly (the page header has a Sign in link of its own).
    const link = created.locator('xpath=following-sibling::p[1]').getByRole('link', { name: INVITATION_COPY.signIn, exact: true });
    await expect(link).toHaveAttribute('href', `/login?callbackUrl=${encodeURIComponent(`/orgs/${fx.org.slug}/dashboard?welcome=1`)}`);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await link.click();
    await page.waitForURL((url) => url.pathname === '/login');
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`**/orgs/${fx.org.slug}/dashboard?welcome=1`);
    await page.context().close();
  });
});
