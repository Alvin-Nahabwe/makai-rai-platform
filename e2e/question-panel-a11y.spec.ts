import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { failOnDialog } from './helpers/dialogs';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { expectTargetsAtLeast24px } from './helpers/targetSize';
import {
  actAsSeat, expectMovedOn, fillValid, historyPath, newProject, openQuestion, openWhoWhen, questionPath, saveViaApi, stagePath, waitForQuestionPage,
} from './helpers/session';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { WITHDRAW_COPY } from '../lib/decision/copy';
import { DECISION_OUTCOME_COPY } from '../lib/decision/outcome/copy';
import { FIELD_COPY } from '../lib/ui/field/copy';

/**
 * Keyboard, accessibility and reflow of S-11 to S-13 (UX-42, NFR-A11Y-02, NFR-A11Y-04, NFR-A11Y-05). The themes follow
 * `prefers-color-scheme` while no choice is stored (app/layout.tsx's theme script sets `data-theme` only from storage),
 * so `emulateMedia` switches them. Q is a fixture id.
 */
const Q = 'Q-PP-01';
/** The text of Q-PP-02 in the fixture bundle the e2e server runs on. */
const Q2_TEXT = (JSON.parse(readFileSync('__tests__/fixtures/content/0.0.1-fixture/questionBank.json', 'utf8')) as {
  stages: Record<string, { modules: Array<{ questions: Array<{ id: string; text: string }> }> }>;
}).stages['pre-processing'].modules.flatMap((m) => m.questions).find((q) => q.id === 'Q-PP-02')!.text;

/** The words as a literal in a pattern. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.beforeEach(async ({ page }) => { failOnDialog(page); });

/** Presses Tab until the focused element satisfies `match`; fails after 80 presses. */
async function tabTo(page: Page, what: string, match: (el: { tag: string; type: string; name: string; label: string }) => boolean): Promise<void> {
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    const el = await page.evaluate(() => {
      const a = document.activeElement as HTMLInputElement | null;
      if (!a) return { tag: '', type: '', name: '', label: '' };
      const label = a.id ? document.querySelector(`label[for="${a.id}"]`)?.textContent ?? '' : '';
      return { tag: a.tagName.toLowerCase(), type: a.type ?? '', name: (a.textContent ?? '').trim(), label: label.trim() };
    });
    if (match(el)) return;
  }
  throw new Error(`no element "${what}" took focus within 80 Tab presses`);
}

/**
 * Scrolls the control's scrolling box (the document at 320 px, the main region at 1280) until the control's top is `top`
 * px from the screen's top, as a person who scrolled there would leave it, and takes focus off whatever has it.
 */
async function placeAt(control: Locator, top: number): Promise<void> {
  await control.evaluate((el, want) => {
    let box: Element | null = el.parentElement;
    while (box !== null && box !== document.body && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight + 1)) box = box.parentElement;
    const scroller = box === null || box === document.body ? document.scrollingElement! : box;
    const top0 = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
    scroller.scrollTo({ top: scroller.scrollTop + el.getBoundingClientRect().top - top0 - want, behavior: 'instant' });
    (document.activeElement as HTMLElement | null)?.blur();
  }, top);
}

test('UX-42 NFR-A11Y-02: keyboard-only Next moves focus to the new question heading', async ({ page, baseURL }) => {
  await openQuestion(page, 'assessor', Q, baseURL!);
  // The way on is the merged card's "Next: <question>" link in its Save row (lane 2's card, at the merge).
  await page.locator('.decision-save-bar').getByRole('link', { name: new RegExp(`^Next: ${escapeRe(Q2_TEXT)}`) }).focus();
  await page.keyboard.press('Enter');
  // The h1 is the question in words (plan 1C decision C1, cut); its code line "Q-PP-02 · {module}" follows it.
  const heading = page.getByRole('heading', { level: 1, name: Q2_TEXT, exact: true });
  await expect(heading).toBeFocused();
  await expect(page.locator('#question-heading + .question-frame__code')).toHaveText(/^Q-PP-02 \u00b7 /);
  await expectFocusVisibleAndUncovered(page);
});

