import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test, type BrowserContext } from '@playwright/test';
import { failOnDialog } from './helpers/dialogs';
import { draftKeys, openQuestion, openQuestionIn, seatOf, signInAs } from './helpers/session';

/**
 * Drafts across accounts and sign-out (UX-26, NFR-PRIV-06, M-41; preventive obligations B2 and B4). Q is a fixture id.
 *
 * The removal of other accounts' drafts at sign-in is ACC-b's call of `purgeOtherAccounts` (contract K0b rows). Until a
 * page or component under app/ or components/ calls it, the case that checks it is skipped with that reason; it runs by
 * itself once the call exists. S-21 is ACC-b's page: its case runs once `app/(authenticated)/account/page.tsx` exists.
 */
const Q = 'Q-PP-01';
const PURGE_AT_SIGN_IN = spawnSync('git', ['grep', '-l', '-E', '\\.purgeOtherAccounts\\(', '--', 'app', 'components']).stdout.toString().trim() !== '';
const S21_EXISTS = existsSync('app/(authenticated)/account/page.tsx');

/** The session ends without the sign-out control, as an idle expiry does: no client code runs, so drafts stay (R-53). */
async function signOutViaMenuKeepingDrafts(ctx: BrowserContext): Promise<void> {
  await ctx.clearCookies();
}

test.beforeEach(async ({ page }) => { failOnDialog(page); });

test('UX-26 NFR-PRIV-06 B2: a second account on the same browser sees no draft of the first', async ({ browser }) => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  failOnDialog(page);
  await signInAs(page, 'assessor');
  await openQuestionIn(page, Q);
  await page.getByLabel('Reason (required)').fill('Assessor draft');
  expect(await draftKeys(page, seatOf('assessor').userId)).toHaveLength(1);
  await signOutViaMenuKeepingDrafts(ctx);
  await signInAs(page, 'admin');
  await openQuestionIn(page, Q);
  await expect(page.getByLabel('Reason (required)')).toHaveValue('');
  expect(await draftKeys(page, seatOf('admin').userId)).toEqual([]);
  await ctx.close();
});

test('UX-26 NFR-PRIV-06: sign-in removes the first account\'s draft keys', async ({ browser }) => {
  test.skip(!PURGE_AT_SIGN_IN, 'ACC-b purgeOtherAccounts at sign-in: no page or component calls it yet (merges_after: ACC-b)');
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await signInAs(page, 'assessor');
  await openQuestionIn(page, Q);
  await page.getByLabel('Reason (required)').fill('Assessor draft');
  await signOutViaMenuKeepingDrafts(ctx);
  await signInAs(page, 'admin');
  expect(await draftKeys(page, seatOf('assessor').userId)).toEqual([]);
  await ctx.close();
});

test('UX-26 M-41 B4: signing out with a draft warns, and Delete them and sign out leaves no draft key', async ({ page, baseURL }) => {
  await openQuestion(page, 'assessor', Q, baseURL!);
  await page.getByLabel('Reason (required)').fill('x');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('You have 1 answers on this device that are not saved. If you sign out, they are deleted from this device.')).toBeVisible();
  await expect(page.getByRole('alertdialog')).toBeFocused();
  await expect(page.getByRole('link', { name: 'Go to them' })).toHaveAttribute('href', '/account#drafts-on-this-device');
  await page.getByRole('button', { name: 'Delete them and sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await draftKeys(page)).toEqual([]);
});

test('M-41: with no draft, Sign out signs out at once', async ({ page, baseURL }) => {
  await openQuestion(page, 'viewer', Q, baseURL!);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
});

test('NFR-PRIV-06 B4: a draft older than 7 days is gone after reload', async ({ page, baseURL }) => {
  await page.clock.install();
  await openQuestion(page, 'assessor', Q, baseURL!);
  await page.getByLabel('Reason (required)').fill('old');
  expect(await draftKeys(page)).toHaveLength(1);
  await page.clock.fastForward(8 * 24 * 60 * 60 * 1000);   // 8 days
  await page.reload();
  await expect(page.locator('#question-heading')).toBeVisible();
  await page.waitForFunction(() => document.querySelector('[data-region="answer-form"] form')?.getAttribute('data-ready') === 'true');
  expect(await draftKeys(page)).toEqual([]);
  await expect(page.getByLabel('Reason (required)')).toHaveValue('');
});

test('UX-26: S-21 shows Drafts on this device: 1 and Delete removes it', async ({ page, baseURL }) => {
  test.skip(!S21_EXISTS, 'ACC-b S-21: app/(authenticated)/account/page.tsx does not exist yet (merges_after: ACC-b)');
  await openQuestion(page, 'assessor', Q, baseURL!);
  await page.getByLabel('Reason (required)').fill('kept');
  await page.goto('/account');
  await expect(page.locator('#drafts-on-this-device').getByRole('status')).toHaveText('Drafts on this device: 1');
  await page.locator('#drafts-on-this-device').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#drafts-on-this-device').getByRole('status')).toHaveText('Drafts on this device: 0');
  expect(await draftKeys(page)).toEqual([]);
});
