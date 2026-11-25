import { expect, test, type Page } from '@playwright/test';
import { failOnDialog } from './helpers/dialogs';
import { fillValid, openQuestion, saveViaApi, waitForQuestionPage } from './helpers/session';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { REASON_OPTIONAL, WITHDRAW_COPY } from '../lib/decision/copy';
import { FIELD_COPY } from '../lib/ui/field/copy';
import { QUESTION_COPY } from '../lib/question/copy';
import { UI_COPY } from '../lib/ui/copy';

/**
 * A conflict never leaves a saved claim on the page that the conflict contradicts. While the conflict view is shown, the card's
 * "Saved as version N" lines are not drawn beside "Not saved. A newer version was saved while you worked."; when a save returns a
 * conflict, the page's server data is refreshed, so once the view closes (a refused "Save my version", or "Edit my version") the
 * card describes the newer version: its saved lines, its history count, and the finding and withdrawal controls act on it. The
 * person's chosen answer and typed reason stay in the form through that refresh.
 */
const Q = 'Q-PP-01';
const MINE = 'Mine';
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "Saved as version N", the words of the corner (DECISION_FORM_COPY.card.savedAs) and of the phone's saved block (UI_COPY.saved.title). */
const savedAs = (n: number): RegExp => new RegExp(`${esc(UI_COPY.saved.title(n))}\\b`);
const visible = (page: Page, text: string | RegExp) => page.getByText(text, typeof text === 'string' ? { exact: true } : undefined).filter({ visible: true });
const reasonBox = (page: Page) => page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${REASON_OPTIONAL}`, { exact: true });
const API_500 = { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The server could not save this.', code: 'internal_error' }) };

test.beforeEach(async ({ page }) => { failOnDialog(page); });

/**
 * A conflict over an answer the person (the admin seat, who may raise findings and withdraw any version) saved as version 1: the
 * owner saves version 2 while the page is open at version 1, and the person's Save of their own answer is refused. Returns the
 * project and version 2's id.
 */
async function conflictOverSaved(page: Page, baseURL: string): Promise<{ projectId: string; v2: string }> {
  const projectId = await openQuestion(page, 'admin', Q, baseURL);
  expect((await saveViaApi(baseURL, 'admin', projectId, Q, { reason: 'Version 1' })).status).toBe(201);
  await page.reload(); await waitForQuestionPage(page);
  // Before the conflict the page says version 1 is saved (the claims the conflict must not leave on screen).
  await expect(visible(page, savedAs(1)).first()).toBeVisible();
  await expect(visible(page, UI_COPY.saved.onPlatform).first()).toBeVisible();
  await fillValid(page, { reason: MINE });
  const other = await saveViaApi(baseURL, 'owner', projectId, Q, { baseVersionNumber: 1, reason: 'Owner saved first' });
  expect(other.status).toBe(201);
  await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
  await expect(page.getByRole('heading', { name: DECISION_FORM_COPY.conflict.heading })).toBeFocused({ timeout: 15_000 });
  return { projectId, v2: (other.body as unknown as { id: string }).id };
}

/** The card describes version 2: no "Saved as version 1", history counts two, the raise link names version 2. */
async function cardDescribesVersion2(page: Page, v2: string): Promise<void> {
  await expect(visible(page, savedAs(1))).toHaveCount(0);
  await expect(visible(page, QUESTION_COPY.reading.history(2)).first()).toBeVisible({ timeout: 15_000 });
  await expect(visible(page, QUESTION_COPY.reading.history(1))).toHaveCount(0);
  await expect(page.getByRole('link', { name: QUESTION_COPY.findingLink.raise })).toHaveAttribute('href', new RegExp(`[?&]versionId=${v2}(&|#|$)`));
}

/** The person's own answer is still in the form: the chosen answer and the typed reason. */
async function answerKept(page: Page): Promise<void> {
  await expect(page.getByRole('radio', { name: 'Done', exact: true })).toBeChecked();
  await expect(reasonBox(page)).toHaveValue(MINE);
}

/** The withdrawal the More menu sends names version 2 as its base: it acts on the current version. Its request is not let through. */
async function withdrawActsOnVersion2(page: Page): Promise<void> {
  let base: unknown = null;
  await page.route('**/withdrawal', async (route) => {
    base = (route.request().postDataJSON() as { baseVersionNumber: unknown }).baseVersionNumber;
    await route.fulfill(API_500);
  });
  await page.locator('details.more-menu > summary').click();
  await page.getByRole('button', { name: WITHDRAW_COPY.trigger }).click();
  await page.getByLabel(`${WITHDRAW_COPY.codeLabel} ${FIELD_COPY.required}`).selectOption({ index: 1 });
  await page.getByLabel(`${WITHDRAW_COPY.reasonLabel} ${FIELD_COPY.required}`).fill('Entered on the wrong question.');
  await page.getByRole('button', { name: WITHDRAW_COPY.action }).click();
  await expect.poll(() => base).toBe(2);
}