/** The heading's outline as drawn now: a ring is a style other than none with a width of 2px or more. */
const ringOf = (page: Page) => page.locator('#question-heading').evaluate((h) => {
  const cs = getComputedStyle(h);
  return { focused: document.activeElement === h, ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 };
});

test('Shell gap 3: arriving at a question by loading it, or by a click, focuses the heading with no ring round it', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openQuestion(page, 'assessor', Q, baseURL!);
  await expect(page.locator('#question-heading')).toBeFocused();
  expect(await ringOf(page)).toEqual({ focused: true, ring: false });
  await page.screenshot({ path: 'test-results/route-T1/arrival-load-1280.png' });
  // A click on the way on: the next question's heading takes focus, still with no ring.
  await page.locator('.decision-save-bar').getByRole('link', { name: new RegExp(`^Next: ${escapeRe(Q2_TEXT)}`) }).click();
  await expect(page.getByRole('heading', { level: 1, name: Q2_TEXT, exact: true })).toBeFocused();
  expect(await ringOf(page)).toEqual({ focused: true, ring: false });
  await page.screenshot({ path: 'test-results/route-T1/arrival-click-1280.png' });
});

test('plan 1C Task 4: Tab, Enter on "Skip to content" lands focus on the question heading, with the ring drawn', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openQuestion(page, 'assessor', Q, baseURL!);
  // The heading holds focus after arrival, so the skip link (the page's first focusable element, which a first Tab
  // reaches) is focused directly, then pressed with the keyboard.
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await skip.focus();
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#question-heading')).toBeFocused();
  expect(await ringOf(page)).toEqual({ focused: true, ring: true });
  await expectFocusVisibleAndUncovered(page);
  await page.screenshot({ path: 'test-results/route-T1/arrival-skip-link-1280.png' });
});

test('NFR-A11Y-02: J-05 by keyboard alone: status, reason, decided by, Today, Save', async ({ page, baseURL }) => {
  await openQuestion(page, 'assessor', Q, baseURL!);
  await page.locator('#question-heading').focus();
  await tabTo(page, 'the first status radio', (e) => e.tag === 'input' && e.type === 'radio' && e.label === 'Done');
  await expectFocusVisibleAndUncovered(page);
  await page.keyboard.press('Space');
  await expect(page.getByRole('radio', { name: 'Done', exact: true })).toBeChecked();
  await tabTo(page, 'the reason', (e) => e.tag === 'textarea');
  await expectFocusVisibleAndUncovered(page);
  await page.keyboard.type('Compared a rule-based alert with the model, by keyboard.');
  // Who and when open as one line, "Decided by you, <date>", with a Change button (answer cost): Enter opens the two fields and focus moves into Decided by.
  await tabTo(page, 'Change', (e) => e.tag === 'button' && e.name === 'Change');
  await expectFocusVisibleAndUncovered(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#decision-decided-by')).toBeFocused();
  await expectFocusVisibleAndUncovered(page);
  // It opens as the signed-in person; typing keeps the choice on "You (...)".
  await page.keyboard.type('You');
  await expect(page.locator('#decision-decided-by option:checked')).toHaveText(/^You \(/);
  await tabTo(page, 'Today', (e) => e.tag === 'button' && e.name === 'Today');
  await expectFocusVisibleAndUncovered(page);
  await page.keyboard.press('Enter');
  await tabTo(page, 'Save decision', (e) => e.tag === 'button' && e.name === 'Save decision');
  await expectFocusVisibleAndUncovered(page);
  await page.keyboard.press('Enter');
  await expectMovedOn(page, Q);
});

for (const height of [800, 568]) test(`SPEC-2 W-3 NFR-A11Y-02 SC 2.4.11: at 320 px Save and its status sit in a bar fixed to the bottom, and no field reached by keyboard hides behind it${height === 800 ? '' : ' (320 by 568)'}`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 320, height });
  await openQuestion(page, 'assessor', Q, baseURL!);
  const bar = page.locator('.decision-save-bar');
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  await expect(bar.getByRole('button', { name: 'Save decision' })).toBeVisible();
  await expect(bar.locator('.save-status')).toHaveCount(1);
  await page.locator('#question-heading').focus();
  // Every stop of J-05, from the first status radio to Save, is visible and not covered by the bar.
  const stops: Array<[string, (e: { tag: string; type: string; name: string; label: string }) => boolean]> = [
    ['the first status radio', (e) => e.tag === 'input' && e.type === 'radio' && e.label === 'Done'],
    ['the reason', (e) => e.tag === 'textarea'],
    ['Change', (e) => e.tag === 'button' && e.name === 'Change'],
    ['Day', (e) => e.tag === 'input' && e.label === 'Day'],
    ['Today', (e) => e.tag === 'button' && e.name === 'Today'],
    ['Add a file', (e) => e.tag === 'button' && e.name === 'Add a file'],
    ['Save decision', (e) => e.tag === 'button' && e.name === 'Save decision'],
  ];
  for (const [what, match] of stops) {
    await tabTo(page, what, match);
    await expectFocusVisibleAndUncovered(page);
    // The first edit adds the unsaved line to the bar, which grows over the field that has focus: it must be scrolled clear.
    if (what === 'the first status radio') { await page.keyboard.press('Space'); await expectFocusVisibleAndUncovered(page); }
    if (what === 'the reason') await page.keyboard.type('Compared a rule-based alert with the model, at 320 px.');
    // Change opens Decided by and Decided on, and focus goes into Decided by, which is visible and clear of the bar too.
    if (what === 'Change') {
      await page.keyboard.press('Enter');
      await expect(page.locator('#decision-decided-by')).toBeFocused();
      await expectFocusVisibleAndUncovered(page);
      await page.keyboard.type('You');
    }
    if (what === 'Today') await page.keyboard.press('Enter');
  }
  await page.keyboard.press('Enter');
  await expectMovedOn(page, Q);
  // At a wide width the bar is part of the page, not fixed (W-3 wide).
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).not.toBe('fixed');
});

