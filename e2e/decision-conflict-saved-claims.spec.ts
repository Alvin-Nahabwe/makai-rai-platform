import 'dotenv/config';
import { expect, request as pwRequest, test, type Page } from '@playwright/test';
import { failOnDialog } from './helpers/dialogs';
import { fillValid, fixtureOrgSlug, historyPath, openQuestion, questionPath, saveViaApi, seatOf, seatRequest, stageOf, waitForQuestionPage } from './helpers/session';
import { testDb } from '../__tests__/helpers/db';
import { escapeRe } from '../__tests__/helpers/escapeRe';
import { currentAcceptances } from '../__tests__/helpers/legalStub';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { FINDING_NOTE, REASON_OPTIONAL, WITHDRAW_COPY, whoWhenSummary } from '../lib/decision/copy';
import { EVIDENCE_COPY } from '../lib/evidence/copy';
import { FIELD_COPY } from '../lib/ui/field/copy';
import { QUESTION_COPY } from '../lib/question/copy';
import { UI_COPY } from '../lib/ui/copy';
import { formatDeclaredDate } from '../lib/format/dates';
import type { DeclaredDate } from '../types/record';

/**
 * A conflict never leaves the card saying something about a version the form knows is no longer the current one. From the moment
 * a save meets a newer version, everything the card says about the older one (its saved lines, who entered it, the history count,
 * the seal markers, the finding link and the More menu's withdrawal) is not drawn, whether or not the page's reload has started,
 * landed or failed. The reload runs only when this browser holds a copy of the person's draft; when it lands, the card describes the
 * newer version, with its saved lines still hidden while the conflict view is open. Page data older than a version a save's reply
 * named does not put the older one back (the case "data older than the version a save's reply named" hands the page such data; a
 * version the form knows only from the page is not covered). The person's chosen answer and typed reason stay in the form
 * throughout, and the "The form shows the current decision" note is not shown while the form holds their own version.
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

/**
 * "Discard my version" pressed while no reload has brought version 2 to the page: the form shows version 2's answer at once, the
 * card still says nothing about version 1, and a Save pressed in that window never sends the discarded answer. Every save request
 * is recorded; the Save is answered (a refusal of the form, a status, or a move to the next question) before the check.
 */
async function saveInDiscardWindow(page: Page): Promise<void> {
  const sent: Array<{ reason?: unknown }> = [];
  await page.route('**/decisions', async (route) => {
    if (isSavePost(route.request().method(), route.request().url())) sent.push(route.request().postDataJSON() as { reason?: unknown });
    await route.fallback();
  });
  await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.discardMine }).click();
  await expect(reasonBox(page)).toHaveValue('Owner saved first');
  await cardDataStillVersion1(page);
  await nothingAboutVersion1(page);
  const answered = page.locator('[data-error-summary], [data-region="answer-form"] .save-status [role="status"]:not(:empty), [data-region="answer-form"] .save-status [role="alert"]:not(:empty)');
  const before = page.url();
  await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
  await expect.poll(async () => page.url() !== before || (await answered.filter({ visible: true }).count()) > 0, { timeout: 15_000 }).toBe(true);
  expect(sent.map((b) => b.reason), 'no save sends the discarded answer').not.toContain(MINE);
  await page.unroute('**/decisions');
}

for (const width of [1280, 375]) {
  test(`at ${width} px: while the conflict view shows, no saved claim sits beside "Not saved", before and after the reload lands`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    await conflictOverSaved(page, baseURL!);
    await expect(page.locator('[data-region="conflict"]').getByRole('heading', { name: DECISION_FORM_COPY.conflict.saved(2), exact: true })).toBeVisible();
    // The foot left visible beside the view describes the current version once the page's data has been refreshed.
    await expect(visible(page, QUESTION_COPY.reading.history(2)).first()).toBeVisible({ timeout: 15_000 });
    // And after it, the saved lines stay hidden while the view is open. Version 2's line goes on after the platform sentence
    // ("Version 1 is kept in the history."), so it is found by the sentence it holds, and it is on the page, only not drawn.
    await expect(visible(page, savedAs(1))).toHaveCount(0);
    await expect(visible(page, savedAs(2))).toHaveCount(0);
    const onPlatform = page.locator('.decision-card__saved-lines').getByText(new RegExp(escapeRe(UI_COPY.saved.onPlatform)));
    await expect(onPlatform).toHaveCount(1);
    await expect(onPlatform).toBeHidden();
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

  test('in the window after "Discard my version", before its reload lands, a Save never stores the discarded answer', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    let refresh!: Awaited<ReturnType<typeof routeRefresh>>;
    const { projectId } = await conflictOverSaved(page, baseURL!, async (id) => { refresh = await routeRefresh(page, questionPath(id, Q), 'hold'); });
    await saveInDiscardWindow(page);
    refresh.release();
    // Whatever the Save did, the history holds no version with the discarded answer.
    await page.goto(questionPath(projectId, Q)); await waitForQuestionPage(page);
    await expect(page.getByText(MINE, { exact: true })).toHaveCount(0);
    await expect(reasonBox(page)).not.toHaveValue(MINE);
  });
});

