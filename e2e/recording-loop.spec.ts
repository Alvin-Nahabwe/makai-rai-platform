import { expect, test, type Page } from '@playwright/test';
import { failOnDialog } from './helpers/dialogs';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { actAsSeat, newProject, seatOf, stagePath } from './helpers/session';
import { STAGE_LIST_COPY } from '../lib/question/list/copy';

/**
 * Plan 1C Task 3, All questions (page variant): the "Show" filter as chips with JavaScript off and on, the 28-question
 * stage reflowing at 320 px (Review Focus 4), and a browser that blocks storage (Review Focus 5). Every project is new,
 * so every question has no decision. Question counts are 0.0.1-fixture's: post-processing holds 28.
 */
test.beforeEach(async ({ page }) => { failOnDialog(page); });

const radio = (page: Page, name: string) => page.getByRole('radio', { name, exact: true });

test('the Show filter works with JavaScript off (the noscript Show) and on (no page load)', async ({ browser, page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  const off = await browser.newContext({ javaScriptEnabled: false, storageState: seatOf('assessor').storageStatePath });
  try {
    const p = await off.newPage();
    await p.goto(stagePath(projectId, 'pre-processing'));
    await expect(p.locator('[data-question-id]')).toHaveCount(24);
    await radio(p, `${STAGE_LIST_COPY.filters.shortfalls} 0`).check();
    await p.getByRole('button', { name: STAGE_LIST_COPY.form.submit, exact: true }).click();
    await p.waitForURL(/\?show=shortfalls$/);
    await expect(p.locator('[data-question-id]')).toHaveCount(0);
    await expect(p.getByText(STAGE_LIST_COPY.noMatch(STAGE_LIST_COPY.filters.shortfalls).trim())).toBeVisible();
    await expect(radio(p, `${STAGE_LIST_COPY.filters.shortfalls} 0`)).toBeChecked();
  } finally {
    await off.close();
  }

  await actAsSeat(page, 'assessor');
  await page.goto(stagePath(projectId, 'pre-processing'));
  await expect(page.locator('[data-question-id]')).toHaveCount(24);
  await page.evaluate(() => { (window as unknown as { __samePage: boolean }).__samePage = true; });
  await radio(page, `${STAGE_LIST_COPY.filters.shortfalls} 0`).check();
  await expect(page.locator('[data-question-id]')).toHaveCount(0);
  expect(new URL(page.url()).search).toBe('?show=shortfalls');
  await radio(page, `${STAGE_LIST_COPY.filters.noDecision} 24`).check();
  await expect(page.locator('[data-question-id]')).toHaveCount(24);
  expect(new URL(page.url()).search).toBe('?show=no_decision');
  expect(await page.evaluate(() => (window as unknown as { __samePage?: boolean }).__samePage)).toBe(true);   // replaceState, no load
});

test('Review Focus 4: the 28-question stage has no horizontal scroll at 320 by 640 and at 640 by 900, and no serious axe finding at 320', async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  await actAsSeat(page, 'assessor');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(stagePath(projectId, 'post-processing'));
  await expect(page.locator('[data-question-id]')).toHaveCount(28);
  await expect(page.locator('.ui-route-row__stop')).toHaveCount(28);
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page, 'S-11 post-processing at 320 by 640');
  await page.setViewportSize({ width: 640, height: 900 });
  await expectNoHorizontalScroll(page);
});

test('Review Focus 5: with storage blocked, "Not saved yet" shows no count, never 0, and the line says this browser cannot keep the text', async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
  });
  await actAsSeat(page, 'assessor');
  await page.goto(stagePath(projectId, 'pre-processing'));
  await expect(page.getByText(STAGE_LIST_COPY.noStorage, { exact: true })).toBeVisible();
  await expect(radio(page, STAGE_LIST_COPY.filters.drafts)).toBeVisible();
  await expect(page.locator('main')).not.toContainText(`${STAGE_LIST_COPY.filters.drafts} 0`);
  await expect(page.getByRole('group', { name: STAGE_LIST_COPY.form.legend })).toHaveAccessibleDescription(STAGE_LIST_COPY.noStorage);
});
