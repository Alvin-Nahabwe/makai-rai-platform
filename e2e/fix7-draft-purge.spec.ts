import 'dotenv/config';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { buildOrg, type FixtureAccount } from '../__tests__/helpers/recordFixture';
import { draftKeys } from './helpers/session';

/**
 * NFR-PRIV-06 FIX-7: the sign-outs that end this browser's session other than the sidebar's also remove the account's
 * drafts (its reason text) from this device. Accounts are made per test with K0a's buildOrg; each context signs in from
 * its own client address so the per-address sign-in limit is not shared.
 */
let ipSeq = 0;
async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': `10.71.0.${++ipSeq}` } });
  return context.newPage();
}

async function signIn(page: Page, account: Pick<FixtureAccount, 'email' | 'password'>): Promise<void> {
  await page.goto('/login');
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
}

test('NFR-PRIV-06 FR-EXP-03 FIX-7: deleting the account removes its drafts from this browser', async ({ browser }) => {
  test.setTimeout(120_000);
  const fx = await buildOrg({ label: 'e2efix7del' });
  const assessor = fx.members.assessor;
  const page = await newPage(browser);
  await signIn(page, assessor);

  const res = await page.request.post(`/api/v1/orgs/${fx.org.slug}/projects`, { data: { requestId: crypto.randomUUID(), name: `Fix7 ${Date.now()}`, aiSystemType: 'classification' } });
  expect(res.status(), 'project create').toBe(201);
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/orgs/${fx.org.slug}/projects/${id}/stages/pre-processing/questions/Q-PP-01`);
  await expect(page.locator('#question-heading')).toBeVisible();
  await page.waitForFunction(() => document.querySelector('[data-region="answer-form"] form')?.getAttribute('data-ready') === 'true');
  await page.getByLabel('Reason (required)').fill('secret reason text for fix 7');
  expect((await draftKeys(page, assessor.userId)).length, 'a draft is stored').toBe(1);

  await page.goto('/account');
  await page.getByRole('button', { name: 'Delete my account...' }).click();
  await page.locator('input[type="password"][name="password"]').fill(assessor.password);
  await page.getByLabel('Type DELETE MY ACCOUNT to confirm').fill('DELETE MY ACCOUNT');
  await Promise.all([
    page.waitForURL((url) => url.pathname === '/login'),
    page.getByRole('button', { name: 'Delete my account', exact: true }).click(),
  ]);
  expect(await draftKeys(page, assessor.userId)).toEqual([]);
  expect(await page.evaluate((u) => Object.keys(localStorage).filter((k) => k.startsWith(`makrai.draft.v1:${u}:`)), assessor.userId)).toEqual([]);
});

test('NFR-PRIV-06 FIX-7: signing out from the acceptances page removes the account\'s drafts from this browser', async ({ browser }) => {
  const fx = await buildOrg({ label: 'e2efix7acc', acceptances: 'none' });
  const viewer = fx.members.viewer;
  const page = await newPage(browser);
  await signIn(page, viewer);
  await expect(page).toHaveURL(/\/acceptances/);
  // S-12 is behind the acceptance gate, so no draft can be typed for this account; one is stored as the app stores it.
  const key = `makrai.draft.v1:${viewer.userId}:${fx.org.id}:p:q:Q-PP-01`;
  await page.evaluate((k) => localStorage.setItem(k, '{"reason":"secret"}'), key);
  expect(await draftKeys(page, viewer.userId)).toEqual([key]);
  await Promise.all([
    page.waitForURL((url) => url.pathname === '/login'),
    page.locator('form').getByRole('button', { name: 'sign out', exact: true }).click(),
  ]);
  expect(await draftKeys(page, viewer.userId)).toEqual([]);
});

test('NFR-PRIV-06 FIX-7: the invitation page\'s sign-out removes this account\'s drafts from this browser', async ({ browser }) => {
  test.setTimeout(120_000);
  // The viewer is missing the acceptances; the invitation to them is from another organisation, issued over route 25.
  const own = await buildOrg({ label: 'e2efix7invv', acceptances: 'none' });
  const viewer = own.members.viewer;
  const other = await buildOrg({ label: 'e2efix7invo' });
  const inviterPage = await newPage(browser);
  await signIn(inviterPage, other.members.owner);
  const res = await inviterPage.request.post(`/api/v1/orgs/${other.org.slug}/members`, {
    data: { requestId: crypto.randomUUID(), email: viewer.email, role: 'viewer', showLink: true },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { acceptUrl } = (await res.json()) as { acceptUrl: string };
  const found = /^\/invitations\/([^/]+)$/.exec(new URL(acceptUrl, 'http://x').pathname);
  expect(found, 'acceptUrl is /invitations/<token>').not.toBeNull();

  const page = await newPage(browser);
  await signIn(page, viewer);
  await expect(page).toHaveURL(/\/acceptances/);
  await page.goto(`/invitations/${found![1]}`);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  // The route answers acceptances_required, so the form of the missing texts shows, with its sign-out.
  const signOutButton = page.locator('form').getByRole('button', { name: 'sign out', exact: true });
  await expect(signOutButton).toBeVisible();
  const key = `makrai.draft.v1:${viewer.userId}:${own.org.id}:p:q:Q-PP-01`;
  await page.evaluate((k) => localStorage.setItem(k, '{"reason":"secret"}'), key);
  expect(await draftKeys(page, viewer.userId)).toEqual([key]);
  await Promise.all([
    page.waitForURL((url) => url.pathname === '/login'),
    signOutButton.click(),
  ]);
  expect(await draftKeys(page, viewer.userId)).toEqual([]);
});