test('"Discard my version" pressed before the conflict\'s own reload lands, with a draft kept: a Save in that window never stores the discarded answer', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let refresh!: Awaited<ReturnType<typeof routeRefresh>>;
  const { projectId } = await conflictOverSaved(page, baseURL!, async (id) => { refresh = await routeRefresh(page, questionPath(id, Q), 'hold'); });
  // The conflict's reload is out and held: Discard is pressed before it lands.
  await expect.poll(() => refresh.count()).toBeGreaterThan(0);
  await saveInDiscardWindow(page);
  refresh.release();
  await page.goto(questionPath(projectId, Q)); await waitForQuestionPage(page);
  await expect(page.getByText(MINE, { exact: true })).toHaveCount(0);
  await expect(reasonBox(page)).not.toHaveValue(MINE);
});

test('"Save my version" succeeds while the conflict\'s reload is still held, with text typed during the save: the card never claims an older version than the status line, the typed text stays, and the next Save goes on the saved version', async ({ page, baseURL }) => {
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
  // Both refreshes are let go (the conflict's, asked for at version 2, then the save's): the card goes from hidden to version 3. The
  // text typed during the save is the person's and stays whatever data lands (it is newer than any saved version). This case does not
  // show older data arriving after the save; "data older than a later save" below does.
  refresh.release();
  await expect(visible(page, QUESTION_COPY.reading.history(3)).first()).toBeVisible({ timeout: 15_000 });
  await expect(visible(page, savedAs(2))).toHaveCount(0);
  await expect(visible(page, QUESTION_COPY.reading.history(2))).toHaveCount(0);
  await answerKept(page, `${MINE}, more`);
  // The form's base is the version the save made: the next Save names it.
  const sent = await recordSaves(page, true);
  await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
  await expect(page.getByRole('button', { name: DECISION_FORM_COPY.retry })).toBeVisible({ timeout: 15_000 });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ baseVersionNumber: 3, reason: `${MINE}, more` });
  await page.unroute('**/decisions');
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

/**
 * One rule for every state in which the form knows of a saved version newer than the page's data (a conflict found, then "Edit my
 * version", a refused "Save my version", or "Discard my version" before its reload lands; a first answer and a withdrawal included):
 * everything the card and the form say about "the current", "the saved" or "the last" decision is drawn from that newer version or is
 * not shown, and a Save sends the answer the form shows on that version as its base.
 *
 * The two versions differ in everything the form states, so a statement read from the older one shows: version 1 is the person's own
 * (Done, decided by them on 12 Oct 2026, no finding); the newer one is the owner's (Partly, decided by a supervisor on 3 Nov 2026,
 * which raises a finding), or the owner's withdrawal of version 1. What the page alone knows (whether the question has an open
 * finding) is not stated until the page's data is the newer version's.
 *
 * Evidence budget: the evidence route allows 10 POSTs a minute per account (lib/rate-limit.ts), and the admin and owner index-0 seats
 * are shared with other specs. Only the two cases that are about evidence give each version a link (`evidence`), one POST from each
 * seat a case; they stand far apart in this file, so a repeated run does not spend a seat's minute.
 */
const OWNER = 'Owner saved first';
const LINK = 'Owner link';
const MY_LINK = 'My link';
const OLD_DATE = '12 Oct 2026';
const NEW_DATE = '3 Nov 2026';
const C = DECISION_FORM_COPY.consequence;
type Variant = 'saved' | 'first' | 'withdrawn';
type Newer = { projectId: string; number: number; linkId: string | null; myLinkId: string | null; savedBy: string; refresh: Awaited<ReturnType<typeof routeRefresh>> };

/** A write through the API as the role's seat, with a fresh request id. */
async function post(baseURL: string, role: 'admin' | 'owner', path: string, data: Record<string, unknown>): Promise<{ status: number; body: { id: string } }> {
  const ctx = await seatRequest(baseURL, role);
  try {
    const res = await ctx.post(`/api/v1/orgs/${fixtureOrgSlug()}/projects/${path}`, { data: { requestId: crypto.randomUUID(), ...data } });
    return { status: res.status(), body: await res.json() };
  } finally {
    await ctx.dispose();
  }
}

async function blockStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage is blocked.', 'SecurityError'); } });
  });
}

/**
 * The person's Save meets a newer version, with every reload of the page's data held: the conflict view is open, and the page still
 * holds what it opened with. `number` is the newer version's. `decider` is the account version 1 names as its decider: the person's
 * own unless a case gives another.
 */
