import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { testDb } from '../__tests__/helpers/db';
import { addEvidence, addProject, buildOrg, type FixtureAccount } from '../__tests__/helpers/recordFixture';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { expectTargetsAtLeast24px } from './helpers/targetSize';
import { PERSONAL_DATA_COPY } from '../lib/account/copy';

/**
 * S-20 and S-21's data actions on a running server, by keyboard alone (FR-EXP-01, FR-EXP-03, UX-29,
 * NFR-A11Y-02, NFR-A11Y-05): the team export downloads as one ZIP holding export.json; an account is
 * deleted with the password and the typed phrase typed as a password manager or a paste would (insertText),
 * and the browser lands on S-01. Accounts are made per test with K0a's buildOrg.
 */

let ipSeq = 0;
async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ acceptDownloads: true, extraHTTPHeaders: { 'x-forwarded-for': `10.62.0.${++ipSeq}` } });
  return context.newPage();
}

async function signInPage(page: Page, account: Pick<FixtureAccount, 'email' | 'password'>): Promise<void> {
  await page.goto('/login');
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
}

/** Tab until `target` has focus, checking at each press that the focused element is visible and not covered. */
async function tabTo(page: Page, target: Locator, max = 60): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    await expectFocusVisibleAndUncovered(page);
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`tabTo: ${max} presses of Tab did not reach the target`);
}

test.describe('S-20 and S-21 by keyboard', () => {
  test('FR-EXP-01 FR-EXP-03 UX-29 NFR-A11Y-02: export a project and delete an account with the keyboard alone', async ({ browser }) => {
    test.setTimeout(120_000);
    const fx = await buildOrg({ label: 'e2eexp' });
    const projectId = (await addProject(fx, { name: 'Keyboard export' })).id;
    await addEvidence(fx, projectId, { kind: 'file', fileName: 'consent.pdf', bytes: Buffer.from('%PDF-1.4 e2e') });

    const admin = await newPage(browser);
    await signInPage(admin, fx.members.admin);
    await admin.goto(`/orgs/${fx.org.slug}/projects/${projectId}/export`);
    await expect(admin.getByRole('heading', { level: 1, name: 'Team export' })).toBeVisible();
    await expect(admin.getByText('Export Keyboard export: about 1 KB as one ZIP file.')).toBeVisible();
    const link = admin.getByRole('link', { name: 'Download export' });
    await tabTo(admin, link);
    const [download] = await Promise.all([admin.waitForEvent('download'), admin.keyboard.press('Enter')]);
    expect(download.suggestedFilename()).toBe(`makrai-export-${fx.org.slug}-${projectId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.zip`);
    const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['export.json', 'README.txt']));
    await expect(admin.getByRole('status').filter({ hasText: 'Preparing the export.' })).toBeVisible();

    const assessor = fx.members.assessor;
    const page = await newPage(browser);
    await signInPage(page, assessor);
    await page.goto('/account');
    const open = page.getByRole('button', { name: 'Delete my account...' });
    await tabTo(page, open);
    await page.keyboard.press('Enter');
    const password = page.locator('input[type="password"][name="password"]');
    await expect(password).toBeFocused();
    await expect(page.getByText('This cannot be undone.', { exact: false })).toHaveCount(1);   // said once, inside the confirmation
    await expectFocusVisibleAndUncovered(page);
    await page.keyboard.insertText(assessor.password);   // as a paste or a password manager fills it (UX-29)
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Type DELETE MY ACCOUNT to confirm')).toBeFocused();
    await page.keyboard.insertText('DELETE MY ACCOUNT');
    await tabTo(page, page.getByRole('button', { name: 'Delete my account', exact: true }), 5);
    await Promise.all([page.waitForURL((url) => url.pathname === '/login'), page.keyboard.press('Enter')]);
    expect(await testDb.membership.count({ where: { userId: assessor.userId } })).toBe(0);
    expect((await testDb.user.findUniqueOrThrow({ where: { id: assessor.userId } })).name).toBe('Deleted user');
  });

  test('FR-EXP-03 UX-29: a wrong password is said at its field, which takes focus, and nothing is deleted', async ({ browser }) => {
    const fx = await buildOrg({ label: 'e2ewrong' });
    const page = await newPage(browser);
    await signInPage(page, fx.members.viewer);
    await page.goto('/account');
    await page.getByRole('button', { name: 'Delete my account...' }).click();
    await page.locator('input[type="password"][name="password"]').fill('not-the-password');
    await page.getByLabel('Type DELETE MY ACCOUNT to confirm').fill('DELETE MY ACCOUNT');
    await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
    const field = page.locator('input[type="password"][name="password"]');
    await expect(page.getByText('The password is not right.')).toBeVisible();
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(await testDb.membership.count({ where: { userId: fx.members.viewer.userId } })).toBe(1);
    // Cancel closes the confirmation and gives focus back to the button that opened it (UX-42).
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'Delete my account...' })).toBeFocused();
  });

  test('M-38 FR-EXP-03: a last owner sees which organisation needs another owner, and no delete button', async ({ browser }) => {
    const fx = await buildOrg({ label: 'e2elast' });
    const page = await newPage(browser);
    await signInPage(page, fx.members.owner);
    await page.goto('/account');
    await expect(page.getByText(`You are the only owner of ${fx.org.name} with an active account. Make someone else an owner first, then delete your account.`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete my account...' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: PERSONAL_DATA_COPY.download })).toBeVisible();
  });

  test('NFR-A11Y-04 NFR-A11Y-05: S-20 and the S-21 confirmation have no serious axe violation in both themes at 1280 and 360 pixels, 24-pixel targets, no loss at 320 pixels', async ({ browser }) => {
    test.setTimeout(180_000);
    const fx = await buildOrg({ label: 'e2ea11y' });
    const projectId = (await addProject(fx)).id;
    const owner = await newPage(browser);
    await signInPage(owner, fx.members.owner);
    const viewer = await newPage(browser);
    await signInPage(viewer, fx.members.viewer);
    const screens: Array<[string, Page, string, () => Promise<void>]> = [
      ['S-20', owner, `/orgs/${fx.org.slug}/export?refused=export_busy`, async () => {}],
      ['S-20 project', owner, `/orgs/${fx.org.slug}/projects/${projectId}/export`, async () => {}],
      ['S-21 confirm', viewer, '/account', async () => { await viewer.getByRole('button', { name: 'Delete my account...' }).click(); }],
    ];
    for (const [screen, page, path, prepare] of screens) {
      for (const colorScheme of ['light', 'dark'] as const) for (const width of [1280, 360]) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await prepare();
        await expectNoSeriousA11yViolations(page, `${screen} ${colorScheme} ${width}`);
        await expectTargetsAtLeast24px(page);
      }
      await page.setViewportSize({ width: 320, height: 900 });
      await page.goto(path);
      await prepare();
      await expectNoHorizontalScroll(page);
    }
  });
});