for (const height of [800, 568]) test(`SPEC-2 W-3 NFR-A11Y-02 SC 2.4.11: at 320 px a refused save shows its whole summary above the fixed bar, and each of its links lands with the field's label and error in view${height === 800 ? '' : ' (320 by 568, a status chosen first)'}`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 320, height });
  await openQuestion(page, 'assessor', Q, baseURL!);
  // A refusal with several things to fix: the status (or, once Not yet is chosen, its main reason), and Decided by and the year cleared
  // after Change (the form opens with who and when filled in). A status chosen first grows the bar with the unsaved line.
  await openWhoWhen(page);
  await page.getByLabel('Decided by (required)').selectOption('');
  await page.getByLabel('Year', { exact: true }).fill('');
  if (height !== 800) await page.getByRole('radio', { name: 'Not yet', exact: true }).check();
  await page.locator('.decision-save-bar').getByRole('button', { name: 'Save decision' }).focus();
  await page.keyboard.press('Enter');
  const summary = page.locator('[data-error-summary]');
  await expect(summary.locator('> p')).toBeFocused();
  /**
   * Whether the summary (no href) or the field a link names (the control itself, its group's legend or label, and its
   * error) lies wholly between the screen's top and the bar's top: "clear", or what is not.
   */
  const placed = (href?: string) => page.evaluate(async (id) => {
    // Read at rest: a link's jump scrolls smoothly, and a box passing through view on the way does not count.
    const y = window.scrollY;
    await new Promise((done) => setTimeout(done, 150));
    if (window.scrollY !== y) return 'still scrolling';
    const barTop = document.querySelector('.decision-save-bar')!.getBoundingClientRect().top;
    let boxes: Array<[string, Element | null]>;
    if (id === undefined) boxes = [['the summary', document.querySelector('[data-error-summary]')]];
    else {
      const group = document.getElementById(id.slice(1))?.closest('fieldset, .ui-field') ?? null;
      boxes = [['the control', document.getElementById(id.slice(1))], ['its label', group?.querySelector(':scope > legend, :scope > label') ?? null], ['its error', group?.querySelector('[id$="-error"]') ?? null]];
    }
    const bad = boxes.map(([what, e]) => {
      if (e === null) return `${what} missing`;
      const r = e.getBoundingClientRect();
      return r.top >= -0.5 && r.bottom <= barTop + 0.5 ? '' : `${what} at ${Math.round(r.top)}-${Math.round(r.bottom)}, bar at ${Math.round(barTop)}`;
    }).filter(Boolean);
    return bad.length === 0 ? 'clear' : bad.join('; ');
  }, href);
  // The whole summary with its list, not its first line alone, sits above the bar (the page scrolls smoothly: polled).
  await expect.poll(() => placed()).toBe('clear');
  const hrefs = await summary.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
  expect(hrefs.length).toBeGreaterThan(height === 800 ? 2 : 1);
  for (const href of hrefs) {
    await summary.locator(`a[href="${href}"]`).click();
    await expect(page.locator(href)).toBeFocused();
    // Not the box alone at the top edge with the field's name and error above the screen.
    await expect.poll(() => placed(href), { message: href }).toBe('clear');
    await summary.locator('> p').focus();
  }
});

