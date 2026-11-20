import { expect, test, type Page } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { failOnDialog } from './helpers/dialogs';
import { actAsSeat, fillValid, fixtureOrgSlug, newProject, openQuestion, openQuestionIn, questionPath, saveAlert, saveStatus, stagePath, waitForQuestionPage } from './helpers/session';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { DECISION_OUTCOME_COPY } from '../lib/decision/outcome/copy';
import { FIELD_COPY } from '../lib/ui/field/copy';
import { STAGE_END_COPY } from '../lib/question/end/copy';
import { REVIEW_COPY } from '../lib/review/copy';
import { ERRORS_COPY } from '../lib/errors/copy';
import { NOT_FOUND_COPY } from '../lib/errors/not-found/copy';

/**
 * Design G3 (path to outputs, Task 14): the end of a stage leads with where the project stands. Saving the last question of a
 * stage lands on that stage's end screen; the screen offers the working report first, the next stage second, and the seal step
 * for the viewer's role. G7 is dormant on the fixture content, so every next stage is offered. Q-PP-23 is the last question of
 * Pre-processing in the fixture bundle.
 */
const E = STAGE_END_COPY;
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

/**
 * Ruling on Task 14's review (risk b): the push to the end screen happens only on a clean "Saved". A message the person must see
 * keeps them on the last question, with the end screen one link away: "Saved without <file>... save again", text typed while the
 * save was out (CR-1, UX-25: the kept copy must be shown), and "already saved" (M-04). Q-PP-23 is the last question of Pre-processing.
 */
const endLink = (page: Page) => page.locator('[data-region="answer-form"]').getByRole('link', { name: E.link });
const reasonField = (page: Page) => page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`);

/**
 * The person is still on the question: a push after the save is a navigation that starts within moments of the "Saved" line, so
 * the check waits for one (it must not arrive), then asserts the question's address, the end screen's link and no end heading.
 */
async function stayedOnQuestion(page: Page, projectId: string): Promise<void> {
  await expect(page.waitForURL(/\/end$/u, { timeout: 4_000 }), 'a save with a message to read must not navigate to the end screen').rejects.toThrow();
  await expect(page).toHaveURL(new RegExp(`${questionPath(projectId, LAST)}$`));
  await expect(endLink(page)).toHaveAttribute('href', endPath(projectId, 'pre-processing'));
  await expect(page.getByRole('heading', { level: 1, name: E.heading })).toHaveCount(0);
}

test('G3 risk b, CR-1 7.4.1: text typed while the last question\'s save is out keeps the person on the question, the field, the unsaved line and a link to the end screen', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', LAST, baseURL!);
  await fillValid(page, { reason: 'Sent reason' });
  let release!: () => void;
  const held = new Promise<void>((res) => (release = res));
  await page.route('**/decisions', async (r) => { await held; await r.continue(); });
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveStatus(page)).toHaveText('Saving...');
  await reasonField(page).fill('Typed while it was saving');
  release();
  await expect(saveStatus(page)).toHaveText(/^Saved at .+ as version 1\./);
  await expect(reasonField(page)).toHaveValue('Typed while it was saving');
  await expect(page.locator('[data-region="answer-form"] .save-status')).toContainText(DECISION_FORM_COPY.unsaved);
  await stayedOnQuestion(page, projectId);
});

test('G3 risk b, M-04: "already saved" on the last question keeps the person on the question with a link to the end screen', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', LAST, baseURL!);
  await fillValid(page);
  await page.route('**/decisions', async (r) => { await r.fetch(); await r.abort('failed'); }, { times: 1 });   // the server commits, the page sees a failure
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveAlert(page)).toContainText(DECISION_OUTCOME_COPY.save.connection);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(saveStatus(page)).toHaveText(/^This was already saved at \d{2}:\d{2} \S+ \(version 1\)\.$/);
  await stayedOnQuestion(page, projectId);
});

test('G3 risk b, "Saved without <file>": the last question keeps the person on the question, with the line that says to save again and a link to the end screen', async ({ page }) => {
  await actAsSeat(page, 'admin');
  const projectId = await openQuestionIn(page, LAST);
  await fillValid(page);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/evidence', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    await held;
    try { await route.abort('failed'); } catch { /* cancelled by the page */ }
  });
  const name = 'left-out-last.pdf';
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n${name}\n`) });
  await expect(page.locator('[data-upload-progress] > progress')).toHaveAttribute('aria-label', `Uploading ${name}`);
  const sent = page.waitForRequest((r) => r.method() === 'POST' && /\/decisions$/.test(new URL(r.url()).pathname));
  await page.getByRole('button', { name: DECISION_FORM_COPY.saveWithout(1) }).click();
  await sent;
  await expect(saveStatus(page)).toHaveText(/^Saved at .+ as version 1\./, { timeout: 20_000 });
  await expect(page.getByText(`${DECISION_FORM_COPY.savedWithout.before}${name}${DECISION_FORM_COPY.savedWithout.after}`)).toBeVisible();
  await stayedOnQuestion(page, projectId);
  release();
});
