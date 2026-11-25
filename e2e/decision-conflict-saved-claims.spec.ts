import { expect, test, type Page } from '@playwright/test';
import { failOnDialog } from './helpers/dialogs';
import { fillValid, openQuestion, saveViaApi, waitForQuestionPage } from './helpers/session';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { UI_COPY } from '../lib/ui/copy';

/**
 * UI review of v0.11.0, finding I2 (Claude outputs/2026-11-25-v0.11.0-ui-skills-review.md): in a conflict the page kept the
 * server-rendered "Saved as version 1" (the corner on a wide screen, the green saved block on a phone) and the foot's "This decision
 * is saved on the platform." beside "Not saved. A newer version was saved while you worked." While the conflict view is shown, no
 * saved claim about the version the person started from is on screen; the conflict view itself names the newer saved version.
 */
const Q = 'Q-PP-01';

test.beforeEach(async ({ page }) => { failOnDialog(page); });

/** A conflict over an answer this person saved as version 1: a colleague saves version 2 while the page is open at version 1. */
async function conflictOverSaved(page: Page, baseURL: string): Promise<void> {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL);
  expect((await saveViaApi(baseURL, 'assessor', projectId, Q, { reason: 'Version 1' })).status).toBe(201);
  await page.reload(); await waitForQuestionPage(page);
  // The page shows version 1 as saved before the conflict (the claim the conflict must not leave on screen).
  await expect(page.getByText(/Saved as version 1\b/).filter({ visible: true }).first()).toBeVisible();
  await fillValid(page, { reason: 'Mine' });
  expect((await saveViaApi(baseURL, 'owner', projectId, Q, { baseVersionNumber: 1, reason: 'Owner saved first' })).status).toBe(201);
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(page.getByRole('heading', { name: DECISION_FORM_COPY.conflict.heading })).toBeFocused({ timeout: 15_000 });
}

for (const width of [1280, 375]) {
  test(`I2 at ${width} px: in a conflict, no saved claim about version 1 sits beside "Not saved"`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    await conflictOverSaved(page, baseURL!);
    await expect(page.getByText(/Saved as version 1\b/).filter({ visible: true })).toHaveCount(0);
    await expect(page.getByText(UI_COPY.saved.onPlatform, { exact: true }).filter({ visible: true })).toHaveCount(0);
    // The conflict view still names the newer saved version.
    await expect(page.locator('[data-region="conflict"]').getByRole('heading', { name: DECISION_FORM_COPY.conflict.saved(2), exact: true })).toBeVisible();
  });
}