for (const [width, height] of [[320, 568], [1280, 800]] as const) test(`NFR-A11Y-02 W-3: at ${width} by ${height} a press on a question's first choice near the top of the screen chooses it and does not move the page`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width, height });
  const projectId = await newProject(baseURL!);
  await actAsSeat(page, 'assessor');
  for (const [questionId, id] of [[Q, 'decision-status-done'], ['Q-PP-GATE-SENSITIVE', 'decision-scope-yes']] as const) {
    await page.goto(questionPath(projectId, questionId));
    await waitForQuestionPage(page);
    const choice = page.locator(`#${id}`);
    // 80 px from the top, where a person who scrolled the group into view finds it; nothing has focus.
    await placeAt(choice, 80);
    const topOf = () => choice.evaluate((el) => Math.round(el.getBoundingClientRect().top));
    const before = await topOf();
    expect(before, `${id} placed near the top`).toBeLessThan(120);
    const at = (await choice.boundingBox())!;
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
    await expect(choice, `${questionId}: the press chose ${id}`).toBeChecked();
    await page.waitForTimeout(300);
    expect(await topOf(), `${questionId}: the page did not move under the press`).toBe(before);
  }
});

for (const [width, height] of [[320, 568], [1280, 800]] as const) test(`NFR-A11Y-02 W-3: at ${width} by ${height}, after the summary's link to the status and a change of mind, a press on Done's words or on its circle at the top edge chooses it and does not move the page`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width, height });
  await openQuestion(page, 'assessor', Q, baseURL!);
  await page.locator('.decision-save-bar').getByRole('button', { name: 'Save decision' }).focus();
  await page.keyboard.press('Enter');
  // The room's likeliest path: a refused save, the link to the status, another choice, then back to Done.
  await page.locator('[data-error-summary] a[href="#decision-status-done"]').click();
  const done = page.locator('#decision-status-done');
  await expect(done).toBeFocused();
  const topOf = () => done.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  for (const [where, top] of [['its words', 104], ['its circle, clipped at the top edge', -8]] as const) {
    await page.getByRole('radio', { name: 'Not yet', exact: true }).check();
    await placeAt(done, top);
    const before = await topOf();
    const at = (await (top < 0 ? done : page.locator('label[for="decision-status-done"]')).boundingBox())!;
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
    await expect(done, `a press on ${where} chose Done`).toBeChecked();
    await page.waitForTimeout(300);
    // A control clipped at the top edge is brought wholly into view: by the clipped 8 px, no more.
    expect(Math.abs((await topOf()) - before), `a press on ${where} moved the page`).toBeLessThanOrEqual(top < 0 ? 8 : 0);
  }
});

