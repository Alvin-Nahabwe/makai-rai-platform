import 'dotenv/config';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import { buildOrg, type FixtureAccount } from '../__tests__/helpers/recordFixture';
import { currentLegalText } from '../lib/legal/registry';
import { ACCEPT_LABEL } from '../components/legal/AcceptancesForm';
import { LEGAL_CHANGE_SUMMARIES, LEGAL_COPY } from '../lib/legal/copy';
import { LEGAL_KIND_NAMES } from '../lib/legal/kinds';
import { ACCEPTED_KINDS } from '../types/legal';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { closeOpenedContexts } from './helpers/contexts';

// Every context a test opened is closed after it (helpers/contexts.ts says why).
test.afterEach(closeOpenedContexts);

/**
 * Plan 1B Task 7 Step 6 (spec 9.8): an account that accepted version 1 of the three texts sees, on S-05, which texts
 * changed, from version 1 to the current one, and the owner-approved summary of what changed before each box; it accepts
 * and reaches Home, or chooses Sign out. Each account is made per test with buildOrg ('version-1'), and each context signs
 * in from its own client address.
 */
let ipSeq = 0;
const nextClientIp = () => `10.47.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

async function signedIn(browser: Browser, account: Pick<FixtureAccount, 'email' | 'password'>): Promise<Page> {
  const page = await (await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': nextClientIp() } })).newPage();
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await expect(async () => {
    await page.fill('#email', account.email);
    await page.fill('#password', account.password);
    await page.waitForTimeout(300);
    await expect(page.locator('#email')).toHaveValue(account.email, { timeout: 100 });
    await expect(page.locator('#password')).toHaveValue(account.password, { timeout: 100 });
  }).toPass({ timeout: 20_000 });
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
  return page;
}

test.afterAll(async () => {
  await testDb.$disconnect();
});

test.describe('S-05 tells a version-1 account what changed', () => {
  test('9.8: a version-1 account sees the three changed texts with their summaries before their boxes, accepts, and reaches Home', async ({ browser }) => {
    const fx = await buildOrg({ label: 'whatchanged', acceptances: 'version-1' });
    const page = await signedIn(browser, fx.members.assessor);
    await expect(page).toHaveURL(/\/acceptances$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(LEGAL_COPY.changes.heading);
    for (const kind of ACCEPTED_KINDS) {
      const { version } = currentLegalText(kind);
      const title = page.getByRole('heading', { level: 2, name: LEGAL_COPY.changes.title(LEGAL_KIND_NAMES[kind], '1', version) });
      await expect(title).toBeVisible();
      const summary = page.getByText(LEGAL_CHANGE_SUMMARIES[kind][version], { exact: true });
      await expect(summary).toBeVisible();
      // The summary comes before its box.
      const [s, b] = await Promise.all([summary.boundingBox(), page.getByLabel(ACCEPT_LABEL[kind], { exact: true }).boundingBox()]);
      expect(s!.y).toBeLessThan(b!.y);
    }
    await expect(page.getByRole('heading', { level: 3, name: LEGAL_COPY.changes.whatChanged })).toHaveCount(3);
    await expectNoSeriousA11yViolations(page, 'S-05 with what changed');
    await page.setViewportSize({ width: 320, height: 640 });
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const kind of ACCEPTED_KINDS) await page.getByLabel(ACCEPT_LABEL[kind], { exact: true }).check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    await page.waitForURL((url) => url.pathname !== '/acceptances');
    const res = await page.goto(`/orgs/${fx.org.slug}/dashboard`);
    expect(res?.status()).toBe(200);
    await page.context().close();
  });

  test('9.8: the same screen offers Sign out, which signs the account out', async ({ browser }) => {
    const fx = await buildOrg({ label: 'whatchangedout', acceptances: 'version-1' });
    const page = await signedIn(browser, fx.members.viewer);
    await expect(page).toHaveURL(/\/acceptances$/);
    await page.getByRole('main').getByRole('button', { name: 'sign out' }).click();
    await page.waitForURL((url) => url.pathname === '/login');
    await page.goto('/acceptances');
    await expect(page).toHaveURL(/\/login/);
    await page.context().close();
  });
});