async function conflictWithNewer(page: Page, baseURL: string, variant: Variant, evidence = false, decider = seatOf('admin').userId): Promise<Newer> {
  const projectId = await openQuestion(page, 'admin', Q, baseURL);
  const answer = { stage: stageOf(Q), questionId: Q, scopeAnswer: null, optionsInPlace: [], reasonCode: null };
  let myLinkId: string | null = null;
  if (variant === 'first') await expect(visible(page, QUESTION_COPY.current.none)).toHaveCount(1);
  else {
    if (evidence) {
      const myLink = await post(baseURL, 'admin', `${projectId}/evidence`, { kind: 'link', url: 'https://example.org/my-evidence', label: MY_LINK });
      expect(myLink.status).toBe(201);
      myLinkId = myLink.body.id;
    }
    const mine = { ...answer, baseVersionNumber: null, status: 'done', reason: 'Version 1', decidedBy: { kind: 'member', userId: decider }, declaredDate: '2026-10-12', evidenceIds: myLinkId === null ? [] : [myLinkId] };
    expect((await post(baseURL, 'admin', `${projectId}/decisions`, mine)).status).toBe(201);
    await page.reload(); await waitForQuestionPage(page);
    await expect(visible(page, savedAs(1)).first()).toBeVisible();
    // Before the conflict the label is true: the link is evidence of the current decision.
    await expect(page.locator('[data-region="evidence-block"]').getByText(EVIDENCE_COPY.fromCurrent, { exact: true })).toHaveCount(evidence ? 1 : 0);
  }
  await fillValid(page, { reason: MINE });
  let linkId: string | null = null;
  if (variant === 'withdrawn') {
    const gone = { stage: stageOf(Q), baseVersionNumber: 1, withdrawalCode: 'entered_in_error', reason: 'Entered on the wrong question.' };
    expect((await post(baseURL, 'owner', `${projectId}/questions/${Q}/withdrawal`, gone)).status).toBe(201);
  } else {
    if (evidence) {
      const link = await post(baseURL, 'owner', `${projectId}/evidence`, { kind: 'link', url: 'https://example.org/owner-evidence', label: LINK });
      expect(link.status).toBe(201);
      linkId = link.body.id;
    }
    const theirs = { ...answer, baseVersionNumber: variant === 'first' ? null : 1, status: 'partly', reason: OWNER, decidedBy: { kind: 'outside_role', role: 'supervisor' }, declaredDate: '2026-11-03', evidenceIds: linkId === null ? [] : [linkId] };
    expect((await post(baseURL, 'owner', `${projectId}/decisions`, theirs)).status).toBe(201);
  }
  const refresh = await routeRefresh(page, questionPath(projectId, Q), 'hold');
  await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
  await expect(conflictHeading(page)).toBeFocused({ timeout: 15_000 });
  const number = variant === 'first' ? 1 : 2;
  await expect(page.locator('[data-region="conflict"]').getByRole('heading', { name: DECISION_FORM_COPY.conflict.saved(number), exact: true })).toBeVisible();
  const line = await page.locator('[data-region="conflict"]').getByText(/ saved a newer version at /).first().innerText();
  return { projectId, number, linkId, myLinkId, savedBy: line.split(' saved a newer version at ')[0], refresh };
}

/** The card's server data is still what the page opened with: version 1's corner, or "No decision yet." on a first answer. */
async function cardDataStillVersion(page: Page, variant: Variant): Promise<void> {
  await expect(page.locator('.decision-card__corner')).toContainText(variant === 'first' ? QUESTION_COPY.current.none : UI_COPY.saved.title(1));
}

/** While the page's data is older than the version the form knows: the card says nothing about what the page opened with. */
async function cardSilent(page: Page, variant: Variant): Promise<void> {
  if (variant === 'first') {
    await expect(visible(page, QUESTION_COPY.current.none)).toHaveCount(0);
    await expect(page.locator('.decision-card__corner')).toContainText(QUESTION_COPY.current.none);
  } else {
    await cardDataStillVersion1(page);
    await nothingAboutVersion1(page);
  }
}

/** Once the page's data is the newer version's, the card describes it. */
async function cardDescribesNewer(page: Page, variant: Variant, n: Newer): Promise<void> {
  await expect(visible(page, QUESTION_COPY.reading.history(n.number)).first()).toBeVisible({ timeout: 15_000 });
  await expect(visible(page, QUESTION_COPY.current.none)).toHaveCount(0);
  if (variant === 'saved') await expect(visible(page, savedAs(1))).toHaveCount(0);
  if (variant !== 'withdrawn') await expect(visible(page, new RegExp(escapeRe(DECISION_FORM_COPY.card.enteredBy(n.savedBy)))).first()).toBeVisible();
}

/**
 * What the form states about the current decision. `note`: "The form shows the current decision." is shown. `open`: Decided by and
 * Decided on are open (a change of a decision someone else made). `newerDate`: the date hint and the "Same date as the current decision"
 * shortcut name the newer version's date; false when the newer version has none (a withdrawal). Version 1's date is never named as the
 * current decision's. `consequence`: the line on what this save will do, exactly; a list for parts that must all be in it; null when
 * the line is not drawn.
 */
async function formStates(page: Page, s: { note: boolean; open: boolean; newerDate: boolean; consequence: string | string[] | null }): Promise<void> {
  await expect(visible(page, DECISION_FORM_COPY.startingNote)).toHaveCount(s.note ? 1 : 0);
  await expect(page.locator('#decision-decided-by')).toHaveCount(s.open ? 1 : 0);
  await expect(page.getByText(DECISION_FORM_COPY.lastDecidedOn(OLD_DATE))).toHaveCount(0);
  await expect(page.getByRole('button', { name: DECISION_FORM_COPY.sameAsCurrent(OLD_DATE) })).toHaveCount(0);
  await expect(visible(page, DECISION_FORM_COPY.lastDecidedOn(NEW_DATE))).toHaveCount(s.newerDate ? 1 : 0);
  await expect(page.getByRole('button', { name: DECISION_FORM_COPY.sameAsCurrent(NEW_DATE) }).filter({ visible: true })).toHaveCount(s.newerDate ? 1 : 0);
  const line = page.locator('[data-consequence]');
  if (s.consequence === null) await expect(line).toHaveCount(0);
  else if (typeof s.consequence === 'string') await expect(line).toHaveText(s.consequence);
  else for (const part of s.consequence) await expect(line).toContainText(part);
}