test('NFR-A11Y-04 NFR-A11Y-05: targets of 24 px, no horizontal scroll at 320 px, and no serious axe violation in either theme at 1280 and 360', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const projectId = await newProject(baseURL!);
  expect((await saveViaApi(baseURL!, 'assessor', projectId, 'Q-PP-02', { reason: 'Version 1' })).status).toBe(201);
  expect((await saveViaApi(baseURL!, 'owner', projectId, 'Q-PP-02', { baseVersionNumber: 1, reason: 'Version 2' })).status).toBe(201);
  const reach = async (state: string): Promise<void> => {
    await actAsSeat(page, 'assessor');
    if (state === 'empty S-12') { await page.goto(questionPath(projectId, Q)); await waitForQuestionPage(page); return; }
    if (state === 'S-12 with version 2') { await page.goto(questionPath(projectId, 'Q-PP-02')); await waitForQuestionPage(page); return; }
    if (state === 'S-12 validation errors') {
      await page.goto(questionPath(projectId, Q)); await waitForQuestionPage(page);
      await page.getByRole('button', { name: 'Save decision' }).click();
      await expect(page.locator('[data-error-summary]')).toBeVisible();
      return;
    }
    if (state === 'S-12 conflict') {
      await page.goto(questionPath(projectId, 'Q-PP-03')); await waitForQuestionPage(page);
      await fillValid(page, { reason: 'Mine' });
      await page.route('**/decisions', (r) => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
        error: 'x', code: 'base_version_moved', current: {
          id: 'dv', projectId, stage: 'pre-processing', questionId: 'Q-PP-03', versionNumber: 1, baseVersionNumber: null,
          content: { contentVersionId: 'c', semver: '0.0.1-fixture', contentHash: 'h' }, status: 'done', scopeAnswer: null, optionsInPlace: [],
          reasonCode: null, reason: 'Theirs', reasonErased: null, decidedBy: { kind: 'outside_role', role: 'supervisor' }, declaredDate: '2026-10',
          declaredPrecision: 'month', withdrawalCode: null, enteredBy: { userId: 'other', name: 'Joseph K.', formerMember: false }, enteredByRole: 'owner',
          receivedAt: new Date().toISOString(), evidence: [],
        } }) }), { times: 1 });
      await page.getByRole('button', { name: 'Save decision' }).click();
      await expect(page.getByRole('heading', { name: DECISION_FORM_COPY.conflict.heading })).toBeVisible();
      return;
    }
    if (state === 'S-11') { await page.goto(stagePath(projectId, 'pre-processing')); await page.waitForSelector('[data-question-id]'); return; }
    await page.goto(historyPath(projectId, 'Q-PP-02'));
    await expect(page.getByRole('heading', { level: 1, name: 'History of Q-PP-02' })).toBeVisible();
  };
  for (const width of [1280, 360]) for (const colorScheme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme });
    for (const state of ['empty S-12', 'S-12 with version 2', 'S-12 conflict', 'S-12 validation errors', 'S-11', 'S-13']) {
      await reach(state);
      // The pointer is left where the last click was, and .btn animates `transition: all` (app/globals.css:335): a
      // button under it would be read mid-transition. Contrast is checked at rest.
      await page.mouse.move(0, 0); await page.waitForTimeout(400);
      await expectNoSeriousA11yViolations(page, `${state} ${width} ${colorScheme}`);
      // At 768 px and below S-12's save bar is fixed to the bottom (W-3) and covers whatever scrolls under it; the
      // target script does not model that, and reads a covered radio as crowding Save. At the page end the bar covers
      // only the space reserved for it, so every target is measured where it can be reached. Focus is never left under
      // the bar: the SPEC-2 keyboard case checks each stop.
      if (width <= 768) await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
      await expectTargetsAtLeast24px(page);
    }
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await reach('S-12 with version 2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= 320)).toBe(true);
});

