import { appendFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { failOnDialog } from './helpers/dialogs';
import { actAsSeat, fillValid, openQuestion, openQuestionIn, saveStatus, saveViaApi, waitForQuestionPage } from './helpers/session';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { WITHDRAW_COPY } from '../lib/decision/copy';
import { EVIDENCE_COPY } from '../lib/evidence/copy';
import { FIELD_COPY } from '../lib/ui/field/copy';

/**
 * The decision card's Save row on wide screens (the owner's Option A, ruled 15 Nov 2026 11:45) and the save control's
 * states that a browser shows (T3b): above 768 px the row (Save, the way on, the save status) pins to the screen's foot
 * while its place in the card is below the fold, and returns to its place at the card's end; nothing that takes focus is
 * ever under it (SC 2.4.11); there is one Save in the accessibility tree. While a Save waits for an upload or is out, the
 * way on is text, not a link (review B-I1); an uploading file shows a native progress element and "Save without" (C5);
 * after a lost save the one control reads Retry, and after an edit "Save decision" again (C4).
 */
const Q = 'Q-PP-01';
const F = DECISION_FORM_COPY;

test.beforeEach(async ({ page }) => { failOnDialog(page); });

/** Waits until a saved draft in this browser's storage holds `needle` (the draft write is debounced). */
async function draftHolds(page: Page, needle: string): Promise<void> {
  await page.waitForFunction(
    ([prefix, n]) => Object.keys(localStorage).some((k) => k.startsWith(prefix) && (localStorage.getItem(k) ?? '').includes(n)),
    ['makrai.draft.v1:', needle] as const, { timeout: 10_000 });
}

/** Whether the save row is pinned to the screen's foot now, by geometry, and its top. */
async function bar(page: Page): Promise<{ pinned: boolean; top: number; position: string }> {
  return page.locator('.decision-save-bar').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const foot = document.documentElement.clientHeight;
    return { pinned: r.top < foot && r.bottom >= foot - 1, top: r.top, position: getComputedStyle(el).position };
  });
}