/** The form is drawn from the newer version: its answer, reason, decider, an empty date (someone else decided it) and its evidence. */
async function drawnFromNewer(page: Page, variant: Variant, n: Newer): Promise<void> {
  if (variant === 'withdrawn') {
    await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
    await expect(reasonBox(page)).toHaveValue('');
    await expect(page.locator('[data-region="evidence-block"]').getByText(MY_LINK)).toHaveCount(0);
    return;
  }
  await expect(page.getByRole('radio', { name: 'Partly', exact: true })).toBeChecked();
  await expect(reasonBox(page)).toHaveValue(OWNER);
  await expect(page.locator('#decision-decided-by')).toHaveValue('role:supervisor');
  await expect(page.getByLabel('Year', { exact: true })).toHaveValue('');
  const evidence = page.locator('[data-region="evidence-block"]');
  await expect(evidence.getByText(MY_LINK)).toHaveCount(0);
  await expect(evidence.getByText(EVIDENCE_COPY.fromCurrent, { exact: true })).toHaveCount(n.linkId === null ? 0 : 1);
  if (n.linkId !== null) await expect(evidence.getByText(LINK).first()).toBeVisible();
}

/**
 * The person's own version is still in the form, with the evidence it opened with. That evidence was version 1's; the newer version
 * does not hold it, so nothing calls it evidence "from the current decision".
 */
async function ownAnswerKept(page: Page, n: Newer): Promise<void> {
  await answerKept(page);
  const evidence = page.locator('[data-region="evidence-block"]');
  await expect(evidence.getByText(MY_LINK)).toHaveCount(n.myLinkId === null ? 0 : 1);
  await expect(evidence.getByText(EVIDENCE_COPY.fromCurrent, { exact: true })).toHaveCount(0);
}

/** Every save request from now on, as sent; `refuse` answers each with a 500 so nothing reaches the server. */
async function recordSaves(page: Page, refuse: boolean): Promise<Array<Record<string, unknown>>> {
  const sent: Array<Record<string, unknown>> = [];
  await page.route('**/decisions', async (route) => {
    if (!isSavePost(route.request().method(), route.request().url())) { await route.fallback(); return; }
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    if (refuse) await route.fulfill(API_500); else await route.fallback();
  });
  return sent;
}

/** The statements of the form while it holds the person's own version over the newer one, with the page behind (`held`) or caught up. */
const ownVersion = (variant: Variant, n: Newer, held: boolean) => ({
  note: false, open: variant !== 'withdrawn', newerDate: variant !== 'withdrawn',
  consequence: held ? C.version(n.number + 1) : `${variant === 'withdrawn' ? C.raisesNone('Done') : C.closesNot('Done')} ${C.version(n.number + 1)}`,
});
/**
 * The statements of the form drawn from the newer version: nothing differs from it, so no version line; a withdrawal leaves an empty
 * form. The note "The form shows the current decision." comes with the page's data, not before it.
 */
const newerVersion = (variant: Variant, n: Newer, held: boolean) => (variant === 'withdrawn'
  ? { note: false, open: false, newerDate: false, consequence: [FINDING_NOTE.slice(FINDING_NOTE.indexOf(', a finding')), C.version(n.number + 1).replace(/\.$/, '')] }
  : { note: !held, open: true, newerDate: true, consequence: held ? null : C.keepsOpen('Partly') });

test('evidence the person\'s own version carries is not called evidence "from the current decision" once a newer version is known, before and after the reload', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const n = await conflictWithNewer(page, baseURL!, 'saved', true);
  await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.editMine }).click();
  // The block still holds version 1's link; version 2 holds another, so the label would be untrue of it.
  await ownAnswerKept(page, n);
  const sent = await recordSaves(page, true);
  await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
  await expect(page.getByRole('button', { name: DECISION_FORM_COPY.retry })).toBeVisible({ timeout: 15_000 });
  expect(sent[0]).toMatchObject({ baseVersionNumber: 2, reason: MINE, evidenceIds: [n.myLinkId] });
  await page.unroute('**/decisions');
  n.refresh.release();
  await cardDescribesNewer(page, 'saved', n);
  await ownAnswerKept(page, n);
});