/** S-12 with version 1 saved, More open and the withdrawal confirmation open, its first field focused. */
async function openWithdrawal(page: Page, baseURL: string): Promise<{ projectId: string }> {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL);
  expect((await saveViaApi(baseURL, 'assessor', projectId, Q, { reason: 'Version 1' })).status).toBe(201);
  await page.reload(); await waitForQuestionPage(page);
  await page.locator('details.more-menu > summary').click();
  await page.getByRole('button', { name: WITHDRAW_COPY.trigger }).click();
  await expect(page.getByLabel(`${WITHDRAW_COPY.codeLabel} ${FIELD_COPY.required}`)).toBeFocused();
  return { projectId };
}

/** The box of an element in the viewport, and whether the fixed save bar overlaps it. */
async function placeOf(page: Page, selector: string): Promise<{ top: number; bottom: number; inView: boolean; underBar: boolean }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const bar = document.querySelector('.decision-save-bar');
    if (el === null || bar === null) throw new Error(`placeOf: ${el === null ? sel : '.decision-save-bar'} is not on the page`);
    const r = el.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    const fixed = getComputedStyle(bar).position === 'fixed';
    return { top: r.top, bottom: r.bottom, inView: r.top >= 0 && r.bottom <= window.innerHeight, underBar: fixed && r.bottom > b.top && r.top < b.bottom };
  }, selector);
}

test('D-398 item 1: at 320 by 568 the open withdrawal confirmation, its focused field and its two buttons, can be wholly seen above the save bar; after Cancel the bar is fixed again', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openWithdrawal(page, baseURL!);
  const bar = page.locator('.decision-save-bar');
  // As the confirmation opens, with no scroll of the test's own: all three at once, in the viewport, none under the bar.
  for (const sel of ['#withdraw-code', '#withdraw-reason', '.ui-confirm__actions button:first-child', '.ui-confirm__actions button:last-child']) {
    const place = await placeOf(page, sel);
    expect(place.inView, `${sel} ${JSON.stringify(place)}`).toBe(true);
    expect(place.underBar, `${sel} ${JSON.stringify(place)}`).toBe(false);
  }
  // The confirmation's own box (552 px of a 568 px window, measured 14 Nov 2026): wholly in view to within a sub-pixel of
  // layout rounding (its bottom measured 568.125), and nowhere under the bar.
  const box = await placeOf(page, '.withdraw-decision .ui-confirm');
  expect(box.top >= 0 && box.bottom <= 568 + 0.5, JSON.stringify(box)).toBe(true);
  expect(box.underBar, JSON.stringify(box)).toBe(false);
  await page.getByRole('button', { name: 'Cancel' }).press('Enter');   // by keyboard, so the trigger shows its focus ring
  await expect(page.getByRole('button', { name: WITHDRAW_COPY.trigger })).toBeFocused();
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  // WithdrawDecision brings the trigger into view on the frame after it takes focus (its requestAnimationFrame): since the
  // guidance follows the form (slice 1), the page no longer shrinks to the trigger when the confirmation closes, so the
  // check waits for that frame, and one more, before it looks.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expectFocusVisibleAndUncovered(page);   // SC 2.4.11: the trigger that took focus back is not under the bar fixed again
  await page.getByRole('button', { name: WITHDRAW_COPY.trigger }).click();
  const field = await placeOf(page, '#withdraw-code');
  expect(field.inView && !field.underBar, JSON.stringify(field)).toBe(true);
});

test('D-398 item 1 (C2): at 320 by 568, More closed by its summary with the confirmation still open fixes the save bar again, its status line in view', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openWithdrawal(page, baseURL!);
  const bar = page.locator('.decision-save-bar');
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('static');
  await page.locator('details.more-menu > summary').click();   // close More, not the confirmation
  await expect(page.locator('details.more-menu')).not.toHaveAttribute('open', /.*/);
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  const status = await page.locator('.decision-save-bar .save-status').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, inView: r.top >= 0 && r.bottom <= window.innerHeight };
  });
  expect(status.inView, JSON.stringify(status)).toBe(true);
});