/** The focused element's box, and the save row's, read together. */
async function focusPlace(page: Page): Promise<{ what: string; bottom: number; top: number; barTop: number; pinned: boolean; inBar: boolean; inForm: boolean }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const b = document.querySelector('.decision-save-bar')!;
    const r = el.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const foot = document.documentElement.clientHeight;
    return {
      what: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} ${(el.textContent ?? '').trim().slice(0, 30)}`,
      bottom: r.bottom, top: r.top, barTop: br.top, pinned: br.top < foot && br.bottom >= foot - 1,
      inBar: b.contains(el), inForm: el.closest('[data-region="answer-form"]') !== null,
    };
  });
}

/** Asserts the focused element is wholly on the screen and, while the row is pinned, wholly above it. True when pinned. */
async function expectFocusClear(page: Page): Promise<boolean> {
  // A focus scroll is instant in the form (its onFocus handler), but the browser may still settle one frame.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const p = await focusPlace(page);
  expect(p.top, `${p.what}: top in view`).toBeGreaterThanOrEqual(-0.5);
  if (p.pinned && !p.inBar) expect(p.bottom, `${p.what}: above the pinned row (bar top ${p.barTop})`).toBeLessThanOrEqual(p.barTop + 0.5);
  else expect(p.bottom, `${p.what}: bottom in view`).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientHeight) + 0.5);
  return p.pinned && !p.inBar;
}

test('Option A: at 1280 by 800 the Save row pins to the screen\'s foot while its place is below, returns to it at the card\'s end, and there is one Save', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await actAsSeat(page, 'admin'); await openQuestionIn(page, Q);
  const first = await bar(page);
  expect(first.position).toBe('sticky');
  expect(first.pinned).toBe(true);
  const save = page.locator('.decision-save-bar').getByRole('button', { name: F.save, exact: true });
  const box = (await save.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(800);
  // One Save in the accessibility tree, and one submit control.
  await expect(page.getByRole('button', { name: F.save, exact: true })).toHaveCount(1);
  await expect(page.locator('[data-region="answer-form"] [type="submit"]')).toHaveCount(1);
  // No animated pin or unpin under reduced motion.
  expect(await page.locator('.decision-save-bar, .decision-save-bar *').evaluateAll((els) => els.filter((e) => parseFloat(getComputedStyle(e).transitionDuration) > 0.001).length)).toBe(0);
  // At the card's end the row is in its own place, under the consequence line.
  await page.locator('section.decision-card').evaluate((el) => el.scrollIntoView({ block: 'end', behavior: 'instant' }));
  const end = await bar(page);
  expect(end.pinned).toBe(false);
  const consequence = (await page.locator('.decision-consequence').boundingBox())!;
  expect(end.top).toBeGreaterThanOrEqual(consequence.y + consequence.height - 0.5);
});

test('Option A SC 2.4.11: at 1280 by 800 every control from the status choices to the evidence controls, reached by Tab, is above the pinned row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await actAsSeat(page, 'admin'); await openQuestionIn(page, Q);
  await page.getByRole('radio', { name: 'Done', exact: true }).focus();
  let pinnedChecks = 0;
  const seen: string[] = [];
  for (let i = 0; i < 60; i++) {
    const p = await focusPlace(page);
    if (p.inBar) break;
    expect(p.inForm, `${p.what} is in the answer form`).toBe(true);
    if (await expectFocusClear(page)) pinnedChecks++;
    seen.push(p.what);
    // The first status choice makes the first edit (the unsaved line grows the row); the link toggle opens the link form.
    if (i === 0) await page.keyboard.press('Space');
    if (p.what.startsWith('button') && p.what.includes(EVIDENCE_COPY.addLinkToggle)) {
      await page.keyboard.press('Enter');
      if (await expectFocusClear(page)) pinnedChecks++;
    }
    if (p.what.startsWith('summary')) { await page.keyboard.press('Enter'); if (await expectFocusClear(page)) pinnedChecks++; }
    await page.keyboard.press('Tab');
  }
  // The path went through every kind the brief names, and the row was pinned for most of it.
  for (const want of ['textarea#decision-reason', 'select#decision-decided-by', EVIDENCE_COPY.addFile, EVIDENCE_COPY.addLinkToggle, '-link-url', '-link-label', EVIDENCE_COPY.addLink, EVIDENCE_COPY.acceptedFiles]) {
    expect(seen.some((s) => s.includes(want)), `focus reached ${want} (seen: ${seen.join(' | ')})`).toBe(true);
  }
  expect(pinnedChecks).toBeGreaterThanOrEqual(5);
});

for (const [w, h] of [[1280, 800], [1440, 900]] as const) {
  test(`N1 SC 2.4.11: at ${w} by ${h}, while an edit is unsaved the pinned row stays one line taller at most, the focused Reason and every control after it by Tab are above it, and the whole unsaved sentence is still read`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await actAsSeat(page, 'admin'); await openQuestionIn(page, Q);
    const row = page.locator('.decision-save-bar');
    const before = await row.evaluate((el) => el.getBoundingClientRect().height);
    const reason = page.getByLabel(`${F.fields.reason} ${FIELD_COPY.required}`, { exact: true });
    await reason.focus();
    await page.keyboard.type('Typed and not saved');
    // C7: the live span holds the whole sentence (its accessible text), and the unsaved line is showing.
    await expect(page.locator('.save-status [aria-live="polite"]')).toHaveText(F.unsaved);
    await expect(reason).toBeFocused();
    expect((await bar(page)).pinned, 'the row is pinned while the person types').toBe(true);
    const grown = await row.evaluate((el) => el.getBoundingClientRect().height);
    // While pinned the row shows the line's first sentence only: one line more than before, not three (design N1).
    expect(grown, `pinned row ${before} px before the edit, ${grown} px with the unsaved line`).toBeLessThanOrEqual(before + 32);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const place = await reason.evaluate((el) => ({ bottom: el.getBoundingClientRect().bottom, barTop: document.querySelector('.decision-save-bar')!.getBoundingClientRect().top }));
    expect(place.bottom, `Reason's foot ${place.bottom}, row's top ${place.barTop}`).toBeLessThanOrEqual(place.barTop + 0.5);
    // Tab through the remaining fields and the evidence controls with the unsaved line showing.
    let pinnedChecks = 0;
    const seen: string[] = [];
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      const p = await focusPlace(page);
      if (p.inBar || !p.inForm) break;
      if (await expectFocusClear(page)) pinnedChecks++;
      seen.push(p.what);
      if (p.what.startsWith('button') && p.what.includes(EVIDENCE_COPY.addLinkToggle)) {
        await page.keyboard.press('Enter');
        if (await expectFocusClear(page)) pinnedChecks++;
      }
      if (p.what.startsWith('summary')) { await page.keyboard.press('Enter'); if (await expectFocusClear(page)) pinnedChecks++; }
    }
    for (const want of ['select#decision-decided-by', EVIDENCE_COPY.addFile, EVIDENCE_COPY.addLinkToggle, '-link-url', EVIDENCE_COPY.addLink]) {
      expect(seen.some((s) => s.includes(want)), `focus reached ${want} (seen: ${seen.join(' | ')})`).toBe(true);
    }
    expect(pinnedChecks).toBeGreaterThanOrEqual(3);
    await expect(page.locator('.save-status [aria-live="polite"]')).toHaveText(F.unsaved);
    // Back in its place at the card's end, the whole sentence shows.
    await page.locator('section.decision-card').evaluate((el) => el.scrollIntoView({ block: 'end', behavior: 'instant' }));
    expect((await bar(page)).pinned).toBe(false);
    // Each of its parts is drawn (not only in a one-pixel box for a screen reader) and wholly on the screen.
    const first = F.unsaved.slice(0, F.unsaved.indexOf('.') + 1);
    for (const part of [first, F.unsaved.slice(first.length + 1)]) {
      const drawn = await page.locator('section.decision-card').evaluate((card, text) => [...card.querySelectorAll('*')].some((el) => {
        if (el.children.length > 0 || !(el.textContent ?? '').includes(text)) return false;
        const r = el.getBoundingClientRect();
        return r.height > 10 && r.width > 50 && r.top >= 0 && r.bottom <= document.documentElement.clientHeight;
      }), part);
      expect(drawn, `"${part}" is drawn in the card`).toBe(true);
    }
  });
}

test('Option A SC 2.4.11: at 1280 by 800 each error summary link lands its field above the pinned row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await actAsSeat(page, 'admin'); await openQuestionIn(page, Q);
  await page.locator('.decision-save-bar').getByRole('button', { name: F.save, exact: true }).click();
  const links = page.locator('[data-error-summary] a');
  await expect(links.first()).toBeVisible();
  const n = await links.count();
  expect(n).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < n; i++) {
    await links.nth(i).evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await links.nth(i).click();
    await expectFocusClear(page);
  }
});

test('Option A, register D-398 item 1 at the wide width: an open withdrawal confirmation is never under the Save row', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await actAsSeat(page, 'admin');
  const projectId = await openQuestionIn(page, Q);
  expect((await saveViaApi(baseURL!, 'admin', projectId, Q, { reason: 'Version 1' })).status).toBe(201);
  await page.reload(); await waitForQuestionPage(page);
  await page.locator('details.more-menu > summary').click();
  await page.getByRole('button', { name: WITHDRAW_COPY.trigger }).click();
  await expect(page.getByLabel(`${WITHDRAW_COPY.codeLabel} ${FIELD_COPY.required}`)).toBeFocused();
  for (let i = 0; i < 4; i++) {
    const p = await focusPlace(page);
    expect(p.top).toBeGreaterThanOrEqual(-0.5);
    expect(p.bottom).toBeLessThanOrEqual(800.5);
    if (p.pinned) expect(p.bottom).toBeLessThanOrEqual(p.barTop + 0.5);
    await page.keyboard.press('Tab');
  }
});

for (const [w, h] of [[1280, 800], [1440, 900], [1160, 800]] as const) {
  for (const which of ['Q-PP-01 first decision', 'Q-PP-03 v2 Partly'] as const) {
    test(`Option A first view: at ${w} by ${h} Save's whole box is in the viewport on load, no scroll (${which})`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width: w, height: h });
      const question = which.startsWith('Q-PP-01') ? 'Q-PP-01' : 'Q-PP-03';
      // The admin seat makes the project (openQuestionIn), not the owner, whose project creations the other specs share.
      await actAsSeat(page, 'admin');
      const projectId = await openQuestionIn(page, question);
      if (question === 'Q-PP-03') {
        expect((await saveViaApi(baseURL!, 'admin', projectId, question, { status: 'partly', reason: 'Version 1' })).status).toBe(201);
        expect((await saveViaApi(baseURL!, 'admin', projectId, question, { status: 'partly', reason: 'Version 2', baseVersionNumber: 1 })).status).toBe(201);
        await page.reload(); await waitForQuestionPage(page);
      }
      const save = page.locator('.decision-save-bar').getByRole('button', { name: F.save, exact: true });
      const box = (await save.boundingBox())!;
      const natural = await page.locator('.decision-save-bar').evaluate((el) => {
        // Where the row's own place in the card is: its top as if it were not pinned (the sticky offset taken back).
        const s = el.style.position; el.style.position = 'static';
        const r = el.getBoundingClientRect(); el.style.position = s; return r.top;
      });
      const line = `${w}x${h} ${which}: Save top ${Math.round(box.y)} bottom ${Math.round(box.y + box.height)}; row's own place top ${Math.round(natural)}`;
      test.info().annotations.push({ type: 'first-view', description: line });
      // The numbers for the report: a line each in the run's output folder (git-ignored).
      appendFileSync(test.info().outputPath('first-view.txt'), `${line}\n`);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(h);
    });
  }
}