for (const width of [1280, 375]) for (const storage of [true, false]) for (const variant of ['saved', 'first', 'withdrawn'] as const) {
  const where = `at ${width} px, ${storage ? 'with a draft kept in this browser' : 'in a browser that cannot keep drafts'}, a newer ${variant === 'withdrawn' ? 'withdrawal' : variant === 'first' ? 'first answer by someone else' : 'version of a saved answer'}`;

  test(`${where}: after "Edit my version" the form states the newer version, and Save sends the person's answer on it`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    if (!storage) await blockStorage(page);
    const n = await conflictWithNewer(page, baseURL!, variant);
    // The view is open: nothing of the older version beside it, and the form's own statements are not on screen.
    await cardSilent(page, variant);
    await expect(reasonBox(page)).toBeHidden();
    await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.editMine }).click();
    await ownAnswerKept(page, n);
    await cardSilent(page, variant);
    await formStates(page, ownVersion(variant, n, true));
    const sent = await recordSaves(page, true);
    await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
    await expect(page.getByRole('button', { name: DECISION_FORM_COPY.retry })).toBeVisible({ timeout: 15_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ baseVersionNumber: n.number, status: 'done', reason: MINE, evidenceIds: n.myLinkId === null ? [] : [n.myLinkId] });
    await page.unroute('**/decisions');
    await cardSilent(page, variant);
    await formStates(page, ownVersion(variant, n, true));
    if (!storage) { expect(n.refresh.count(), 'no reload without a kept draft').toBe(0); return; }
    n.refresh.release();
    await cardDescribesNewer(page, variant, n);
    await ownAnswerKept(page, n);
    await formStates(page, ownVersion(variant, n, false));
  });

  test(`${where}: a refused "Save my version" leaves the form stating the newer version, and it sent the person's answer on it`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    if (!storage) await blockStorage(page);
    const n = await conflictWithNewer(page, baseURL!, variant);
    const sent = await recordSaves(page, true);
    await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.saveMine }).click();
    await expect(page.getByRole('button', { name: DECISION_FORM_COPY.retry })).toBeVisible({ timeout: 15_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ baseVersionNumber: n.number, status: 'done', reason: MINE, evidenceIds: n.myLinkId === null ? [] : [n.myLinkId] });
    await page.unroute('**/decisions');
    await ownAnswerKept(page, n);
    await cardSilent(page, variant);
    await formStates(page, ownVersion(variant, n, true));
    if (!storage) { expect(n.refresh.count(), 'no reload without a kept draft').toBe(0); return; }
    n.refresh.release();
    await cardDescribesNewer(page, variant, n);
    await ownAnswerKept(page, n);
    await formStates(page, ownVersion(variant, n, false));
  });

  test(`${where}: "Discard my version" draws the whole form from the newer version before its reload lands, and a Save there sends nothing of the discarded answer`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    if (!storage) await blockStorage(page);
    const n = await conflictWithNewer(page, baseURL!, variant);
    await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.discardMine }).click();
    await expect.poll(() => n.refresh.count()).toBeGreaterThan(0);
    await drawnFromNewer(page, variant, n);
    await cardSilent(page, variant);
    await formStates(page, newerVersion(variant, n, true));
    // Save as the form stands: the newer version's answer needs its date (someone else decided it), a withdrawal leaves no answer.
    // Save is pressed from the keyboard: with no status line the phone's save bar is at its lowest, and under `next dev` the dev
    // tools' own button lies over Save there and takes a pointer's click.
    const sent = await recordSaves(page, true);
    await page.getByRole('button', { name: DECISION_FORM_COPY.save }).press('Enter');
    await expect(page.locator('[data-error-summary]')).toBeVisible();
    expect(sent).toHaveLength(0);
    await page.unroute('**/decisions');
    n.refresh.release();
    await cardDescribesNewer(page, variant, n);
    await drawnFromNewer(page, variant, n);
    await formStates(page, newerVersion(variant, n, false));
  });
}

for (const storage of [true, false]) for (const variant of ['saved', 'first'] as const) {
  test(`a Save in the window after "Discard my version" reaches the server (${variant === 'first' ? 'a first answer' : 'a saved answer'}, ${storage ? 'draft kept' : 'no drafts'}): it stores the newer version's answer on that version, and no version holds the discarded text`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    if (!storage) await blockStorage(page);
    // One of the four gives each version its own link: the Save then carries the newer version's evidence, not the discarded one's.
    const n = await conflictWithNewer(page, baseURL!, variant, storage && variant === 'saved');
    await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.discardMine }).click();
    await drawnFromNewer(page, variant, n);
    await cardSilent(page, variant);
    // The date is the one thing the form asks for (D-425): today, then Save, with every reload still held.
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    const sent = await recordSaves(page, false);
    const reply = page.waitForResponse((r) => isSavePost(r.request().method(), r.url()));
    await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
    // The server stored it while every reload was still held (the move to the next question waits for the held reload).
    expect((await reply).status()).toBe(201);
    expect(n.refresh.count()).toBeGreaterThan(0);
    await cardDataStillVersion(page, variant);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ baseVersionNumber: n.number, status: 'partly', reason: OWNER, evidenceIds: n.linkId === null ? [] : [n.linkId], decidedBy: { kind: 'outside_role', role: 'supervisor' } });
    expect(sent[0].declaredDate).not.toBe('2026-11-03');
    await page.unroute('**/decisions');
    n.refresh.release();
    await expect(page).toHaveURL(/\?saved=/, { timeout: 30_000 });
    // The server's record: one more version, the newest holding the newer version's answer, and the discarded text in none.
    await page.goto(historyPath(n.projectId, Q));
    await expect(page.locator('[data-version-number]')).toHaveCount(n.number + 1);
    await expect(page.locator(`[data-version-number="${n.number + 1}"]`)).toContainText(OWNER);
    await expect(page.getByText(MINE, { exact: true })).toHaveCount(0);
  });
}

/** The device's date as the form writes a declared date ("26 Nov 2026"): what "today" saves as. */
function todayText(): string {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return formatDeclaredDate(`${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}` as DeclaredDate);
}

