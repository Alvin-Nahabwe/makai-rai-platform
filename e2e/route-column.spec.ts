import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { failOnDialog } from './helpers/dialogs';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { actAsSeat, expectMovedOn, fillValid, fixtureOrgSlug, newProject, openQuestion, questionPath, saveViaApi, seatOf, seatRequest, stagePath } from './helpers/session';
import { QUESTION_COPY } from '../lib/question/copy';
import { STAGE_LIST_COPY } from '../lib/question/list/copy';
import { STATUS_MARK_COPY } from '../lib/ui/copy';
import { closeOpenedContexts } from './helpers/contexts';

// Every context a test opened is closed after it (helpers/contexts.ts says why).
test.afterEach(closeOpenedContexts);

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
  await expect(last).toContainText(/^Questions 7 to 24/);
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
  await expectMovedOn(page, Q);
  await expect(row(page, Q).locator('[data-mark-kind]')).toHaveAttribute('data-mark-kind', 'done');
  await expect(row(page, Q).locator('.status-label')).toHaveText(/^Done/);
  // The open question's own row names its version: the saved line's way back opens it (a client navigation, the column kept).
  await page.locator('[data-saved-arrival]').getByRole('link', { name: 'Back to question 1' }).click();
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
  await expectMovedOn(page, Q);
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
  // A writer's finding link sits in the decision card (no separate finding-link section), so the main content is measured whole.
  const main = (await page.locator('.question-workspace__main').boundingBox())!;
  const c = (await col.boundingBox())!;
  expect(c.y, 'the column comes after the main content').toBeGreaterThanOrEqual(main.y + main.height);
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

test('the stage page, as the route\'s page variant, has no horizontal scroll at 320 by 640', async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  await actAsSeat(page, 'assessor');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(stagePath(projectId, 'pre-processing'));
  await expect(page.locator('[data-question-id]')).toHaveCount(24);
  await expectNoHorizontalScroll(page);
});

test('fix round 5 (S3-N7): the first-use (i) on a stage-page row sits right of the title, on its first line, and adds no height, at 1440, 1280, 375 and 320', async ({ page, baseURL }, testInfo) => {
  const projectId = await newProject(baseURL!);
  await actAsSeat(page, 'assessor');
  for (const [width, height] of [[1440, 900], [1280, 800], [375, 812], [320, 640]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(stagePath(projectId, 'in-processing'));
    // Q-IP-12, "Have you created or updated a model card for this model?", is the page's first use of "model card".
    const row = page.locator('[data-question-id="Q-IP-12"]');
    await expect(row.locator('.route-line__tips .ui-term-tip')).toHaveCount(1);
    const m = await row.evaluate((li) => {
      const box = (el: Element) => el.getBoundingClientRect();
      const title = li.querySelector('.route-line__title')!;
      const tip = li.querySelector('.ui-term-tip__button')!;
      return {
        li: box(li), link: box(li.querySelector(':scope > a')!), title: box(title), tip: box(tip),
        line: parseFloat(getComputedStyle(title).lineHeight),
      };
    });
    const at = `${width}x${height}`;
    expect(m.tip.left, `${at}: the (i) starts right of the title's start (not in the mark column)`).toBeGreaterThan(m.title.left);
    expect(m.tip.right, `${at}: the (i) is inside the row`).toBeLessThanOrEqual(m.li.right + 0.5);
    expect(m.tip.left - m.title.right, `${at}: the (i) follows the words closely, not at the far edge of the row`).toBeLessThanOrEqual(24);
    expect(Math.abs(m.tip.top + m.tip.height / 2 - (m.title.top + m.line / 2)), `${at}: the (i) is level with the title's first line`).toBeLessThanOrEqual(4);
    expect(m.li.height, `${at}: the (i) adds no height to the row`).toBeLessThanOrEqual(m.link.height + 2);
    if (width === 1440 || width === 375) {
      await row.screenshot({ path: testInfo.outputPath(`stage-row-tip-${width}.png`), animations: 'disabled' });
      await page.screenshot({ path: testInfo.outputPath(`stage-${width}-first-view.png`), animations: 'disabled' });
    }
  }
});

test('fix round 3 (S3-N1): with the personal data question answered and every kind in the tally, the stage page reflows at 320 by 640', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const projectId = await newProject(baseURL!);
  const ctx = await seatRequest(baseURL!, 'assessor');
  try {
    const save = async (questionId: string, over: Record<string, unknown>) => {
      const res = await ctx.post(`/api/v1/orgs/${fixtureOrgSlug()}/projects/${projectId}/decisions`, { data: {
        requestId: crypto.randomUUID(), stage: 'pre-processing', questionId, baseVersionNumber: null, status: 'done', scopeAnswer: null,
        optionsInPlace: [], reasonCode: null, reason: 'Saved through the API for the reflow check',
        decidedBy: { kind: 'outside_role', role: 'supervisor' }, declaredDate: '2026-10-12', evidenceIds: [], ...over,
      } });
      expect(res.status(), `${questionId}: ${await res.text()}`).toBe(201);
    };
    await save('Q-PP-GATE-SENSITIVE', { status: null, scopeAnswer: 'yes' });
    // Ten done (a two-digit count, with no evidence attached), then one of each other status.
    for (const q of ['Q-PP-01', 'Q-PP-02', 'Q-PP-03', 'Q-PP-04', 'Q-PP-05', 'Q-PP-06', 'Q-PP-07', 'Q-PP-08', 'Q-PP-09', 'Q-PP-10']) await save(q, {});
    await save('Q-PP-11', { status: 'partly' });
    await save('Q-PP-12', { status: 'not_yet', reasonCode: 'ny_planned_later' });
    await save('Q-PP-13', { status: 'not_applicable', reasonCode: 'na_other' });
  } finally {
    await ctx.dispose();
  }
  await actAsSeat(page, 'assessor');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(stagePath(projectId, 'pre-processing'));
  const parts = page.locator('.stage-route__tally-part');
  await expect(parts).toHaveCount(6);
  await expect(page.locator('.stage-route__tally')).toContainText('personal data question answered');
  for (const box of await parts.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))) expect(box).toBeLessThanOrEqual(320);
  // Every (i) is beside its word: none starts a line of its own.
  for (const [tip, word] of await page.locator('.stage-route__keep:has(.ui-term-tip)').evaluateAll((els) => els.map((e) => {
    const t = e.querySelector('.ui-term-tip')!.getBoundingClientRect(); const r = document.createRange(); r.selectNodeContents(e.firstChild!);
    const w = r.getBoundingClientRect(); return [t.top, w.top];
  }))) expect(Math.abs(tip - word)).toBeLessThan(12);
  await expectNoHorizontalScroll(page);
  await page.locator('.stage-route__tally').screenshot({ path: testInfo.outputPath('stage-tally-320.png') });
});

