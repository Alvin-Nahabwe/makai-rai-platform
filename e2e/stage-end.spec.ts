import { expect, test, type Page } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { failOnDialog } from './helpers/dialogs';
import { actAsSeat, fillValid, fixtureOrgSlug, newProject, openQuestion, questionPath, stagePath, waitForQuestionPage } from './helpers/session';
import { QUESTION_COPY } from '../lib/question/copy';
import { REVIEW_COPY } from '../lib/review/copy';
import { ERRORS_COPY } from '../lib/errors/copy';
import { NOT_FOUND_COPY } from '../lib/errors/not-found/copy';

/**
 * Design G3 (path to outputs, Task 14): the end of a stage leads with where the project stands. Saving the last question of a
 * stage lands on that stage's end screen; the screen offers the working report first, the next stage second, and the seal step
 * for the viewer's role. G7 is dormant on the fixture content, so every next stage is offered. Q-PP-23 is the last question of
 * Pre-processing in the fixture bundle.
 */
const E = QUESTION_COPY.end;
const LAST = 'Q-PP-23';
const endPath = (projectId: string, stage: string): string => `${stagePath(projectId, stage)}/end`;

test.beforeEach(async ({ page }) => { failOnDialog(page); });

test('G3: saving the last question of Pre-processing lands on Here is where your project stands with Open the working report as the primary action', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', LAST, baseURL!);
  await fillValid(page);
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(page).toHaveURL(new RegExp(`${endPath(projectId, 'pre-processing')}$`));
  await expect(page.getByRole('heading', { level: 1, name: E.heading })).toBeVisible();
  const primary = page.locator('main .ui-button--primary');
  await expect(primary).toHaveCount(1);
  await expect(primary).toHaveText(E.openReport);
  await expect(primary).toHaveAttribute('href', `/orgs/${fixtureOrgSlug()}/projects/${projectId}/report`);
  // The save is in the answers the screen reads: one question is decided.
  await expect(page.locator('main')).toContainText('1\u00A0done');
});

test('G3, G7 dormant: on fixture content every next stage is offered: Start In-processing after Pre-processing', async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  await actAsSeat(page, 'assessor');
  await page.goto(endPath(projectId, 'pre-processing'));
  await expect(page.getByRole('link', { name: E.start('In-processing') })).toHaveAttribute('href', stagePath(projectId, 'in-processing'));
  await page.goto(endPath(projectId, 'in-processing'));
  await expect(page.getByRole('link', { name: E.start('Post-processing') })).toBeVisible();
  // Post-processing is the last stage: nothing follows it.
  await page.goto(endPath(projectId, 'post-processing'));
  await expect(page.getByRole('heading', { level: 1, name: E.heading })).toBeVisible();
  await expect(page.getByRole('link', { name: /^(Start|View) /u })).toHaveCount(0);
});

test('G3: the screen opens again from the stage page and from the last question', async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  const end = new RegExp(`${endPath(projectId, 'pre-processing')}$`);
  await actAsSeat(page, 'assessor');
  await page.goto(stagePath(projectId, 'pre-processing'));
  await page.getByRole('link', { name: E.link }).click();
  await expect(page).toHaveURL(end);
  await page.goto(questionPath(projectId, LAST));
  await waitForQuestionPage(page);
  await page.locator('[data-region="answer-form"]').getByRole('link', { name: E.link }).click();
  await expect(page).toHaveURL(end);
  // A reader has no form: the reading view's last question links there too.
  await actAsSeat(page, 'viewer');
  await page.goto(questionPath(projectId, LAST));
  await page.locator('main').getByRole('link', { name: E.link }).first().click();
  await expect(page).toHaveURL(end);
});

/** The checks of anti-goal 4 for one role: every visible link in main lands on a real page and every visible button's request answers 2xx. */
async function checkEveryControl(page: Page, projectId: string, label: string): Promise<string[]> {
  const main = page.locator('main');
  const checked: string[] = [];
  const hrefs = await main.locator('a[href]:visible').evaluateAll((as) => as.map((a) => ({ href: a.getAttribute('href') ?? '', name: (a.textContent ?? '').trim() })));
  for (const { href, name } of hrefs) {
    if (!href.startsWith('/')) continue;
    const response = await page.goto(href);
    expect(response?.status(), `${label}: ${href}`).toBeLessThan(400);
    await expect(page.getByRole('heading', { name: NOT_FOUND_COPY.heading }), `${label}: ${href} is the not-found page`).toHaveCount(0);
    await expect(page.getByRole('heading', { name: ERRORS_COPY.error.heading }), `${label}: ${href} is the error page`).toHaveCount(0);
    checked.push(name);
  }
  await page.goto(endPath(projectId, 'pre-processing'));
  const buttons = main.locator('button:visible:not(.ui-term-tip__button)');
  for (let i = 0; i < await buttons.count(); i += 1) {
    const sent: number[] = [];
    const record = (r: import('@playwright/test').Response) => { if (r.request().method() !== 'GET') sent.push(r.status()); };
    page.on('response', record);
    const name = ((await buttons.nth(i).textContent()) ?? '').trim();
    await buttons.nth(i).click();
    await expect.poll(() => sent.length, { message: `${label}: ${name} sent no request` }).toBeGreaterThan(0);
    page.off('response', record);
    expect(sent.every((s) => s >= 200 && s < 300), `${label}: ${name} answered ${sent.join(',')}`).toBe(true);
    checked.push(name);
  }
  return checked;
}

test('anti-goal 4: on the end screen, for an Assessor, a Reviewer and a Viewer, every visible link lands on a page that is neither the not-found page nor a refusal, and every visible button\'s request answers 2xx', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const projectId = await newProject(baseURL!);
  const roles: OrgRole[] = ['assessor', 'reviewer', 'viewer'];
  for (const role of roles) {
    await actAsSeat(page, role);
    await page.goto(endPath(projectId, 'pre-processing'));
    await expect(page.getByRole('heading', { level: 1, name: E.heading })).toBeVisible();
    const checked = await checkEveryControl(page, projectId, role);
    // Never an empty set: each role has at least one control, and a Viewer at least the report.
    expect(checked.length, role).toBeGreaterThan(0);
    if (role === 'assessor') expect(checked, role).toContain(REVIEW_COPY.sealStep.ask);
    if (role === 'reviewer') expect(checked, role).toContain(REVIEW_COPY.sealStep.seal);
    if (role === 'viewer') expect(checked, role).toContain(E.openReport);
    // Roles that cannot record are offered the next stage to read, never to start (a control they cannot use).
    const next = page.getByRole('link', { name: role === 'assessor' ? E.start('In-processing') : E.view('In-processing') });
    await page.goto(endPath(projectId, 'pre-processing'));
    await expect(next).toBeVisible();
    await expect(page.getByRole('link', { name: role === 'assessor' ? E.view('In-processing') : E.start('In-processing') })).toHaveCount(0);
  }
});