test('B-I1 C5: while a Save waits for an upload the way on is text, not a link; the upload shows its progress and one "Save without"; after it, the save goes and the link returns', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await actAsSeat(page, 'admin'); await openQuestionIn(page, Q); await fillValid(page);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/evidence', async (route) => {
    if (route.request().method() === 'POST') await held;
    await route.continue();
  });
  const next = page.locator('.decision-save-bar .decision-next');
  await expect(next).toHaveAttribute('href', /questions\//);
  await page.locator('input[type="file"]').setInputFiles({ name: 'costing-sheet.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nheld upload\n') });
  // C5: a native progress element inside [data-upload-progress], named for the file, and one "Save without" beside it.
  await expect(page.locator('[data-upload-progress] > progress')).toHaveAttribute('aria-label', 'Uploading costing-sheet.pdf');
  await expect(page.getByRole('button', { name: F.saveWithout(1) })).toHaveCount(1);
  await page.locator('.decision-save-bar').getByRole('button', { name: F.save, exact: true }).click();
  await expect(page.locator('[data-upload-wait]')).toContainText('Waiting for costing-sheet.pdf to finish uploading.');
  // While the Save waits: the same words, no link, and still one "Save without" (the wait card's).
  await expect(next).toContainText(F.card.next(''));
  expect(await next.evaluate((el) => el.tagName.toLowerCase())).not.toBe('a');
  await expect(page.locator('.decision-save-bar a[href*="/questions/"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: F.saveWithout(1) })).toHaveCount(1);
  release();
  await expect(saveStatus(page)).toHaveText(/^Saved at .+ as version 1\./, { timeout: 20_000 });
  await expect(page.locator('.decision-save-bar a.decision-next')).toHaveAttribute('href', /questions\//);
});

test('C4: after a lost save the one control reads Retry; an edit turns it back to Save decision; never two', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await actAsSeat(page, 'admin'); await openQuestionIn(page, Q); await fillValid(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: F.save, exact: true }).click();
  const submit = page.locator('[data-region="answer-form"] [type="submit"]');
  await expect(submit).toHaveText(F.retry);
  await expect(submit).toHaveCount(1);
  await expect(page.getByRole('button', { name: F.save, exact: true })).toHaveCount(0);
  await page.getByLabel(`${F.fields.reason} ${FIELD_COPY.required}`, { exact: true }).fill('Edited while offline');
  await expect(submit).toHaveText(F.save);
  await expect(page.getByRole('button', { name: F.retry, exact: true })).toHaveCount(0);
  await context.setOffline(false);
});