test('a save that stays on the question, its reload held: the form states the version it just saved, not the one the page opened with', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const projectId = await openQuestion(page, 'admin', Q, baseURL!);
  const mine = { stage: stageOf(Q), questionId: Q, scopeAnswer: null, optionsInPlace: [], reasonCode: null, baseVersionNumber: null, status: 'done', reason: 'Version 1', decidedBy: { kind: 'member', userId: seatOf('admin').userId }, declaredDate: '2026-10-12', evidenceIds: [] };
  expect((await post(baseURL!, 'admin', `${projectId}/decisions`, mine)).status).toBe(201);
  await page.reload(); await waitForQuestionPage(page);
  // Decided by and Decided on are opened, so the date hint is on screen: before the save it names version 1's date.
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(visible(page, DECISION_FORM_COPY.lastDecidedOn(OLD_DATE))).toHaveCount(1);
  await reasonBox(page).fill(MINE);
  const refresh = await routeRefresh(page, questionPath(projectId, Q), 'hold');
  // The save is held so that the person types while it is out: its reply then keeps them on the question (CR-1).
  let releaseSave!: () => void;
  const saveHeld = new Promise<void>((r) => { releaseSave = r; });
  await page.route('**/decisions', async (route) => {
    if (!isSavePost(route.request().method(), route.request().url())) { await route.fallback(); return; }
    await saveHeld;
    await route.fallback();
  });
  await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
  await reasonBox(page).fill(`${MINE}, more`);
  releaseSave();
  await expect(page.locator('[data-region="answer-form"] .save-status').getByRole('status')).toContainText(/version 2/, { timeout: 15_000 });
  await page.unroute('**/decisions');
  await expect.poll(() => refresh.count()).toBeGreaterThan(0);
  // The page's data is still version 1's; the form states version 2, saved today, and nothing about a finding the page cannot know.
  await cardDataStillVersion1(page);
  await nothingAboutVersion1(page);
  await expect(page.getByText(DECISION_FORM_COPY.lastDecidedOn(OLD_DATE))).toHaveCount(0);
  await expect(visible(page, DECISION_FORM_COPY.lastDecidedOn(todayText()))).toHaveCount(1);
  await expect(page.locator('[data-consequence]')).toHaveText(C.version(3));
  refresh.release();
  await expect(visible(page, QUESTION_COPY.reading.history(2)).first()).toBeVisible({ timeout: 15_000 });
  await expect(visible(page, DECISION_FORM_COPY.lastDecidedOn(todayText()))).toHaveCount(1);
  await expect(page.locator('[data-consequence]')).toHaveText(`${C.raisesNone('Done')} ${C.version(3)}`);
  await answerKept(page, `${MINE}, more`);
});

/**
 * Data older than the newest version the form knows. In a browser that keeps no drafts the conflict sends no reload, so the page still
 * holds version 1 when "Save my version" is answered. That answer is made up here from the conflict's version, as a replay naming
 * version 3 ("This was already saved ... (version 3)"), and the server never stores it: the reload the save then asks for is answered
 * from version 2, older than the version the reply named. (What was tried to get such data without making a reply up, and why the
 * router does not deliver it, is in the task's report; no claim is made here that it happens in use.)
 */
test('data older than the version a save\'s reply named reaches the page: the form and the card do not go back to it, and the next Save names the saved version', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await blockStorage(page);
  let named: Record<string, unknown> | null = null;
  page.on('response', async (res) => {
    if (res.status() === 409 && isSavePost(res.request().method(), res.url())) named = (await res.json() as { current: Record<string, unknown> }).current;
  });
  const n = await conflictWithNewer(page, baseURL!, 'saved');
  await expect.poll(() => named).not.toBeNull();
  const me = { userId: seatOf('admin').userId, name: 'The person', formerMember: false };
  await page.route('**/decisions', async (route) => {
    if (!isSavePost(route.request().method(), route.request().url())) { await route.fallback(); return; }
    const sent = route.request().postDataJSON() as { reason: string; baseVersionNumber: number; declaredDate: string };
    const made = {
      ...named!, id: crypto.randomUUID(), versionNumber: sent.baseVersionNumber + 1, baseVersionNumber: sent.baseVersionNumber, status: 'done',
      reason: sent.reason, decidedBy: { kind: 'member', user: me }, declaredDate: sent.declaredDate, enteredBy: me, receivedAt: new Date().toISOString(), evidence: [],
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(made) });
  });
  await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.saveMine }).click();
  await expect(page.locator('[data-region="answer-form"] .save-status').getByRole('status')).toContainText(/version 3/, { timeout: 15_000 });
  await page.unroute('**/decisions');
  // The save's reload lands with version 2's data (the page held version 1 until now): the card's own data names version 2.
  await expect.poll(() => n.refresh.count()).toBeGreaterThan(0);
  await cardDataStillVersion1(page);
  n.refresh.release();
  await expect(page.locator('.decision-card__corner')).toContainText(UI_COPY.saved.title(2), { timeout: 15_000 });
  // Nothing of version 2 is claimed as the current decision, and the form still holds and states the answer saved as version 3.
  await expect(visible(page, savedAs(2))).toHaveCount(0);
  await expect(visible(page, QUESTION_COPY.reading.history(2))).toHaveCount(0);
  await expect(page.locator('details.more-menu > summary').filter({ visible: true })).toHaveCount(0);
  await answerKept(page);
  await expect(page.locator('#decision-decided-by')).toHaveCount(0);
  await expect(visible(page, DECISION_FORM_COPY.startingNote)).toHaveCount(0);
  const sent = await recordSaves(page, true);
  await reasonBox(page).fill(`${MINE}, again`);
  await expect(page.locator('[data-consequence]')).toHaveText(C.version(4));
  await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
  await expect(page.getByRole('button', { name: DECISION_FORM_COPY.retry })).toBeVisible({ timeout: 15_000 });
  expect(sent[0]).toMatchObject({ baseVersionNumber: 3, reason: `${MINE}, again` });
  await page.unroute('**/decisions');
});

/**
 * The person's own version names a decider who has since left the organisation. Such a person is on no member list, so the form can
 * name them only from a version that names them. Once a newer version by someone else is the current one the form knows, the conflict
 * view's "Your version", the Decided by field and the who and when line still name them, with "(former member)", and a Save posts the
 * decider the form shows. The form drawn from the newer version ("Discard my version") offers no option for them.
 *
 * The departed member is real: invited by the owner, registered through the invitation, then removed by the owner through the
 * members route, which leaves no membership and a `member_removed` event (lib/data/views.ts `memberHistory`: 'former'). One is made
 * for each worker and its invitation and account are closed after it; no shared fixture seat changes.
 *
 * Not covered here: a draft restored on a page that already holds the newer version. The form never opened from the version that
 * names that person, so it has no name for them (the conflict view says "not chosen yet"); that was so before this file's cases.
 */
