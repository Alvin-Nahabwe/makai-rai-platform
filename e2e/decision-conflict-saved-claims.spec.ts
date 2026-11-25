import { expect, test, type Page } from '@playwright/test';
import { failOnDialog } from './helpers/dialogs';
import { fillValid, openQuestion, questionPath, saveViaApi, waitForQuestionPage } from './helpers/session';
import { escapeRe } from '../__tests__/helpers/escapeRe';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { REASON_OPTIONAL, WITHDRAW_COPY } from '../lib/decision/copy';
import { FIELD_COPY } from '../lib/ui/field/copy';
import { QUESTION_COPY } from '../lib/question/copy';
import { UI_COPY } from '../lib/ui/copy';

/**
 * A conflict never leaves the card saying something about a version the form knows is no longer the current one. From the moment
 * a save meets a newer version, everything the card says about the older one (its saved lines, who entered it, the history count,
 * the seal markers, the finding link and the More menu's withdrawal) is not drawn, whether or not the page's reload has started,
 * landed or failed. The reload runs only when this browser holds a copy of the person's draft; when it lands, the card describes the
 * newer version, with its saved lines still hidden while the conflict view is open. Data that arrives late never puts an older
 * version back. The person's chosen answer and typed reason stay in the form throughout, and the "The form shows the current
 * decision" note is not shown while the form holds their own version.
 */
