import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { failOnDialog } from './helpers/dialogs';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { fillValid, newProject, openQuestion, questionPath, saveStatus } from './helpers/session';
import { QUESTION_COPY } from '../lib/question/copy';
import { STAGE_LIST_COPY } from '../lib/question/list/copy';
import { STATUS_MARK_COPY } from '../lib/ui/copy';

/**
 * The question page's column (owner's decision "Route column", 14 November 2026; plan 1C decision C2): the stage's
 * questions beside the question from 72.5rem, the short form after the guidance below it. Every project is new.
 * The layout's widths at 1150, 1160, 1430 and 1440 are e2e/question-frame.spec.ts's.
 */
const Q = 'Q-PP-01';

test.beforeEach(async ({ page }) => { failOnDialog(page); });

const column = (page: Page) => page.getByRole('navigation', { name: 'Pre-processing', exact: true });

test('at 1280 the column is left of the form with the open question marked; the select narrows it with no page load and writes ?show, which renders the same filter', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  const col = column(page);
  await expect(col).toBeVisible();
  const c = (await col.boundingBox())!;
  const f = (await page.locator('section[data-region="answer-form"]').boundingBox())!;
  expect(f.x).toBeGreaterThanOrEqual(c.x + c.width);
  // The open question: ringed in the row of marks, "You are here" in the list, its topic open.
  await expect(col.locator('.ui-route-row [aria-current="step"]')).toHaveCount(1);
  const plate = col.locator(`.stage-question-list [data-question-id="${Q}"]`);
  await expect(plate.locator('[aria-current="step"]')).toBeVisible();
  await expect(plate).toContainText('You are here');
  await expect(col.locator('details[open]')).toHaveCount(1);
  // No two landmarks share a name: from 1160px the position strip ("Questions in this stage") is hidden, the breadcrumb
  // leads to the stage page, and the column is named by the stage.
  await expect(page.getByRole('navigation', { name: QUESTION_COPY.nav.label, exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb', exact: true }).getByRole('link', { name: 'Pre-processing', exact: true })).toHaveCount(1);
  // The column adds no "All questions" (the decision's way on has its own, workshop walk S9).
  await expect(col.getByRole('link', { name: QUESTION_COPY.nav.allQuestions, exact: true })).toHaveCount(0);
  await expect(col.getByRole('link', { name: QUESTION_COPY.stage.allQuestionsInStage, exact: true })).toBeVisible();

  await page.evaluate(() => { (window as unknown as { __samePage: boolean }).__samePage = true; });
  await col.getByLabel(STAGE_LIST_COPY.form.legend, { exact: true }).selectOption('shortfalls');
  await expect(page).toHaveURL(/\?show=shortfalls$/);
  await expect(col.locator('details')).toHaveCount(0);
  await expect(col.locator('.stage-question-list [data-question-id]')).toHaveCount(0);
  await expect(col).toContainText(STAGE_LIST_COPY.noMatch(STAGE_LIST_COPY.filters.shortfalls).trim());
  expect(await page.evaluate(() => (window as unknown as { __samePage?: boolean }).__samePage), 'no page load').toBe(true);
  await col.getByLabel(STAGE_LIST_COPY.form.legend, { exact: true }).selectOption('no_decision');
  await expect(col.locator('details')).toHaveCount(0);
  const flat = await col.locator('.stage-question-list [data-question-id]').count();
  expect(flat, 'every question of a new project has no decision').toBeGreaterThan(1);

  await page.goto(`${questionPath(projectId, Q)}?show=shortfalls`);
  await expect(column(page).getByLabel(STAGE_LIST_COPY.form.legend, { exact: true })).toHaveValue('shortfalls');
  await expect(column(page)).toContainText(STAGE_LIST_COPY.noMatch(STAGE_LIST_COPY.filters.shortfalls).trim());
});

test('saving a decision in the form updates the open question\'s mark in the column after the save', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openQuestion(page, 'assessor', Q, baseURL!);
  const col = column(page);
  const plate = col.locator(`.stage-question-list [data-question-id="${Q}"]`);
  await expect(plate.locator('.ui-mark__words')).toHaveText(STATUS_MARK_COPY.no_decision);
  await expect(col.locator('.ui-route-row__stop--current')).toHaveAttribute('data-mark-kind', 'no_decision');
  await fillValid(page);
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveStatus(page)).toHaveText(/^Saved at /);
  await expect(col.locator('.ui-route-row__stop--current')).toHaveAttribute('data-mark-kind', 'done');
  await expect(plate.locator('.ui-mark__words')).toHaveText(/^Done/);
});

test('a question left unsaved is "not saved yet" in the column; once it is saved, the column no longer says so (review F1)', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  await fillValid(page);
  await page.goto(questionPath(projectId, Q));
  const plate = column(page).locator(`.stage-question-list [data-question-id="${Q}"]`);
  await expect(plate).toContainText(/not saved yet \(kept in this browser until /);
  await fillValid(page);
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveStatus(page)).toHaveText(/^Saved at /);
  await expect(plate.locator('.ui-mark__words')).toHaveText(/^Done/);
  await expect(plate).not.toContainText('not saved yet');
});

test('at 375 only the short form shows, after the guidance: the stage\'s name, the row of marks with its tally, the link; not the list', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openQuestion(page, 'assessor', Q, baseURL!);
  const col = column(page);
  await expect(col.getByRole('heading', { name: 'Pre-processing' })).toBeVisible();
  await expect(col.locator('.ui-route-row')).toBeVisible();
  await expect(col.locator('.ui-route-row__tally')).toBeVisible();
  await expect(col.getByRole('link', { name: QUESTION_COPY.stage.allQuestionsInStage, exact: true })).toBeVisible();
  await expect(col.locator('.stage-question-list')).toBeHidden();
  await expect(col.getByLabel(STAGE_LIST_COPY.form.legend, { exact: true })).toBeHidden();
  const finding = (await page.locator('section[data-region="finding-link"]').boundingBox())!;
  const c = (await col.boundingBox())!;
  expect(c.y, 'the short form comes after the guidance').toBeGreaterThanOrEqual(finding.y + finding.height);
  await expectNoHorizontalScroll(page);
});

test('no horizontal scroll at 320 by 640 and at 640 by 900 on the 28-question stage', async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  for (const [width, height] of [[320, 640], [640, 900]] as const) {
    await page.setViewportSize({ width, height });
    await openQuestion(page, 'assessor', 'Q-PO-01', baseURL!, projectId);
    await expect(page.getByRole('navigation', { name: 'Post-processing', exact: true }).locator('.ui-route-row__stop')).toHaveCount(28);
    await expectNoHorizontalScroll(page);
  }
});

test('no serious accessibility violation with the column at 1280 and at 375', async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  for (const [width, height] of [[1280, 900], [375, 812]] as const) {
    await page.setViewportSize({ width, height });
    await openQuestion(page, 'assessor', Q, baseURL!, projectId);
    await expect(column(page)).toBeVisible();
    await expectNoSeriousA11yViolations(page, `question page with the column, ${width}`);
  }
});