/**
 * Lane 8 I2 round 2: the offline notice is a box above the shell. From 1024 px the frame is the window's height and the
 * one scroller, so the notice must sit inside it (one of the frame's rows before the shell), or the window scrolls by
 * the notice's height and the pinned row ends below the screen.
 */
for (const [w, h] of [[1280, 720], [1280, 800]] as const) {
  test(`I2: at ${w} by ${h} with the offline notice showing, the window does not scroll and the pinned Save row ends on the screen`, async ({ page, context }) => {
    await page.setViewportSize({ width: w, height: h });
    await actAsSeat(page, 'admin'); await openQuestionIn(page, Q);
    await context.setOffline(true);
    await expect(page.locator('.offline-banner-region .ui-banner')).toBeVisible();
    const place = await page.evaluate(() => ({
      document: document.documentElement.scrollHeight,
      window: window.innerHeight,
      row: document.querySelector('.decision-save-bar')!.getBoundingClientRect().bottom,
    }));
    expect(place.document, `the document is ${place.document}px for a ${place.window}px window`).toBeLessThanOrEqual(place.window);
    expect(place.row, `the pinned row ends at ${place.row} in a ${place.window}px window`).toBeLessThanOrEqual(place.window);
    expect((await bar(page)).pinned, 'the row is still pinned to the screen\'s foot').toBe(true);
    await context.setOffline(false);
  });
}