const Q = 'Q-PP-01';
const MINE = 'Mine';
/** "Saved as version N", the words of the corner (DECISION_FORM_COPY.card.savedAs) and of the phone's saved block (UI_COPY.saved.title). */
const savedAs = (n: number): RegExp => new RegExp(`${escapeRe(UI_COPY.saved.title(n))}\\b`);
const visible = (page: Page, text: string | RegExp) => page.getByText(text, typeof text === 'string' ? { exact: true } : undefined).filter({ visible: true });
const reasonBox = (page: Page) => page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${REASON_OPTIONAL}`, { exact: true });
const conflictHeading = (page: Page) => page.getByRole('heading', { name: DECISION_FORM_COPY.conflict.heading });
const API_500 = { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The server could not save this.', code: 'internal_error' }) };
const isSavePost = (method: string, url: string) => method === 'POST' && /\/decisions$/.test(new URL(url).pathname);

test.beforeEach(async ({ page }) => { failOnDialog(page); });

/**
 * The page's own refresh of its server data (a router.refresh), told apart from link prefetches: an RSC request for this question's
 * address that is not a prefetch. `mode` 'hold' keeps every such request until `release()`; 'fail' answers the first with a 500.
 */
async function routeRefresh(page: Page, path: string, mode: 'hold' | 'fail') {
  const seen: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/*', async (route) => {
    const req = route.request();
    const h = req.headers();
    const refresh = req.method() === 'GET' && h.rsc === '1' && h['next-router-prefetch'] === undefined && new URL(req.url()).pathname === path;
    if (!refresh) { await route.fallback(); return; }
    seen.push(req.url());
    if (mode === 'fail' && seen.length === 1) { await route.fulfill({ status: 500, body: 'refresh refused' }); return; }
    if (mode === 'hold') await held;
    await route.fallback();
  });
  return { count: () => seen.length, release: () => release() };
}

/**
 * A conflict over an answer the person (the admin seat, who may raise findings and withdraw any version) saved as version 1: the
 * owner saves version 2 while the page is open at version 1, and the person's Save of their own answer is refused. `beforeSave`
 * runs after the owner's save and before the person's (to route the refresh). Returns the project, version 2's id and the name the
 * conflict view gives the person who saved it.
 */
async function conflictOverSaved(page: Page, baseURL: string, beforeSave?: (projectId: string) => Promise<void>): Promise<{ projectId: string; v2: string; savedBy: string }> {
  const projectId = await openQuestion(page, 'admin', Q, baseURL);
  expect((await saveViaApi(baseURL, 'admin', projectId, Q, { reason: 'Version 1' })).status).toBe(201);
  await page.reload(); await waitForQuestionPage(page);
  // Before the conflict the page says version 1 is saved (the claims the conflict must not leave on screen).
  await expect(visible(page, savedAs(1)).first()).toBeVisible();
  await expect(visible(page, UI_COPY.saved.onPlatform).first()).toBeVisible();
  await fillValid(page, { reason: MINE });
  const other = await saveViaApi(baseURL, 'owner', projectId, Q, { baseVersionNumber: 1, reason: 'Owner saved first' });
  expect(other.status).toBe(201);
  if (beforeSave !== undefined) await beforeSave(projectId);
  await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
  await expect(conflictHeading(page)).toBeFocused({ timeout: 15_000 });
  const line = await page.locator('[data-region="conflict"]').getByText(/ saved a newer version at /).first().innerText();
  return { projectId, v2: (other.body as unknown as { id: string }).id, savedBy: line.split(' saved a newer version at ')[0] };
}

/** The card's server data is still version 1's: its (hidden) corner still names version 1. */
async function cardDataStillVersion1(page: Page): Promise<void> {
  await expect(page.locator('.decision-card__corner')).toContainText(UI_COPY.saved.title(1));
}

/** Nothing the card says about version 1 is on screen or reachable: no saved claim, history count, entry record, finding link or More menu. */
async function nothingAboutVersion1(page: Page): Promise<void> {
  await expect(visible(page, savedAs(1))).toHaveCount(0);
  await expect(visible(page, UI_COPY.saved.onPlatform)).toHaveCount(0);
  await expect(visible(page, QUESTION_COPY.reading.history(1))).toHaveCount(0);
  await expect(visible(page, new RegExp(escapeRe(DECISION_FORM_COPY.card.enteredBy(''))))).toHaveCount(0);
  await expect(page.getByRole('link', { name: QUESTION_COPY.findingLink.raise }).filter({ visible: true })).toHaveCount(0);
  await expect(page.locator('details.more-menu > summary').filter({ visible: true })).toHaveCount(0);
}

/** The card describes version 2: no "Saved as version 1", history counts two, who entered it, the raise link names version 2. */
async function cardDescribesVersion2(page: Page, v2: string, savedBy: string): Promise<void> {
  await expect(visible(page, savedAs(1))).toHaveCount(0);
  await expect(visible(page, QUESTION_COPY.reading.history(2)).first()).toBeVisible({ timeout: 15_000 });
  await expect(visible(page, QUESTION_COPY.reading.history(1))).toHaveCount(0);
  await expect(visible(page, new RegExp(`${escapeRe(DECISION_FORM_COPY.card.enteredBy(savedBy))}`)).first()).toBeVisible();
  await expect(page.getByRole('link', { name: QUESTION_COPY.findingLink.raise })).toHaveAttribute('href', new RegExp(`[?&]versionId=${v2}(&|#|$)`));
}

