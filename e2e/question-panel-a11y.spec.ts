import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { failOnDialog } from './helpers/dialogs';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { expectTargetsAtLeast24px } from './helpers/targetSize';
import {
  actAsSeat, fillValid, historyPath, newProject, openQuestion, questionPath, saveStatus, saveViaApi, stagePath, waitForQuestionPage,
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

test('UX-42 NFR-A11Y-02: keyboard-only Next moves focus to the new question heading', async ({ page, baseURL }) => {
  await openQuestion(page, 'assessor', Q, baseURL!);
  await page.getByRole('link', { name: 'Next question' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: /^Q-PP-02 \u00b7 / })).toBeFocused();
  await expectFocusVisibleAndUncovered(page);
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
  await tabTo(page, 'Decided by', (e) => e.tag === 'select' && e.label === 'Decided by (required)');
  await expectFocusVisibleAndUncovered(page);
  await tabTo(page, 'Today', (e) => e.tag === 'button' && e.name === 'Today');
  await expectFocusVisibleAndUncovered(page);
  await page.keyboard.press('Enter');
  await tabTo(page, 'Save decision', (e) => e.tag === 'button' && e.name === 'Save decision');
  await expectFocusVisibleAndUncovered(page);
  await page.keyboard.press('Enter');
  await expect(saveStatus(page)).toHaveText(/^Saved at .+ as version 1\./);
});

test('SPEC-2 W-3 NFR-A11Y-02 SC 2.4.11: at 320 px Save and its status sit in a bar fixed to the bottom, and no field reached by keyboard hides behind it', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 800 });
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
    ['Decided by', (e) => e.tag === 'select' && e.label === 'Decided by (required)'],
    ['Day', (e) => e.tag === 'input' && e.label === 'Day'],
    ['Today', (e) => e.tag === 'button' && e.name === 'Today'],
    ['Add a file', (e) => e.tag === 'button' && e.name === 'Add a file'],
    ['Save decision', (e) => e.tag === 'button' && e.name === 'Save decision'],
  ];
  for (const [what, match] of stops) {
    await tabTo(page, what, match);
    await expectFocusVisibleAndUncovered(page);
    if (what === 'the first status radio') await page.keyboard.press('Space');
    if (what === 'the reason') await page.keyboard.type('Compared a rule-based alert with the model, at 320 px.');
    if (what === 'Today') await page.keyboard.press('Enter');
  }
  await page.keyboard.press('Enter');
  await expect(saveStatus(page)).toHaveText(/^Saved at .+ as version 1\./);
  // At a wide width the bar is part of the page, not fixed (W-3 wide).
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).not.toBe('fixed');
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
    const el = document.querySelector(sel) as HTMLElement;
    const r = el.getBoundingClientRect();
    const bar = document.querySelector('.decision-save-bar') as HTMLElement;
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
  for (const sel of ['#withdraw-code', '.ui-confirm__actions button:first-child', '.ui-confirm__actions button:last-child']) {
    const place = await placeOf(page, sel);
    expect(place.inView, `${sel} ${JSON.stringify(place)}`).toBe(true);
    expect(place.underBar, `${sel} ${JSON.stringify(place)}`).toBe(false);
  }
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: WITHDRAW_COPY.trigger })).toBeFocused();
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  await page.getByRole('button', { name: WITHDRAW_COPY.trigger }).click();
  const field = await placeOf(page, '#withdraw-code');
  expect(field.inView && !field.underBar, JSON.stringify(field)).toBe(true);
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
  const retry = page.getByRole('button', { name: WITHDRAW_COPY.retry, exact: true }).last();
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
  await expect(saveStatus(page)).toHaveText(/^Saved at .+ as version 1\./);
  await expect(page.locator('.decision-save-bar')).toBeFocused();
});
