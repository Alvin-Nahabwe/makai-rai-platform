import { expect, test, type Page } from '@playwright/test';
import { failOnDialog } from './helpers/dialogs';
import { actAsSeat, fillValid, fixtureOrgSlug, newProject, openQuestion, ppRange, questionPath, saveStatus, seatOf, seedAnswers, stagePath, waitForQuestionPage } from './helpers/session';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { FIELD_COPY } from '../lib/ui/field/copy';
import { formatDeclaredDate } from '../lib/format/dates';
import { STAGE_END_COPY } from '../lib/question/end/copy';

/**
 * Answer cost (Phase 2 release 2, design 2026-11-22): the common answer is a pick and a Save. The form opens with "Decided by you,
 * <date> · Change", the typed reason is optional, a clean Save moves to the next unanswered question (or the stage's end screen)
 * and a focused line there says what was saved, and the Next link is a button. Fixture content 0.0.1: Pre-processing is
 * Q-PP-01 to Q-PP-12, the personal-data gate, Q-PP-13 and Q-PP-14 (hidden when the gate is No), then Q-PP-15 to Q-PP-23.
 */
const GATE = 'Q-PP-GATE-SENSITIVE';
const STAGE = 'pre-processing';
const F = DECISION_FORM_COPY;

test.beforeEach(async ({ page }) => { failOnDialog(page); });

/** The device's today, as the form's own default is (the browser and this process share a clock and a zone). */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const save = (page: Page) => page.getByRole('button', { name: 'Save decision', exact: true });
const arrival = (page: Page) => page.locator('[data-saved-arrival]');
const unsavedLive = (page: Page) => page.locator('.save-status .save-status__unsaved-live');

/** The address a clean Save of `saved` leaves: the next question's, with `saved` naming the question just answered. */
const withSaved = (projectId: string, next: string, saved: string): RegExp => new RegExp(`${questionPath(projectId, next)}\\?saved=${saved}$`);