/** The person's own answer is still in the form: the chosen answer and the typed reason. */
async function answerKept(page: Page, reason = MINE): Promise<void> {
  await expect(page.getByRole('radio', { name: 'Done', exact: true })).toBeChecked();
  await expect(reasonBox(page)).toHaveValue(reason);
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
  test(`at ${width} px: while the conflict view shows, no saved claim sits beside "Not saved", before and after the reload lands`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    await conflictOverSaved(page, baseURL!);
    await expect(page.locator('[data-region="conflict"]').getByRole('heading', { name: DECISION_FORM_COPY.conflict.saved(2), exact: true })).toBeVisible();
    // The foot left visible beside the view describes the current version once the page's data has been refreshed.
    await expect(visible(page, QUESTION_COPY.reading.history(2)).first()).toBeVisible({ timeout: 15_000 });
    // And after it, the saved lines stay hidden while the view is open.
    await expect(visible(page, savedAs(1))).toHaveCount(0);
    await expect(visible(page, savedAs(2))).toHaveCount(0);
    await expect(visible(page, UI_COPY.saved.onPlatform)).toHaveCount(0);
  });

  test(`at ${width} px: with the reload held, nothing about version 1 shows while the view is open, while "Save my version" is out, or after it is refused; then the card names version 2`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    let refresh!: Awaited<ReturnType<typeof routeRefresh>>;
    const { v2, savedBy } = await conflictOverSaved(page, baseURL!, async (projectId) => { refresh = await routeRefresh(page, questionPath(projectId, Q), 'hold'); });
    await expect.poll(() => refresh.count()).toBeGreaterThan(0);
    await cardDataStillVersion1(page);
    await nothingAboutVersion1(page);
    // "Save my version", held in flight.
    let releaseSave!: () => void;
    const saveHeld = new Promise<void>((r) => { releaseSave = r; });
    await page.route('**/decisions', async (route) => {
      if (!isSavePost(route.request().method(), route.request().url())) { await route.fallback(); return; }
      await saveHeld;
      await route.fulfill(API_500);
    });
    await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.saveMine }).click();
    await expect(page.locator('[data-region="answer-form"] .save-status').getByRole('status')).not.toBeEmpty();
    await cardDataStillVersion1(page);
    await nothingAboutVersion1(page);
    // Refused (500).
    releaseSave();
    await expect(page.getByRole('button', { name: DECISION_FORM_COPY.retry })).toBeVisible({ timeout: 15_000 });
    await cardDataStillVersion1(page);
    await nothingAboutVersion1(page);
    await answerKept(page);
    // The reload lands: the card names version 2.
    await page.unroute('**/decisions');
    refresh.release();
    await cardDescribesVersion2(page, v2, savedBy);
    await answerKept(page);
  });

  test(`at ${width} px: with the reload held, nothing about version 1 shows after "Edit my version"; then the card names version 2 and acts on it`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    let refresh!: Awaited<ReturnType<typeof routeRefresh>>;
    const { v2, savedBy } = await conflictOverSaved(page, baseURL!, async (projectId) => { refresh = await routeRefresh(page, questionPath(projectId, Q), 'hold'); });
    await expect.poll(() => refresh.count()).toBeGreaterThan(0);
    await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.editMine }).click();
    await cardDataStillVersion1(page);
    await nothingAboutVersion1(page);
    await answerKept(page);
    refresh.release();
    await cardDescribesVersion2(page, v2, savedBy);
    await answerKept(page);
    await withdrawActsOnVersion2(page);
  });

  test(`at ${width} px: a refused "Save my version" after the reload leaves the card describing version 2, and the answer kept`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    const { v2, savedBy } = await conflictOverSaved(page, baseURL!);
    await expect(visible(page, QUESTION_COPY.reading.history(2)).first()).toBeVisible({ timeout: 15_000 });
    await page.route('**/decisions', (r) => (isSavePost(r.request().method(), r.request().url()) ? r.fulfill(API_500) : r.fallback()));
    await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.saveMine }).click();
    await expect(page.getByRole('button', { name: DECISION_FORM_COPY.retry })).toBeVisible({ timeout: 15_000 });
    await page.unroute('**/decisions');
    await cardDescribesVersion2(page, v2, savedBy);
    await answerKept(page);
    await withdrawActsOnVersion2(page);
  });
}

test('a reload that fails after the conflict, with a draft kept in this browser: the answer and reason are on screen again, and nothing claims version 1', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let refresh!: Awaited<ReturnType<typeof routeRefresh>>;
  await conflictOverSaved(page, baseURL!, async (projectId) => { refresh = await routeRefresh(page, questionPath(projectId, Q), 'fail'); });
  await expect.poll(() => refresh.count()).toBeGreaterThan(0);
  // A refused refresh falls back to loading the page; the draft kept in this browser brings the conflict back with the answer.
  await expect(conflictHeading(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-region="conflict"]').getByText(MINE, { exact: true })).toBeVisible();
  // The loaded page's card is drawn from version 2, the current one: nothing on it names version 1.
  await expect(visible(page, QUESTION_COPY.reading.history(2)).first()).toBeVisible();
  await expect(visible(page, savedAs(1))).toHaveCount(0);
  await expect(visible(page, QUESTION_COPY.reading.history(1))).toHaveCount(0);
  await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.editMine }).click();
  await answerKept(page);
  await expect(visible(page, savedAs(1))).toHaveCount(0);
  await expect(visible(page, QUESTION_COPY.reading.history(1))).toHaveCount(0);
});