test.describe('a decider who has left the organisation decided the person\'s own version', () => {
  const NAME = `Departed Decider ${Date.now()}`;
  const EMAIL = `claims-spec-departed-${Date.now()}@fixture.test`;
  const LABEL = DECISION_FORM_COPY.formerMember(NAME);
  /** The departed member's account id. */
  let gone = '';

  test.beforeAll(async () => {
    const baseURL = test.info().project.use.baseURL!;
    const members = `/api/v1/orgs/${fixtureOrgSlug()}/members`;
    const owner = await seatRequest(baseURL, 'owner');
    try {
      const invited = await owner.post(members, { data: { requestId: crypto.randomUUID(), email: EMAIL, role: 'assessor', showLink: true } });
      expect(invited.status(), 'the invitation').toBe(201);
      const token = String(((await invited.json()) as { acceptUrl: string }).acceptUrl).split('/').pop();
      const anonymous = await pwRequest.newContext({ baseURL });
      try {
        const registered = await anonymous.post(`/api/v1/invitations/${token}/register`, { data: { name: NAME, password: `Aa1!${crypto.randomUUID()}`, acceptances: currentAcceptances() } });
        expect(registered.status(), 'the invited person registers').toBe(201);
      } finally {
        await anonymous.dispose();
      }
      const list = (await (await owner.get(members)).json()) as Array<{ userId: string; user: { name: string } }>;
      gone = list.find((m) => m.user.name === NAME)?.userId ?? '';
      expect(gone, 'the new member is listed').not.toBe('');
      expect((await owner.delete(`${members}/${gone}`, { data: { requestId: crypto.randomUUID() } })).status(), 'the owner removes them').toBe(204);
    } finally {
      await owner.dispose();
    }
  });

  test.afterAll(async () => {
    // The membership is already gone (the removal above). The invitation row goes, and the account is closed; its row stays, as the
    // versions that name it do.
    try {
      await testDb.invitation.deleteMany({ where: { email: EMAIL } });
      await testDb.user.updateMany({ where: { email: EMAIL }, data: { isActive: false, passwordHash: 'not-a-login' } });
    } finally {
      await testDb.$disconnect();
    }
  });

  const decidedBy = (page: Page) => page.locator('#decision-decided-by');

  /** The Decided by field shows the departed member as its chosen option, labelled, and lists them once. */
  async function fieldNamesThem(page: Page): Promise<void> {
    await expect(decidedBy(page)).toHaveValue(`member:${gone}`);
    await expect(decidedBy(page).locator('option:checked')).toHaveText(LABEL);
    await expect(decidedBy(page).locator('option', { hasText: NAME })).toHaveCount(1);
  }

  /**
   * The form names the decider it holds. Over a newer decision by someone else Decided by is open, and the field shows them. Over a
   * withdrawal the fields are closed: the who and when line names them, and Change opens the field on them.
   */
  async function formNamesThem(page: Page, variant: Variant): Promise<void> {
    if (await decidedBy(page).count() === 0) {
      expect(variant, 'Decided by is closed only over a withdrawal').toBe('withdrawn');
      await expect(page.locator('#decision-who-when-summary')).toContainText(whoWhenSummary(LABEL, ''));
      await page.getByRole('button', { name: 'Change', exact: true }).click();
    }
    await fieldNamesThem(page);
  }

  /** The conflict view's "Your version" names them as its decider, and does not say "not chosen yet". */
  async function viewNamesThem(page: Page): Promise<void> {
    const view = page.locator('[data-region="conflict"]');
    await expect(view.locator('dd').filter({ hasText: new RegExp(`^${escapeRe(LABEL)}, `) })).toHaveCount(1);
    await expect(view.getByText(DECISION_FORM_COPY.conflict.notChosen)).toHaveCount(0);
  }

  /** What a recorded save posted: the person's answer on the newer version, decided by the departed member the field shows. */
  async function postedThem(page: Page, sent: Array<Record<string, unknown>>, n: Newer): Promise<void> {
    const last = sent[sent.length - 1];
    expect(last).toMatchObject({ baseVersionNumber: n.number, reason: MINE, decidedBy: { kind: 'member', userId: gone } });
    expect(`member:${(last.decidedBy as { userId: string }).userId}`, 'the request names the decider the field shows').toBe(await decidedBy(page).inputValue());
  }

  test('a decider who has left, on the page as it opens: the Decided by field shows them as chosen, labelled a former member', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const projectId = await openQuestion(page, 'admin', Q, baseURL!);
    const mine = { stage: stageOf(Q), questionId: Q, scopeAnswer: null, optionsInPlace: [], reasonCode: null, baseVersionNumber: null, status: 'done', reason: 'Version 1', decidedBy: { kind: 'member', userId: gone }, declaredDate: '2026-10-12', evidenceIds: [] };
    // The server takes a former member as the decider of a new version.
    expect((await post(baseURL!, 'admin', `${projectId}/decisions`, mine)).status).toBe(201);
    await page.reload(); await waitForQuestionPage(page);
    await fieldNamesThem(page);
  });

  for (const width of [1280, 375]) for (const storage of [true, false]) {
    const where = `a decider who has left, at ${width} px, ${storage ? 'with a draft kept in this browser' : 'in a browser that cannot keep drafts'}`;

    for (const variant of ['saved', 'withdrawn'] as const) {
      test(`${where}, a newer ${variant === 'withdrawn' ? 'withdrawal' : 'version by someone else'}: the view and, after "Edit my version", the form name them, and Save posts them, before and after the reload`, async ({ page, baseURL }) => {
        await page.setViewportSize({ width, height: 900 });
        if (!storage) await blockStorage(page);
        const n = await conflictWithNewer(page, baseURL!, variant, false, gone);
        await viewNamesThem(page);
        await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.editMine }).click();
        await ownAnswerKept(page, n);
        // Nothing the form states about the current decision comes from version 1 (formStates), and the card is silent.
        await cardSilent(page, variant);
        await formStates(page, ownVersion(variant, n, true));
        await formNamesThem(page, variant);
        const sent = await recordSaves(page, true);
        await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
        await expect(page.getByRole('button', { name: DECISION_FORM_COPY.retry })).toBeVisible({ timeout: 15_000 });
        expect(sent).toHaveLength(1);
        await postedThem(page, sent, n);
        await fieldNamesThem(page);
        if (!storage) { expect(n.refresh.count(), 'no reload without a kept draft').toBe(0); await page.unroute('**/decisions'); return; }
        // The reload lands: the page's data is the newer version's, which does not name them.
        n.refresh.release();
        await cardDescribesNewer(page, variant, n);
        await ownAnswerKept(page, n);
        await fieldNamesThem(page);
        await page.getByRole('button', { name: DECISION_FORM_COPY.retry }).click();
        await expect.poll(() => sent.length).toBe(2);
        await postedThem(page, sent, n);
        await page.unroute('**/decisions');
      });
    }

    test(`${where}: a refused "Save my version" posted them, and the form names them, before and after the reload`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width, height: 900 });
      if (!storage) await blockStorage(page);
      const n = await conflictWithNewer(page, baseURL!, 'saved', false, gone);
      await viewNamesThem(page);
      const sent = await recordSaves(page, true);
      await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.saveMine }).click();
      await expect(page.getByRole('button', { name: DECISION_FORM_COPY.retry })).toBeVisible({ timeout: 15_000 });
      expect(sent).toHaveLength(1);
      await ownAnswerKept(page, n);
      await cardSilent(page, 'saved');
      await formStates(page, ownVersion('saved', n, true));
      await fieldNamesThem(page);
      await postedThem(page, sent, n);
      if (!storage) { expect(n.refresh.count(), 'no reload without a kept draft').toBe(0); await page.unroute('**/decisions'); return; }
      n.refresh.release();
      await cardDescribesNewer(page, 'saved', n);
      await fieldNamesThem(page);
      await page.getByRole('button', { name: DECISION_FORM_COPY.retry }).click();
      await expect.poll(() => sent.length).toBe(2);
      await postedThem(page, sent, n);
      await page.unroute('**/decisions');
    });
  }

  for (const width of [1280, 375]) {
    test(`a decider who has left, at ${width} px: the conflict view still names them after the reload has landed under it, and so does the form after "Edit my version"`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width, height: 900 });
      const n = await conflictWithNewer(page, baseURL!, 'saved', false, gone);
      await viewNamesThem(page);
      n.refresh.release();
      // The foot beside the open view describes version 2: the page's data has landed.
      await expect(visible(page, QUESTION_COPY.reading.history(2)).first()).toBeVisible({ timeout: 15_000 });
      await viewNamesThem(page);
      await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.editMine }).click();
      await ownAnswerKept(page, n);
      await formStates(page, ownVersion('saved', n, false));
      await fieldNamesThem(page);
      // Choosing someone else does not take them off the list: the person can come back to them.
      await decidedBy(page).selectOption('role:supervisor');
      await expect(decidedBy(page).locator('option', { hasText: NAME })).toHaveCount(1);
      await decidedBy(page).selectOption(`member:${gone}`);
      await fieldNamesThem(page);
    });
  }

  test('a decider who has left: "Save my version" reaches the server, and the stored version names them as the view did', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const n = await conflictWithNewer(page, baseURL!, 'saved', false, gone);
    await viewNamesThem(page);
    const sent = await recordSaves(page, false);
    const reply = page.waitForResponse((r) => isSavePost(r.request().method(), r.url()));
    await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.saveMine }).click();
    expect((await reply).status()).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ baseVersionNumber: 2, reason: MINE, decidedBy: { kind: 'member', userId: gone } });
    await page.unroute('**/decisions');
    n.refresh.release();
    await expect(page).toHaveURL(/\?saved=/, { timeout: 30_000 });
    // The server's record: version 3 holds the person's answer, decided by the departed member, as the view said.
    await page.goto(historyPath(n.projectId, Q));
    await expect(page.locator('[data-version-number]')).toHaveCount(3);
    const stored = page.locator('[data-version-number="3"]');
    await expect(stored).toContainText(MINE);
    await expect(stored.locator('dd').filter({ hasText: new RegExp(`^${escapeRe(LABEL)}, `) })).toHaveCount(1);
  });

  test('a decider who has left: after "Discard my version" the form is the newer version\'s and offers no option for them, before and after the reload', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const n = await conflictWithNewer(page, baseURL!, 'saved', false, gone);
    await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.discardMine }).click();
    await expect.poll(() => n.refresh.count()).toBeGreaterThan(0);
    await drawnFromNewer(page, 'saved', n);
    await expect(decidedBy(page).locator('option', { hasText: NAME })).toHaveCount(0);
    n.refresh.release();
    await cardDescribesNewer(page, 'saved', n);
    await drawnFromNewer(page, 'saved', n);
    await expect(decidedBy(page).locator('option', { hasText: NAME })).toHaveCount(0);
  });
});