/** The question's current version, as the Assessor reads it through route 1's GET. */
async function current(page: Page, projectId: string, questionId: string): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/v1/orgs/${fixtureOrgSlug()}/projects/${projectId}/questions/${questionId}/decision?stage=${STAGE}`);
  expect(res.status(), `reading ${questionId}`).toBe(200);
  const { current: version } = (await res.json()) as { current: Record<string, unknown> | null };
  expect(version, `${questionId} has a current version`).not.toBeNull();
  return version!;
}

const SAVED_LINE = (n: number): RegExp => new RegExp(`^Your answer to question ${n} is saved: decided by you, ${formatDeclaredDate(today()).replace(/ /g, '\\s')}\\. Back to question ${n}$`);

test('a first pass through pre-processing with picks and Save only', async ({ page, baseURL }) => {
  const me = seatOf('assessor');
  const projectId = await openQuestion(page, 'assessor', 'Q-PP-01', baseURL!);

  // Defaults show before Save: who and when as one line, and no "unsaved" line from the mount's fill of today.
  const summary = page.locator('#decision-who-when-summary');
  await expect(summary).toHaveText(`Decided by you, ${formatDeclaredDate(today())}`);
  await page.waitForTimeout(600); // a negative check: give a wrongly counted mount fill the time to show
  await expect(unsavedLive(page)).toHaveText('');
  await expect(page.getByLabel(`${F.fields.reason} (optional)`, { exact: true })).toHaveValue('');

  // Done and Save: the next unanswered question, with the saved line, focused.
  await page.getByRole('radio', { name: 'Done', exact: true }).check();
  await save(page).click();
  await expect(page).toHaveURL(withSaved(projectId, 'Q-PP-02', 'Q-PP-01'));
  await expect(arrival(page)).toHaveText(SAVED_LINE(1));
  await expect(arrival(page)).toBeFocused();
  await expect(arrival(page).getByRole('link', { name: 'Back to question 1' })).toHaveAttribute('href', questionPath(projectId, 'Q-PP-01'));

  // Not yet needs the picked main reason and no typed one.
  await waitForQuestionPage(page);
  await page.getByRole('radio', { name: 'Not yet', exact: true }).check();
  await page.getByLabel(`${F.fields.reasonCode} ${FIELD_COPY.required}`).selectOption('ny_planned_later');
  await save(page).click();
  await expect(page).toHaveURL(withSaved(projectId, 'Q-PP-03', 'Q-PP-02'));
  await expect(arrival(page)).toHaveText(SAVED_LINE(2));
  await expect(arrival(page)).toBeFocused();

  // Q-PP-03 to Q-PP-11 through the API, so the walk can reach the gate: Q-PP-12 is the last question before it.
  await seedAnswers(baseURL!, projectId, ppRange(3, 11));
  await page.goto(questionPath(projectId, 'Q-PP-12'));
  await waitForQuestionPage(page);
  await fillValid(page, { reason: '' });
  await save(page).click();
  await expect(page).toHaveURL(withSaved(projectId, GATE, 'Q-PP-12'));

  // The gate: answer No. Q-PP-13 and Q-PP-14 no longer apply, so the walk goes on to Q-PP-15.
  await waitForQuestionPage(page);
  await page.getByRole('radio', { name: 'No', exact: true }).check();
  await save(page).click();
  await expect(page).toHaveURL(withSaved(projectId, 'Q-PP-15', GATE));
  expect(page.url()).not.toMatch(/Q-PP-1[34]/);
  await expect(arrival(page)).toHaveText(/^Your answer to question 13 is saved: decided by you, /);

  // The stored versions: decided by the Assessor, declared today, no typed reason stored.
  const first = await current(page, projectId, 'Q-PP-01');
  expect(first).toMatchObject({ status: 'done', reason: null, declaredDate: today(), decidedBy: { kind: 'member', user: { userId: me.userId } } });
  const second = await current(page, projectId, 'Q-PP-02');
  expect(second).toMatchObject({ status: 'not_yet', reasonCode: 'ny_planned_later', reason: null, declaredDate: today(), decidedBy: { kind: 'member', user: { userId: me.userId } } });
  const gate = await current(page, projectId, GATE);
  expect(gate).toMatchObject({ scopeAnswer: 'no', reason: null, declaredDate: today(), decidedBy: { kind: 'member', user: { userId: me.userId } } });
});

test('a save that left a file out stays on the question', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const projectId = await openQuestion(page, 'assessor', 'Q-PP-01', baseURL!);
  await fillValid(page);
  // Hold the upload, so it never finishes; "Save without" sends the answer with the file left out.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/evidence', async (route) => {
    if (route.request().method() === 'POST') { await held; await route.abort(); } else await route.continue();
  });
  await page.locator('input[type="file"]').setInputFiles({ name: 'costing-sheet.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nheld upload\n') });
  await save(page).click();
  await expect(page.locator('[data-upload-wait]')).toContainText('Waiting for costing-sheet.pdf to finish uploading.');
  const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/decisions'));
  await page.getByRole('button', { name: F.saveWithout(1) }).click();
  expect(((await sent).postDataJSON() as { evidenceIds: string[] }).evidenceIds).toEqual([]);
  await expect(saveStatus(page)).toHaveText(/^Saved at .+ as version 1\./, { timeout: 30_000 });
  await expect(page.getByText(`${F.savedWithout.before}costing-sheet.pdf${F.savedWithout.after}`)).toBeVisible();
  // The person had a message to read, so the page stays: same address, no saved line.
  await page.waitForTimeout(600);
  expect(new URL(page.url()).pathname).toBe(questionPath(projectId, 'Q-PP-01'));
  expect(new URL(page.url()).search).toBe('');
  await expect(arrival(page)).toHaveCount(0);
  release();
});

test("the last unanswered question's Save goes to the end screen, with the saved line, focused", async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  // Everything that applies except Q-PP-23 is answered (the gate No hides Q-PP-13 and Q-PP-14).
  await seedAnswers(baseURL!, projectId, [...ppRange(1, 12), GATE, ...ppRange(15, 22)]);
  await actAsSeat(page, 'assessor');
  await page.goto(questionPath(projectId, 'Q-PP-23'));
  await waitForQuestionPage(page);
  await fillValid(page);
  await save(page).click();
  await expect(page).toHaveURL(new RegExp(`${stagePath(projectId, STAGE)}/end\\?saved=Q-PP-23$`));
  await expect(page.getByRole('heading', { level: 1, name: STAGE_END_COPY.heading })).toBeVisible();
  // Q-PP-23 is the 24th row of the stage (the gate is a row of its own).
  await expect(arrival(page)).toHaveText(SAVED_LINE(24));
  await expect(arrival(page)).toBeFocused();
  await expect(arrival(page).getByRole('link', { name: 'Back to question 24' })).toHaveAttribute('href', questionPath(projectId, 'Q-PP-23'));
  // Focus is there and only there: nothing takes it away a moment later.
  await page.waitForTimeout(600);
  await expect(arrival(page)).toBeFocused();
  expect(await page.evaluate(() => document.querySelectorAll(':focus').length)).toBe(1);
});

test('browser check 1: Change opens Decided by and Decided on in place and focus goes to Decided by', async ({ page, baseURL }) => {
  await openQuestion(page, 'assessor', 'Q-PP-01', baseURL!);
  await expect(page.locator('#decision-decided-by')).toHaveCount(0);
  await expect(page.getByLabel('Day', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(page.locator('#decision-decided-by')).toBeFocused();
  // Today's values: you, and the device's date.
  await expect(page.locator('#decision-decided-by')).toHaveValue(`member:${seatOf('assessor').userId}`);
  const [year, month, day] = today().split('-').map(Number);
  await expect(page.getByLabel('Day', { exact: true })).toHaveValue(String(day));
  await expect(page.getByLabel('Month', { exact: true })).toHaveValue(String(month));
  await expect(page.getByLabel('Year', { exact: true })).toHaveValue(String(year));
  // One way: the summary line and its button are gone.
  await expect(page.getByRole('button', { name: 'Change', exact: true })).toHaveCount(0);
  await expect(page.locator('#decision-who-when-summary')).toHaveCount(0);
});

test('browser check 2: after a clean Save, focus is on the saved line only, and stays there', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', 'Q-PP-01', baseURL!);
  await fillValid(page, { reason: '' });
  await save(page).click();
  await expect(page).toHaveURL(withSaved(projectId, 'Q-PP-02', 'Q-PP-01'));
  await expect(arrival(page)).toBeFocused();
  await page.waitForTimeout(800); // the page's own arrival cue and the form's mount must not take focus afterwards
  const where = await page.evaluate(() => ({
    onLine: document.activeElement?.matches('[data-saved-arrival]') ?? false,
    headingFocused: document.activeElement?.id === 'question-heading',
    focused: document.querySelectorAll(':focus').length,
  }));
  expect(where).toEqual({ onLine: true, headingFocused: false, focused: 1 });
  // A second Save on the next question arrives on the same route and takes focus again, to its own line.
  await waitForQuestionPage(page);
  await fillValid(page, { reason: '' });
  await save(page).click();
  await expect(page).toHaveURL(withSaved(projectId, 'Q-PP-03', 'Q-PP-02'));
  await expect(arrival(page)).toHaveText(SAVED_LINE(2));
  await expect(arrival(page)).toBeFocused();
});

test('browser check 3: a form that has only loaded its defaults shows no unsaved line; a typed edit does', async ({ page, baseURL }) => {
  await openQuestion(page, 'assessor', 'Q-PP-01', baseURL!);
  await expect(page.locator('#decision-who-when-summary')).toHaveText(`Decided by you, ${formatDeclaredDate(today())}`);
  await page.waitForTimeout(800);
  await expect(unsavedLive(page)).toHaveText('');
  await expect(page.locator('.save-status__unsaved-short')).toHaveCount(0);
  // The line is there to be found: typing makes it show.
  await page.getByLabel(`${F.fields.reason} (optional)`, { exact: true }).fill('Typed and not saved');
  await expect(unsavedLive(page)).toHaveText(F.unsaved);
});

/**
 * Browser checks 4 and 5. Q-PP-03's next question, Q-PP-04, has a 148-character text: too long for two lines at 1280 and for one at 375.
 * M4 (design finish review): the words end in an ellipsis when cut. Chromium draws none on a clamped last line aligned to the end
 * that ends on a whole word, so the words are start-aligned inside a box as wide as they are; the check reads the rules in force and
 * that the text really is cut (scrollHeight over clientHeight at 1280, scrollWidth over clientWidth at 375). The save bar's Next
 * button must also stay inside the screen, the bar and beside Save, and the page must not scroll sideways.
 */
for (const [width, height] of [[1280, 800], [375, 812]] as const) {
  test(`browser checks 4 and 5: at ${width} px the Next button's long words show an ellipsis and the button does not overflow the save bar`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height });
    await openQuestion(page, 'assessor', 'Q-PP-03', baseURL!);
    const bar = page.locator('.decision-save-bar');
    const next = bar.locator('a.decision-next');
    await expect(next).toHaveClass(/\bui-button--secondary\b/);
    await expect(next).toHaveAttribute('href', questionPath(page.url().split('/projects/')[1].split('/')[0], 'Q-PP-04'));
    const words = next.locator('.decision-next__words');
    await expect(words).toContainText('Next: Have you assessed how the AI system might affect');
    const m = await words.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        overflow: s.overflow, textOverflow: s.textOverflow, textAlign: s.textAlign, display: s.display, whiteSpace: s.whiteSpace,
        clamp: s.getPropertyValue('line-clamp') || s.getPropertyValue('-webkit-line-clamp'), lineHeight: parseFloat(s.lineHeight), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      };
    });
    info.annotations.push({ type: `words ${width}`, description: JSON.stringify(m) });
    expect(m.overflow).toBe('hidden');
    expect(m.textOverflow).toBe('ellipsis');
    expect(m.textAlign).toBe('start');
    if (width >= 769) {
      expect(m.clamp).toBe('2');
      expect(m.clientHeight, `held to two lines of ${m.lineHeight}px`).toBeLessThanOrEqual(2 * m.lineHeight + 1);
      expect(m.scrollHeight, `cut at two lines: scrollHeight ${m.scrollHeight} over clientHeight ${m.clientHeight}`).toBeGreaterThan(m.clientHeight);
    } else {
      expect(m.whiteSpace).toBe('nowrap');
      expect(m.scrollWidth, `cut at one line: scrollWidth ${m.scrollWidth} over clientWidth ${m.clientWidth}`).toBeGreaterThan(m.clientWidth);
    }
    // The whole text stays the link's name.
    await expect(next).toHaveAccessibleName(/^Next: Have you assessed how the AI system might affect protected or vulnerable .+Question 4 of 24$/);

    // The button sits on the screen, inside the bar and beside Save, and nothing scrolls sideways.
    const geometry = await page.evaluate(() => {
      const r = (el: Element) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
      const barEl = document.querySelector('.decision-save-bar')!;
      const nextEl = barEl.querySelector('a.decision-next')!;
      const saveEl = [...barEl.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save decision')!;
      return {
        next: r(nextEl), bar: r(barEl), save: r(saveEl), viewport: window.innerWidth,
        pageScrollWidth: document.documentElement.scrollWidth, barScrollWidth: barEl.scrollWidth, barClientWidth: barEl.clientWidth,
        nextScrollWidth: nextEl.scrollWidth, nextClientWidth: nextEl.clientWidth,
      };
    });
    info.annotations.push({ type: `geometry ${width}`, description: JSON.stringify(geometry) });
    expect(geometry.next.left, 'Next starts on the screen').toBeGreaterThanOrEqual(0);
    expect(geometry.next.right, 'Next ends on the screen').toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.next.left, 'Next is inside the bar').toBeGreaterThanOrEqual(geometry.bar.left - 0.5);
    expect(geometry.next.right, 'Next is inside the bar').toBeLessThanOrEqual(geometry.bar.right + 0.5);
    expect(geometry.next.bottom, 'Next ends inside the bar').toBeLessThanOrEqual(geometry.bar.bottom + 0.5);
    expect(geometry.next.left >= geometry.save.right - 0.5 || geometry.next.top >= geometry.save.bottom - 0.5, 'Next does not sit over Save').toBe(true);
    expect(geometry.pageScrollWidth, 'the page does not scroll sideways').toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.barScrollWidth, 'the bar holds its content').toBeLessThanOrEqual(geometry.barClientWidth);
    expect(geometry.nextScrollWidth, 'the button holds its content').toBeLessThanOrEqual(geometry.nextClientWidth);
    await bar.screenshot({ path: info.outputPath(`next-button-${width}.png`) });
  });
}

test('the Next button still opens the following question in order (it does not follow the unanswered rule)', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', 'Q-PP-03', baseURL!);
  await page.locator('.decision-save-bar a.decision-next').click();
  await expect(page).toHaveURL(new RegExp(`${questionPath(projectId, 'Q-PP-04')}$`));
});