test.describe('a browser that cannot keep drafts', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage is blocked.', 'SecurityError'); } });
    });
  });

  test('no reload runs after the conflict; the answer stays, version 1 stays hidden, and a successful save shows the newer version', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    let refresh!: Awaited<ReturnType<typeof routeRefresh>>;
    const { projectId } = await conflictOverSaved(page, baseURL!, async (id) => { refresh = await routeRefresh(page, questionPath(id, Q), 'hold'); });
    await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.editMine }).click();
    await answerKept(page);
    await nothingAboutVersion1(page);
    // An absence needs a window: a refresh, if one were sent, leaves within a few hundred milliseconds of the conflict.
    await page.waitForTimeout(2_000);
    expect(refresh.count(), 'no reload is requested when the browser holds no copy of the draft').toBe(0);
    await nothingAboutVersion1(page);
    // Save succeeds as version 3 and moves on; back on the question, the card names version 3.
    await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
    await expect(page).toHaveURL(/\?saved=/, { timeout: 30_000 });
    await page.goto(questionPath(projectId, Q)); await waitForQuestionPage(page);
    await expect(visible(page, savedAs(3)).first()).toBeVisible();
  });

  test('after the conflict, "Discard my version" shows the newer version', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    let refresh!: Awaited<ReturnType<typeof routeRefresh>>;
    await conflictOverSaved(page, baseURL!, async (id) => { refresh = await routeRefresh(page, questionPath(id, Q), 'hold'); });
    await nothingAboutVersion1(page);
    expect(refresh.count()).toBe(0);
    // "Discard my version" reloads the page's data (the person gives up their answer, so nothing is lost by it). Until that reload
    // lands, the card still says nothing about version 1.
    await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.discardMine }).click();
    await expect.poll(() => refresh.count()).toBeGreaterThan(0);
    await cardDataStillVersion1(page);
    await nothingAboutVersion1(page);
    refresh.release();
    await expect(visible(page, QUESTION_COPY.reading.history(2)).first()).toBeVisible({ timeout: 15_000 });
    await expect(reasonBox(page)).toHaveValue('Owner saved first');
  });
});

test('"Save my version" succeeds while the reload is still held: the late reload does not move the form back, and the card never claims an older version than the status line', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let refresh!: Awaited<ReturnType<typeof routeRefresh>>;
  await conflictOverSaved(page, baseURL!, async (projectId) => { refresh = await routeRefresh(page, questionPath(projectId, Q), 'hold'); });
  await expect.poll(() => refresh.count()).toBeGreaterThan(0);
  // The save is held so that the person types while it is out: the reply then keeps them on the question (CR-1).
  let releaseSave!: () => void;
  const saveHeld = new Promise<void>((r) => { releaseSave = r; });
  await page.route('**/decisions', async (route) => {
    if (!isSavePost(route.request().method(), route.request().url())) { await route.fallback(); return; }
    await saveHeld;
    await route.fallback();
  });
  await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.saveMine }).click();
  await reasonBox(page).fill(`${MINE}, more`);
  releaseSave();
  const status = page.locator('[data-region="answer-form"] .save-status').getByRole('status');
  await expect(status).toContainText(/version 3/, { timeout: 15_000 });
  await expect(visible(page, savedAs(1))).toHaveCount(0);
  await expect(visible(page, savedAs(2))).toHaveCount(0);
  // Both refreshes are let go (the conflict's, which carries version 2, then the save's): version 2 never takes the form or the card.
  refresh.release();
  await expect(visible(page, QUESTION_COPY.reading.history(3)).first()).toBeVisible({ timeout: 15_000 });
  await expect(visible(page, savedAs(2))).toHaveCount(0);
  await expect(visible(page, QUESTION_COPY.reading.history(2))).toHaveCount(0);
  await answerKept(page, `${MINE}, more`);
});