for (const width of [1280, 375]) {
  test(`at ${width} px: while the conflict view shows, no saved claim sits beside "Not saved", and the card counts version 2`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    await conflictOverSaved(page, baseURL!);
    await expect(visible(page, savedAs(1))).toHaveCount(0);
    await expect(visible(page, savedAs(2))).toHaveCount(0);
    await expect(visible(page, UI_COPY.saved.onPlatform)).toHaveCount(0);
    await expect(page.locator('[data-region="conflict"]').getByRole('heading', { name: DECISION_FORM_COPY.conflict.saved(2), exact: true })).toBeVisible();
    // The foot left visible beside the view describes the current version (the page's data was refreshed on the conflict).
    await expect(visible(page, QUESTION_COPY.reading.history(2)).first()).toBeVisible({ timeout: 15_000 });
  });

  test(`at ${width} px: a refused "Save my version" leaves the card describing version 2, and the answer kept`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    const { v2 } = await conflictOverSaved(page, baseURL!);
    await expect(visible(page, QUESTION_COPY.reading.history(2)).first()).toBeVisible({ timeout: 15_000 });
    await page.route('**/decisions', (r) => (r.request().method() === 'POST' ? r.fulfill(API_500) : r.continue()));
    await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.saveMine }).click();
    await expect(page.getByRole('button', { name: DECISION_FORM_COPY.retry })).toBeVisible({ timeout: 15_000 });
    await page.unroute('**/decisions');
    await cardDescribesVersion2(page, v2);
    await answerKept(page);
    await withdrawActsOnVersion2(page);
  });

  test(`at ${width} px: "Edit my version" leaves the card describing version 2, and the answer kept`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    const { v2 } = await conflictOverSaved(page, baseURL!);
    await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.editMine }).click();
    await cardDescribesVersion2(page, v2);
    await answerKept(page);
    await withdrawActsOnVersion2(page);
  });
}

test('a conflict on a first answer: the corner\'s "No decision yet." is not drawn beside "Saved version (1)"', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const projectId = await openQuestion(page, 'admin', Q, baseURL!);
  await expect(visible(page, QUESTION_COPY.current.none)).toHaveCount(1);
  await fillValid(page, { reason: MINE });
  expect((await saveViaApi(baseURL!, 'owner', projectId, Q, { reason: 'Owner saved first' })).status).toBe(201);
  await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
  await expect(page.getByRole('heading', { name: DECISION_FORM_COPY.conflict.heading })).toBeFocused({ timeout: 15_000 });
  await expect(visible(page, QUESTION_COPY.current.none)).toHaveCount(0);
});

test('a draft restored over a newer version meets another conflict: the refresh keeps the restored answer', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const projectId = await openQuestion(page, 'admin', Q, baseURL!);
  expect((await saveViaApi(baseURL!, 'admin', projectId, Q, { reason: 'Version 1' })).status).toBe(201);
  await page.reload(); await waitForQuestionPage(page);
  await fillValid(page, { reason: MINE });
  // The owner saves version 2; the person reopens the page: the draft on version 1 is restored and the conflict view shows at once.
  expect((await saveViaApi(baseURL!, 'owner', projectId, Q, { baseVersionNumber: 1, reason: 'Owner, version 2' })).status).toBe(201);
  await page.reload(); await waitForQuestionPage(page);
  await expect(page.locator('[data-region="conflict"]').getByRole('heading', { name: DECISION_FORM_COPY.conflict.saved(2), exact: true })).toBeVisible();
  // Before "Save my version" lands, the owner saves version 3: the save is refused as a conflict again, and the page refreshes.
  const v3 = await saveViaApi(baseURL!, 'owner', projectId, Q, { baseVersionNumber: 2, reason: 'Owner, version 3' });
  expect(v3.status).toBe(201);
  await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.saveMine }).click();
  await expect(page.locator('[data-region="conflict"]').getByRole('heading', { name: DECISION_FORM_COPY.conflict.saved(3), exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(visible(page, QUESTION_COPY.reading.history(3)).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.editMine }).click();
  await expect(visible(page, savedAs(1))).toHaveCount(0);
  await expect(visible(page, savedAs(2))).toHaveCount(0);
  await answerKept(page);
});

test('an untouched answer meets a conflict and "Edit my version" is pressed before the refresh lands: the person\'s version stays', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // The person saves version 1 through the form, so it is theirs, decided by them; Save moves on, and they come back to it.
  const projectId = await openQuestion(page, 'admin', Q, baseURL!);
  await fillValid(page, { reason: MINE });
  await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
  await expect(page).toHaveURL(/\?saved=/, { timeout: 30_000 });
  await page.getByRole('link', { name: /^Back to question/ }).click();
  await waitForQuestionPage(page);
  await expect(reasonBox(page)).toHaveValue(MINE);
  expect((await saveViaApi(baseURL!, 'owner', projectId, Q, { baseVersionNumber: 1, reason: 'Owner saved first' })).status).toBe(201);
  // The page's refresh (a request for the route's server data) is held until "Edit my version" has been pressed.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let refreshes = 0;
  await page.route('**/*', async (route) => {
    if (route.request().headers().rsc === '1') { refreshes += 1; await held; }
    await route.continue().catch(() => {});
  });
  // Nothing typed: Save sends the answer as it opened, and the reply is a conflict.
  await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
  await expect(page.getByRole('heading', { name: DECISION_FORM_COPY.conflict.heading })).toBeFocused({ timeout: 15_000 });
  await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.editMine }).click();
  await expect.poll(() => refreshes).toBeGreaterThan(0);
  release();
  await expect(visible(page, QUESTION_COPY.reading.history(2)).first()).toBeVisible({ timeout: 15_000 });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await answerKept(page);
});