/**
 * Screenshots for the lane's own look and the finish review (lane 1 Task 2): the question page's column and the stage
 * page at 1280 by 800, 1440 by 900 and 375 by 812, on a project with a few decisions and an unsaved draft. Only on
 * request (CAPTURE=1 in the environment of the Playwright run); written to test-results/route-shots/, asserting nothing
 * beyond the pages having loaded.
 */
test('screenshots of the column and the stage page at 1280, 1440 and 375, dark, and Save all (CAPTURE=1 only)', async ({ page, baseURL }) => {
  test.skip(process.env.CAPTURE !== '1', 'screenshots are taken only with CAPTURE=1');
  test.setTimeout(180_000);
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
  await page.screenshot({ path: `${dir}/stage-320-full.png`, fullPage: true });
  // The marks on the line in dark mode too (design fix round 1, S2-1: the halo in light and dark).
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(questionPath(projectId, 'Q-PP-04'));
  await expect(column(page)).toBeVisible();
  await column(page).screenshot({ path: `${dir}/column-1440-dark.png` });
  await page.emulateMedia({ colorScheme: 'light' });
  // "Save all n now" (design fix round 1, CAPTURE): two saves pressed while the server is unreachable, as
  // e2e/stage-workspace.spec.ts makes them, then the stage page at 1280 and 375.
  await page.route('**/decisions', (r) => r.abort('failed'));
  for (const [q, reason] of [['Q-PP-06', 'First'], ['Q-PP-07', 'Second']] as const) {
    await openQuestion(page, 'assessor', q, baseURL!, projectId);
    await fillValid(page, { reason });
    await page.getByRole('button', { name: 'Save decision' }).click();
    await expect(page.locator('[data-region="answer-form"] .save-status').getByRole('alert')).toContainText('Not saved');
  }
  await page.unroute('**/decisions');
  for (const [width, height] of [[1280, 800], [375, 812]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(stagePath(projectId, 'pre-processing'));
    await expect(page.getByRole('button', { name: STAGE_LIST_COPY.saveAll(2) })).toBeVisible();
    await page.getByRole('button', { name: STAGE_LIST_COPY.saveAll(2) }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}/stage-${width}-save-all.png` });
  }
});