/**
 * Reviews A M-1 and B M-r4-3 (T3c items 2 and 3): when a way off the page that has focus becomes text because a Save goes
 * out (here the automatic retry when the browser is back online, NFR-REL-05, which no press of Save starts), focus goes to
 * the save bar, never to the page body; and the card's foot links are text while that Save is out. The admin seat makes
 * its own projects (openQuestionIn), so these cases do not spend the owner's project creations the other specs share.
 */
async function lostSaveThenHeldRetry(page: Page, context: import('@playwright/test').BrowserContext): Promise<() => void> {
  await context.setOffline(true);
  await page.getByRole('button', { name: F.save, exact: true }).click();
  await expect(page.locator('[data-region="answer-form"] [type="submit"]')).toHaveText(F.retry);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/decisions', async (route) => { await held; await route.continue(); });
  return release;
}

test('M-1: Next has focus when the automatic retry goes out; it becomes text and the save bar takes focus', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await actAsSeat(page, 'admin'); await openQuestionIn(page, Q); await fillValid(page);
  const release = await lostSaveThenHeldRetry(page, context);
  const next = page.locator('.decision-save-bar a.decision-next');
  await next.focus();
  await expect(next).toBeFocused();
  const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/decisions'));
  await context.setOffline(false);
  await sent;
  await expect(page.locator('.decision-save-bar [data-next-held]')).toBeVisible();
  await expect(page.locator('.decision-save-bar')).toBeFocused();
  release();
  await expect(saveStatus(page)).toHaveText(/as version 1\./, { timeout: 20_000 });
});