test('D-398 item 4 (C1): a withdrawal that fails while the person is typing in the decision form leaves focus where they are', async ({ page, baseURL }) => {
  await openWithdrawal(page, baseURL!);
  await page.getByLabel(`${WITHDRAW_COPY.codeLabel} ${FIELD_COPY.required}`).selectOption('duplicate');
  await page.getByLabel(`${WITHDRAW_COPY.reasonLabel} ${FIELD_COPY.required}`).fill('Entered twice.');
  let fail: () => void = () => {};
  await page.route(/\/withdrawal$/, async (route) => {
    await new Promise<void>((r) => { fail = r; });
    await route.abort('failed');
  });
  await page.getByRole('button', { name: WITHDRAW_COPY.action }).click();
  await expect(page.locator('[data-withdraw-status]')).toHaveText(DECISION_OUTCOME_COPY.withdraw.withdrawing);
  const reason = page.locator('#decision-reason');
  await reason.focus();
  fail();
  await expect(page.locator('[data-withdraw-alert]')).toHaveText(DECISION_OUTCOME_COPY.withdraw.maybeArrived);
  await page.waitForTimeout(300);   // the effect that moves focus runs after the render that shows the line
  await expect(reason).toBeFocused();
});

test('D-398 item 4: after a failed withdrawal focus is on Retry; a pressed Retry keeps focus, busy, while its request is held; after success focus is not on the page body', async ({ page, baseURL }) => {
  await openWithdrawal(page, baseURL!);
  await page.getByLabel(`${WITHDRAW_COPY.codeLabel} ${FIELD_COPY.required}`).selectOption('duplicate');
  await page.getByLabel(`${WITHDRAW_COPY.reasonLabel} ${FIELD_COPY.required}`).fill('Entered twice.');
  let mode: 'fail' | 'hold' = 'fail';
  let release: () => void = () => {};
  await page.route(/\/withdrawal$/, async (route) => {
    if (mode === 'fail') { await route.abort('failed'); return; }
    await new Promise<void>((r) => { release = r; });
    await route.continue();
  });
  await page.getByRole('button', { name: WITHDRAW_COPY.action }).click();
  await expect(page.locator('[data-withdraw-alert]')).toHaveText(DECISION_OUTCOME_COPY.withdraw.maybeArrived);
  const retry = page.locator('.withdraw-decision').getByRole('button', { name: WITHDRAW_COPY.retry, exact: true });
  await expect(retry).toBeFocused();
  mode = 'hold';
  await page.keyboard.press('Enter');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).toBeFocused();
  release();
  await expect(page.locator('[data-withdraw-status]')).toHaveText(DECISION_OUTCOME_COPY.withdraw.withdrawn);
  expect(await page.evaluate(() => document.activeElement === document.body || document.activeElement === null)).toBe(false);
});

test('D-398 item 4 (save bar): a pressed Retry keeps focus, busy, while its save is held; after the save focus is on the save bar, not the page body', async ({ page, baseURL }) => {
  await openQuestion(page, 'assessor', Q, baseURL!);
  await fillValid(page);
  let mode: 'fail' | 'hold' = 'fail';
  let release: () => void = () => {};
  await page.route(/\/decisions$/, async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    if (mode === 'fail') { await route.abort('failed'); return; }
    await new Promise<void>((r) => { release = r; });
    await route.continue();
  });
  await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
  await expect(page.locator('[data-region="answer-form"] .save-status [role="alert"]')).toHaveText(DECISION_OUTCOME_COPY.save.connection);
  const retry = page.locator('.decision-save-bar').getByRole('button', { name: DECISION_FORM_COPY.retry, exact: true });
  await retry.focus();
  mode = 'hold';
  await page.keyboard.press('Enter');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).toBeFocused();
  release();
  // The save moves on (answer cost): the page that arrives puts focus on its saved line, never on the body.
  await expectMovedOn(page, Q);
  await expect(page.locator('[data-saved-arrival]')).toBeFocused();
});

