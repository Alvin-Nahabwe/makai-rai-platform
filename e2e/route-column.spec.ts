import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { failOnDialog } from './helpers/dialogs';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { fillValid, newProject, openQuestion, questionPath, saveStatus, saveViaApi, seatOf, stagePath } from './helpers/session';
import { QUESTION_COPY } from '../lib/question/copy';
import { STAGE_LIST_COPY } from '../lib/question/list/copy';
import { STATUS_MARK_COPY } from '../lib/ui/copy';

/**
 * The question page's column (owner's decision "Route column", 14 November 2026; owner's answer R1, 15 November 2026: the
 * stage's questions as one line, lane 1 Task 2): the questions on one line in stage order, the open one "You are here" in
 * the ring, the next one named, the others folded into runs that open in place, and the filter as a small select above
 * the line. Every project is new. Pre-processing holds 24 questions in 0.0.1-fixture, post-processing 28.
 */
const Q = 'Q-PP-01';

test.beforeEach(async ({ page }) => { failOnDialog(page); });

const column = (page: Page) => page.getByRole('navigation', { name: 'Pre-processing', exact: true });
const row = (page: Page, id: string) => column(page).locator(`.stage-question-list [data-question-id="${id}"]`);
/** The line's rows the reader can see now (a closed run's rows are not). */
const visibleRows = (page: Page) => column(page).locator('.stage-question-list [data-question-id]:visible');

test('at 1280 the column is left of the form: the open question "You are here", the next one named, the far ones folded; the select narrows it with no page load and writes ?show', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  const col = column(page);
  await expect(col).toBeVisible();
  const c = (await col.boundingBox())!;
  const f = (await page.locator('section[data-region="answer-form"]').boundingBox())!;
  expect(f.x).toBeGreaterThanOrEqual(c.x + c.width);
  // The open question: one row, aria-current, "You are here"; the next one says "Next question".
  await expect(col.locator('[aria-current="step"]')).toHaveCount(1);
  await expect(row(page, Q).locator('[aria-current="step"]')).toBeVisible();
  await expect(row(page, Q)).toContainText(STAGE_LIST_COPY.line.youAreHere);
  await expect(row(page, 'Q-PP-02')).toContainText(STAGE_LIST_COPY.line.next);
  // No row of marks any more: the line is the route.
  await expect(col.locator('.ui-route-row')).toHaveCount(0);
  // No two landmarks share a name: the strip keeps "Questions in this stage", the column is named by the stage.
  await expect(page.getByRole('navigation', { name: QUESTION_COPY.nav.label, exact: true })).toHaveCount(1);
  await expect(col.getByRole('link', { name: QUESTION_COPY.nav.allQuestions, exact: true })).toHaveCount(0);
  await expect(col.getByRole('link', { name: QUESTION_COPY.stage.allQuestionsInStage, exact: true })).toBeVisible();

  await page.evaluate(() => { (window as unknown as { __samePage: boolean }).__samePage = true; });
  await col.getByLabel(STAGE_LIST_COPY.form.legend, { exact: true }).selectOption('shortfalls');
  await expect(page).toHaveURL(/\?show=shortfalls$/);
  await expect(col.locator('.stage-question-list [data-question-id]')).toHaveCount(0);
  await expect(col).toContainText(STAGE_LIST_COPY.noMatch(STAGE_LIST_COPY.filters.shortfalls).trim());
  expect(await page.evaluate(() => (window as unknown as { __samePage?: boolean }).__samePage), 'no page load').toBe(true);
  // With a filter, every matching question is on the line, unfolded.
  await col.getByLabel(STAGE_LIST_COPY.form.legend, { exact: true }).selectOption('no_decision');
  await expect(col.locator('details')).toHaveCount(0);
  await expect(visibleRows(page)).toHaveCount(24);

  await page.goto(`${questionPath(projectId, Q)}?show=shortfalls`);
  await expect(column(page).getByLabel(STAGE_LIST_COPY.form.legend, { exact: true })).toHaveValue('shortfalls');
  await expect(column(page)).toContainText(STAGE_LIST_COPY.noMatch(STAGE_LIST_COPY.filters.shortfalls).trim());
});

test('a folded run opens in place by keyboard and every question of the stage stays reachable, with scripts on and off', async ({ browser, page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const projectId = await openQuestion(page, 'assessor', 'Q-PP-04', baseURL!);
  const col = column(page);
  const runs = col.locator('details.route-line__run');
  await expect(runs).toHaveCount(2);
  const all = col.locator('.stage-question-list [data-question-id]');
  await expect(all).toHaveCount(24);
  const shown = await visibleRows(page).count();
  expect(shown, 'some questions are folded').toBeLessThan(24);
  const last = runs.last().locator('summary');
  await expect(last).toContainText(/^Questions 8 to 24/);
  await last.focus();
  await page.keyboard.press('Enter');
  await expect(runs.last()).toHaveAttribute('open', '');
  expect(await visibleRows(page).count()).toBeGreaterThan(shown);
  await expect(runs.last().locator('[data-question-id]').first().getByRole('link')).toBeVisible();

  const off = await browser.newContext({ javaScriptEnabled: false, storageState: seatOf('assessor').storageStatePath });
  try {
    const p = await off.newPage();
    await p.setViewportSize({ width: 1280, height: 900 });
    await p.goto(questionPath(projectId, 'Q-PP-04'));
    const first = column(p).locator('details.route-line__run').first();
    await first.locator('summary').click();
    await expect(first.locator('[data-question-id="Q-PP-01"] a')).toBeVisible();
  } finally {
    await off.close();
  }
});

test('saving a decision in the form updates the open question\'s status in the column after the save', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openQuestion(page, 'assessor', Q, baseURL!);
  await expect(row(page, Q).locator('.status-label')).toHaveText(STATUS_MARK_COPY.no_decision);
  await expect(row(page, Q).locator('[data-mark-kind]')).toHaveAttribute('data-mark-kind', 'no_decision');
  await fillValid(page);
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveStatus(page)).toHaveText(/^Saved at /);
  await expect(row(page, Q).locator('[data-mark-kind]')).toHaveAttribute('data-mark-kind', 'done');
  await expect(row(page, Q).locator('.status-label')).toHaveText(/^Done/);
  await expect(row(page, Q)).toContainText(STAGE_LIST_COPY.line.version(1));
});

