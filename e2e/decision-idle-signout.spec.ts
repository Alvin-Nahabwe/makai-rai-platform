import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { failOnDialog } from './helpers/dialogs';
import { draftKeys, fillValid, openQuestionIn, saveAlert, seatOf, signInAs, signInOnLoginPage, waitForQuestionPage } from './helpers/session';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { REASON_OPTIONAL } from '../lib/decision/copy';
import { DECISION_OUTCOME_COPY } from '../lib/decision/outcome/copy';
import { IDLE_TEXTS } from '../lib/auth/session/copy';
import { AUTH_COPY } from '../lib/auth/copy';
import { closeOpenedContexts } from './helpers/contexts';

// Every context a test opened is closed after it (helpers/contexts.ts says why).
test.afterEach(closeOpenedContexts);

/**
 * Review Focus RF-3 (FR-DEC-06, UX-26, UX-43; call R-53): a draft survives an idle sign-out and returns after sign-in
 * on the same device and account, and **Sign in again** returns to the same question on this origin (B7).
 *
 * Runs in a Playwright command of its own with MAKRAI_TEST_IDLE_SECONDS=180 in its environment, which Playwright's
 * webServer passes to the server it starts (with MAKRAI_TEST_SEAMS=1 from playwright.config.ts): 180 seconds is the
 * floor of lib/auth/idle.ts. Without it the session lasts 12 hours and this spec is skipped.
 */
const Q = 'Q-PP-01';
const IDLE = process.env.MAKRAI_TEST_IDLE_SECONDS === '180';
const PURGE_AT_SIGN_IN = spawnSync('git', ['grep', '-l', '-E', '\\.purgeOtherAccounts\\(', '--', 'app', 'components']).stdout.toString().trim() !== '';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('FR-DEC-06 UX-26 UX-43: a draft survives an idle sign-out and returns after sign-in', async ({ browser }) => {
  test.skip(!IDLE, 'needs MAKRAI_TEST_IDLE_SECONDS=180 in this command\'s environment (Task 7 Step 2)');
  // The session ends idleLimitSeconds() (180) after signInAs; page loads, the project write and typing do not move it.
  test.setTimeout(300_000);
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  failOnDialog(page);
  await signInAs(page, 'assessor');
  await openQuestionIn(page, Q);
  const questionPath = new URL(page.url()).pathname;
  // A valid answer, so the browser's own field check (M-11) does not answer before the server can (Save sends only a valid draft).
  await fillValid(page, { reason: 'Typed before the idle limit' });
  const sessionCookie = (await ctx.cookies()).find((c) => /session-token/.test(c.name))!;
  expect(sessionCookie.expires).toBeGreaterThan(Date.now() / 1000);   // a dated cookie; -1 would be a session cookie and the wait below would not wait
  await page.waitForTimeout(sessionCookie.expires * 1000 - Date.now() + 5_000);   // the cookie's own expiry plus 5 s, no request in between
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });     // UI's warning has closed itself
  // Plan 1B Task 4 (C12): the signed-out notice says the 12-hour rule, outside the page's <main>; the form is not inert.
  await expect(page.getByRole('alert').filter({ hasText: IDLE_TEXTS.endedIdle })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveAlert(page)).toHaveText(DECISION_OUTCOME_COPY.save.signedOut);
  // The form's own Sign in again (the notice's, outside <main>, goes to the same address).
  await page.getByRole('main').getByRole('link', { name: IDLE_TEXTS.signInAgain }).click();
  await expect(page.getByText(AUTH_COPY.signedOutIdle)).toBeVisible({ timeout: 10_000 });
  await signInOnLoginPage(page, 'assessor');
  await expect(page).toHaveURL(new RegExp(`^${escape(new URL(page.url()).origin)}${escape(questionPath)}$`));
  await waitForQuestionPage(page);
  await expect(page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${REASON_OPTIONAL}`)).toHaveValue('Typed before the idle limit');
  if (PURGE_AT_SIGN_IN) {
    await ctx.clearCookies();
    await signInAs(page, 'viewer');
    expect(await draftKeys(page, seatOf('assessor').userId)).toEqual([]);
  } else {
    test.info().annotations.push({ type: 'pending', description: 'the last step (another account\'s sign-in removes this draft) waits for ACC-b purgeOtherAccounts' });
  }
  await ctx.close();
});
