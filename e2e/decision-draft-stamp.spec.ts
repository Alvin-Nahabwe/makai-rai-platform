import { expect, test, type Page } from '@playwright/test';
import { failOnDialog } from './helpers/dialogs';
import { draftValues, openQuestion, openWhoWhen, waitForQuestionPage } from './helpers/session';
import { UI_COPY } from '../lib/ui/copy';

/**
 * Answer cost, design 2026-11-22 section 8: "A defaulted date in a draft from an earlier day becomes today", in the browser.
 * The form's own draft write (DecisionForm's `keep`) marks the stored record (lib/question/draft.ts `stampDraft`), and only a
 * marked record's `dateChanged` is trusted on restore; without the mark a decider-only draft keeps the earlier day's date.
 * The days are set with page.clock.setFixedTime (the page's Date only; timers run as usual). Both are before the date these
 * runs were written, so neither is a future date for the form's checks.
 */
const Q = 'Q-PP-01';
const DAY1 = new Date('2026-11-20T10:00:00');
const DAY2 = new Date('2026-11-24T10:00:00');

type StoredRecord = { dateChangedCurrent?: unknown; value: { date: unknown; dateChanged: unknown; whoWhenChanged: unknown } };

/** The one stored draft on this page, parsed, once the form has written it. */
async function storedRecord(page: Page): Promise<StoredRecord> {
  await expect.poll(async () => (await draftValues(page)).length).toBe(1);
  return JSON.parse((await draftValues(page))[0]) as StoredRecord;
}

async function dateBoxes(page: Page): Promise<{ day: string; month: string; year: string }> {
  return {
    day: await page.getByLabel(UI_COPY.date.day, { exact: true }).inputValue(),
    month: await page.getByLabel(UI_COPY.date.month, { exact: true }).inputValue(),
    year: await page.getByLabel(UI_COPY.date.year, { exact: true }).inputValue(),
  };
}

/** Reloads the question on DAY2 and opens "Decided by" and "Decided on", so the restored values can be read. */
async function reopenOnDay2(page: Page): Promise<void> {
  await page.clock.setFixedTime(DAY2);
  await page.reload();
  await waitForQuestionPage(page);
  await openWhoWhen(page);
}

test.beforeEach(async ({ page }) => { failOnDialog(page); });

test('UX-26 answer cost 8: a "Decided by"-only draft is marked by the form, and restored on a later day it shows that day', async ({ page, baseURL }) => {
  await page.clock.setFixedTime(DAY1);
  await openQuestion(page, 'assessor', Q, baseURL!);
  await openWhoWhen(page);
  await page.locator('#decision-decided-by').selectOption('role:supervisor');
  const stored = await storedRecord(page);
  expect(stored.dateChangedCurrent).toBe(true);
  expect(stored.value).toMatchObject({ dateChanged: false, whoWhenChanged: true, date: { day: '20', month: '11', year: '2026' } });

  await reopenOnDay2(page);
  expect(await dateBoxes(page)).toEqual({ day: '24', month: '11', year: '2026' });
  await expect(page.locator('#decision-decided-by')).toHaveValue('role:supervisor');
});

test('UX-26 answer cost 8: a date the person typed is marked as theirs, and restored on a later day it is kept', async ({ page, baseURL }) => {
  await page.clock.setFixedTime(DAY1);
  await openQuestion(page, 'assessor', Q, baseURL!);
  await openWhoWhen(page);
  await page.getByLabel(UI_COPY.date.day, { exact: true }).fill('3');
  const stored = await storedRecord(page);
  expect(stored.dateChangedCurrent).toBe(true);
  expect(stored.value).toMatchObject({ dateChanged: true, date: { day: '3', month: '11', year: '2026' } });

  await reopenOnDay2(page);
  expect(await dateBoxes(page)).toEqual({ day: '3', month: '11', year: '2026' });
});