test('a question left unsaved is "not saved yet" in the column; once it is saved, the column no longer says so (review F1)', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  await fillValid(page);
  await page.goto(questionPath(projectId, Q));
  await expect(row(page, Q)).toContainText(/not saved yet \(kept in this browser until /);
  await fillValid(page);
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveStatus(page)).toHaveText(/^Saved at /);
  await expect(row(page, Q).locator('.status-label')).toHaveText(/^Done/);
  await expect(row(page, Q)).not.toContainText('not saved yet');
});

test('at 375 the column follows the main content and shows the same line, folded, with the filter and the link', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openQuestion(page, 'assessor', 'Q-PP-04', baseURL!);
  const col = column(page);
  await expect(col.getByRole('heading', { name: 'Pre-processing' })).toBeVisible();
  await expect(col.getByLabel(STAGE_LIST_COPY.form.legend, { exact: true })).toBeVisible();
  await expect(row(page, 'Q-PP-04')).toContainText(STAGE_LIST_COPY.line.youAreHere);
  await expect(col.locator('details.route-line__run')).toHaveCount(2);
  await expect(col.getByRole('link', { name: QUESTION_COPY.stage.allQuestionsInStage, exact: true })).toBeVisible();
  const finding = (await page.locator('section[data-region="finding-link"]').boundingBox())!;
  const c = (await col.boundingBox())!;
  expect(c.y, 'the column comes after the main content').toBeGreaterThanOrEqual(finding.y + finding.height);
  await expectNoHorizontalScroll(page);
});

test('no horizontal scroll at 320 by 640 and at 640 by 900 on the 28-question stage', async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  for (const [width, height] of [[320, 640], [640, 900]] as const) {
    await page.setViewportSize({ width, height });
    await openQuestion(page, 'assessor', 'Q-PO-01', baseURL!, projectId);
    await expect(page.getByRole('navigation', { name: 'Post-processing', exact: true }).locator('[data-question-id]')).toHaveCount(28);
    await expectNoHorizontalScroll(page);
  }
});

test('no serious accessibility violation with the column at 1280 and at 375', async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  for (const [width, height] of [[1280, 900], [375, 812]] as const) {
    await page.setViewportSize({ width, height });
    await openQuestion(page, 'assessor', 'Q-PP-04', baseURL!, projectId);
    await expect(column(page)).toBeVisible();
    await expectNoSeriousA11yViolations(page, `question page with the column, ${width}`);
  }
});

/**
 * Screenshots for the lane's own look and the finish review (lane 1 Task 2): the question page's column and the stage
 * page at 1280 by 800, 1440 by 900 and 375 by 812, on a project with a few decisions and an unsaved draft. They are
 * written to test-results/route-shots/ and assert nothing beyond the page having loaded.
 */
test('screenshots of the column and the stage page at 1280, 1440 and 375', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const projectId = await newProject(baseURL!);
  for (const [q, status] of [['Q-PP-01', 'done'], ['Q-PP-02', 'done'], ['Q-PP-03', 'partly'], ['Q-PP-04', 'partly']] as const) {
    expect((await saveViaApi(baseURL!, 'assessor', projectId, q, { status })).status).toBe(201);
  }
  await openQuestion(page, 'assessor', 'Q-PP-05', baseURL!, projectId);
  await fillValid(page, { reason: 'A draft left in this browser' });
  const dir = 'test-results/route-shots';
  mkdirSync(dir, { recursive: true });
  for (const [width, height] of [[1280, 800], [1440, 900], [375, 812]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(questionPath(projectId, 'Q-PP-04'));
    await expect(column(page)).toBeVisible();
    await page.screenshot({ path: `${dir}/question-${width}-first-view.png` });
    await column(page).screenshot({ path: `${dir}/column-${width}.png` });
    await page.goto(stagePath(projectId, 'pre-processing'));
    await expect(page.locator('[data-question-id]')).toHaveCount(24);
    await page.screenshot({ path: `${dir}/stage-${width}-first-view.png` });
    await page.screenshot({ path: `${dir}/stage-${width}-full.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(stagePath(projectId, 'pre-processing'));
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: `${dir}/stage-320-full.png`, fullPage: true });
});
