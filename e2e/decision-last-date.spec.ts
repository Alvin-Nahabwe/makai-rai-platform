import { expect, test } from '@playwright/test';
import { failOnDialog } from './helpers/dialogs';
import { actAsSeat, fillValid, openQuestionIn, saveStatus, waitForQuestionPage } from './helpers/session';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';

/**
 * I5, as the owner ruled (15 Nov 2026, 19:30, "Empty, show last date"): after a save, the card for the next version
 * keeps the Decided on boxes empty, so every version's date is entered on purpose, and names the current version's
 * date at its precision beside them, in the group's description. Today is still offered.
 */
const Q = 'Q-PP-01';
const F = DECISION_FORM_COPY;

test.beforeEach(async ({ page }) => { failOnDialog(page); });

for (const [w, h] of [[1280, 800], [375, 812]] as const) {
  test(`I5: at ${w} by ${h}, after a save the card shows "Last decided on <date>" beside empty date boxes, and each box names it`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await actAsSeat(page, 'admin'); await openQuestionIn(page, Q);
    await expect(page.getByText(/^Last decided on /)).toHaveCount(0);
    await fillValid(page, { day: '', month: '3', year: '2026' });
    await page.locator('.decision-save-bar').getByRole('button', { name: F.save, exact: true }).click();
    await expect(saveStatus(page)).toHaveText(/as version 1\./);
    for (const pass of ['after the save', 'after a reload']) {
      if (pass === 'after a reload') { await page.reload(); await waitForQuestionPage(page); }
      const line = page.locator('fieldset.ui-date').getByText(F.lastDecidedOn('Mar 2026'), { exact: true });
      await expect(line, pass).toBeVisible();
      for (const part of ['Day', 'Month', 'Year']) {
        const box = page.getByLabel(part, { exact: true });
        await expect(box, `${pass}: ${part} is empty`).toHaveValue('');
        await expect(box, `${pass}: ${part} names the line`).toHaveAccessibleDescription(new RegExp(`^${F.lastDecidedOn('Mar 2026')} `));
      }
      await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible();
    }
  });
}