test('the note "The form shows the current decision" is hidden after "Edit my version", and stays hidden after a refused save', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const note = (p: Page) => visible(p, DECISION_FORM_COPY.startingNote);
  await conflictOverSaved(page, baseURL!);
  await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.editMine }).click();
  await answerKept(page);
  await expect(note(page)).toHaveCount(0);
  // A refused save of the person's version (the server answers 500) keeps it hidden.
  await page.route('**/decisions', (r) => (isSavePost(r.request().method(), r.request().url()) ? r.fulfill(API_500) : r.fallback()));
  await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
  await expect(page.getByRole('button', { name: DECISION_FORM_COPY.retry })).toBeVisible({ timeout: 15_000 });
  await expect(note(page)).toHaveCount(0);
  await page.unroute('**/decisions');
});

test('the note is hidden after a refused "Save my version"', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const note = (p: Page) => visible(p, DECISION_FORM_COPY.startingNote);
  await conflictOverSaved(page, baseURL!);
  await page.route('**/decisions', (r) => (isSavePost(r.request().method(), r.request().url()) ? r.fulfill(API_500) : r.fallback()));
  await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.saveMine }).click();
  await expect(page.getByRole('button', { name: DECISION_FORM_COPY.retry })).toBeVisible({ timeout: 15_000 });
  await expect(note(page)).toHaveCount(0);
  await page.unroute('**/decisions');
});

test('the note shows in the ordinary change of a saved answer, also while the person types', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const projectId = await openQuestion(page, 'admin', Q, baseURL!);
  expect((await saveViaApi(baseURL!, 'admin', projectId, Q, { reason: 'Version 1' })).status).toBe(201);
  await page.reload(); await waitForQuestionPage(page);
  await expect(visible(page, DECISION_FORM_COPY.startingNote)).toHaveCount(1);
  await reasonBox(page).fill('Changed');
  await expect(visible(page, DECISION_FORM_COPY.startingNote)).toHaveCount(1);
});

test('after a conflict, "Discard my version" draws the form from the saved version and shows the note again', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await conflictOverSaved(page, baseURL!);
  await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.discardMine }).click();
  await expect(reasonBox(page)).toHaveValue('Owner saved first');
  await expect(visible(page, DECISION_FORM_COPY.startingNote)).toHaveCount(1);
});

test('a conflict on a first answer: the corner\'s "No decision yet." is not drawn beside "Saved version (1)"', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const projectId = await openQuestion(page, 'admin', Q, baseURL!);
  await expect(visible(page, QUESTION_COPY.current.none)).toHaveCount(1);
  await fillValid(page, { reason: MINE });
  expect((await saveViaApi(baseURL!, 'owner', projectId, Q, { reason: 'Owner saved first' })).status).toBe(201);
  await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
  await expect(conflictHeading(page)).toBeFocused({ timeout: 15_000 });
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
  // The page's own refresh (not a prefetch) is held until "Edit my version" has been pressed.
  const refresh = await routeRefresh(page, questionPath(projectId, Q), 'hold');
  // Nothing typed: Save sends the answer as it opened, and the reply is a conflict.
  await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
  await expect(conflictHeading(page)).toBeFocused({ timeout: 15_000 });
  await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.editMine }).click();
  await expect.poll(() => refresh.count()).toBeGreaterThan(0);
  // The premise: the refresh has not landed, the card's data is still version 1.
  await cardDataStillVersion1(page);
  refresh.release();
  await expect(visible(page, QUESTION_COPY.reading.history(2)).first()).toBeVisible({ timeout: 15_000 });
  await answerKept(page);
});