test('M-r4-3: the foot\'s History link has focus when the automatic retry goes out; the foot\'s links are text and the save bar takes focus', async ({ page, baseURL, context }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await actAsSeat(page, 'admin');
  const projectId = await openQuestionIn(page, Q);
  expect((await saveViaApi(baseURL!, 'admin', projectId, Q, { reason: 'Version 1' })).status).toBe(201);
  await openQuestion(page, 'admin', Q, baseURL!, projectId);
  await fillValid(page, { reason: 'Version 2, typed here' });
  const release = await lostSaveThenHeldRetry(page, context);
  const history = page.locator('.decision-card__meta a[href$="/history"]');
  await history.focus();
  await expect(history).toBeFocused();
  const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/decisions'));
  await context.setOffline(false);
  await sent;
  await expect(page.locator('.decision-card__meta a')).toHaveCount(0);
  await expect(page.locator('.decision-card__meta [data-link-held]').first()).toBeVisible();
  await expect(page.locator('.decision-save-bar')).toBeFocused();
  release();
  await expect(saveStatus(page)).toHaveText(/as version 2\./, { timeout: 20_000 });
  await expect(page.locator('.decision-card__meta a[href$="/history"]').first()).toBeVisible();
});

test('R6-1: with the kept-evidence box shown on the frame a draft is restored, wide, the Done radio and the Reason box are drawn', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await actAsSeat(page, 'admin'); await openQuestionIn(page, Q); await fillValid(page);
  // Upload without saving: the draft then holds the file's id; after a reload the evidence block cannot name it, so the form shows the kept card.
  const reply = page.waitForResponse((r) => r.request().method() === 'POST' && /\/evidence$/.test(new URL(r.url()).pathname));
  await page.locator('input[type="file"]').setInputFiles({ name: 'kept-r6.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nkept r6\n') });
  expect((await reply).status()).toBe(201);
  await expect(page.getByText(/^Uploaded kept-r6\.pdf /)).toBeVisible();
  await draftHolds(page, '"evidenceIds":["'); // the draft write is debounced: wait for the draft in storage
  await page.reload(); await waitForQuestionPage(page);
  await expect(page.locator('[data-kept-evidence]')).toBeVisible();
  expect((await page.locator('.decision-fields').boundingBox())?.height ?? 0, 'the size container is laid out').toBeGreaterThan(0);
  const done = await page.getByRole('radio', { name: 'Done', exact: true }).boundingBox();
  const reason = await page.getByLabel(`${F.fields.reason} ${FIELD_COPY.required}`, { exact: true }).boundingBox();
  expect(done?.height ?? 0, 'Done radio is drawn').toBeGreaterThan(0);
  expect(reason?.height ?? 0, 'Reason box is drawn').toBeGreaterThan(0);
});

test('M-r7-1: with the "not uploaded before the page closed" line shown on the frame a draft is restored, wide, the Done radio and the Reason box are drawn', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await actAsSeat(page, 'admin'); await openQuestionIn(page, Q); await fillValid(page);
  // Hold the upload open so the draft names the file as still moving when the page reloads (M-18).
  await page.route(/\/evidence$/, () => { /* never answered */ });
  await page.locator('input[type="file"]').setInputFiles({ name: 'mid-r7.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nmid r7\n') });
  await expect(page.getByText(/^Uploading mid-r7\.pdf/)).toBeVisible();
  await draftHolds(page, '"notUploaded":["');
  // The route stays until the reload has replaced the page, which cuts the held request off (M-18 in evidence-block.spec.ts
  // also reloads mid-upload and never unroutes): an unroute here released it to the server, and its 201 could reach the old
  // page first, which then named the file as uploaded.
  await page.reload(); await waitForQuestionPage(page);
  await expect(page.getByText('mid-r7.pdf was not uploaded before the page closed. Choose the file again.')).toBeVisible();
  expect((await page.locator('.decision-fields').boundingBox())?.height ?? 0, 'the size container is laid out').toBeGreaterThan(0);
  const done = await page.getByRole('radio', { name: 'Done', exact: true }).boundingBox();
  const reason = await page.getByLabel(`${F.fields.reason} ${FIELD_COPY.required}`, { exact: true }).boundingBox();
  expect(done?.height ?? 0, 'Done radio is drawn').toBeGreaterThan(0);
  expect(reason?.height ?? 0, 'Reason box is drawn').toBeGreaterThan(0);
});