test('D-398 item 4 (save bar, task 6): a send that removes a focused Retry the person did not press (the automatic retry when the browser is online again) leaves focus on the save bar, not the page body', async ({ page, baseURL }) => {
  await openQuestion(page, 'assessor', Q, baseURL!);
  await fillValid(page);
  let mode: 'fail' | 'pass' = 'fail';
  await page.route(/\/decisions$/, async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    if (mode === 'fail') { await route.abort('failed'); return; }
    await route.continue();
  });
  await page.getByRole('button', { name: DECISION_FORM_COPY.save }).click();
  await expect(page.locator('[data-region="answer-form"] .save-status [role="alert"]')).toHaveText(DECISION_OUTCOME_COPY.save.connection);
  const retry = page.locator('.decision-save-bar').getByRole('button', { name: DECISION_FORM_COPY.retry, exact: true });
  await retry.focus();
  mode = 'pass';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  // The save moves on (answer cost): the page that arrives puts focus on its saved line, never on the body.
  await expectMovedOn(page, Q);
  await expect(page.locator('[data-saved-arrival]')).toBeFocused();
});

test('D-398 item 4 (React M2, M10): at 320 by 568 a successful withdrawal leaves focus on its result line, visible and not under the save bar', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openWithdrawal(page, baseURL!);
  await page.getByLabel(`${WITHDRAW_COPY.codeLabel} ${FIELD_COPY.required}`).selectOption('duplicate');
  await page.getByLabel(`${WITHDRAW_COPY.reasonLabel} ${FIELD_COPY.required}`).fill('Entered twice.');
  await page.getByRole('button', { name: WITHDRAW_COPY.action }).click();
  await expect(page.locator('[data-withdraw-status]')).toHaveText(DECISION_OUTCOME_COPY.withdraw.withdrawn);
  await expect(page.locator('[data-withdraw-status]')).toBeFocused();
  // the refresh that follows brings the withdrawn version: the control is gone and the line, focused again, is all that is
  // left (between the reply and the refresh the line can sit a few pixels above the viewport; measured 14 Nov 2026)
  await expect(page.locator('details.more-menu')).toHaveCount(0);
  await expect(page.locator('[data-withdraw-status]')).toBeFocused();
  await expectFocusVisibleAndUncovered(page);
});

test('D-398 item 4 (React M10): a withdrawal refused for good (403, the role) shows its line, offers no Retry, and puts focus on the control', async ({ page, baseURL }) => {
  await openWithdrawal(page, baseURL!);
  await page.getByLabel(`${WITHDRAW_COPY.codeLabel} ${FIELD_COPY.required}`).selectOption('duplicate');
  await page.getByLabel(`${WITHDRAW_COPY.reasonLabel} ${FIELD_COPY.required}`).fill('Entered twice.');
  await page.route(/\/withdrawal$/, (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Forbidden', code: 'forbidden' }) }));
  await page.getByRole('button', { name: WITHDRAW_COPY.action }).click();
  await expect(page.locator('[data-withdraw-alert]')).toHaveText(DECISION_OUTCOME_COPY.withdraw.forbidden);
  await expect(page.locator('.withdraw-decision').getByRole('button', { name: WITHDRAW_COPY.retry, exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.closest('.withdraw-decision') != null)).toBe(true);
});

test('C5 (Q18 (b)): a withdrawal refused because new terms must be accepted says so and links where the save path links', async ({ page, baseURL }) => {
  await openWithdrawal(page, baseURL!);
  await page.getByLabel(`${WITHDRAW_COPY.codeLabel} ${FIELD_COPY.required}`).selectOption('duplicate');
  await page.getByLabel(`${WITHDRAW_COPY.reasonLabel} ${FIELD_COPY.required}`).fill('Entered twice.');
  await page.route(/\/withdrawal$/, (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Forbidden', code: 'acceptances_required' }) }));
  await page.getByRole('button', { name: WITHDRAW_COPY.action }).click();
  await expect(page.locator('[data-withdraw-alert]')).toHaveText(DECISION_OUTCOME_COPY.withdraw.terms);
  const link = page.locator('.withdraw-decision').getByRole('link', { name: DECISION_OUTCOME_COPY.gate.termsLink });
  await expect(link).toHaveAttribute('href', `/acceptances?callbackUrl=${encodeURIComponent(new URL(page.url()).pathname)}`);
});

