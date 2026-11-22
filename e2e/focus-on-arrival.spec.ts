import { expect, test, type Page } from '@playwright/test';
import { actAsSeat, openQuestionIn } from './helpers/session';

/**
 * UX-42 (FocusOnArrival): on arriving at a question its heading takes focus. On a fresh load the page starts at its top,
 * so the focus does not scroll, and a person who scrolled before the page's effects ran stays where they are (the D23
 * race). Every other arrival scrolls: after Next or a link the page frame keeps its scroll (it lives in the root layout;
 * measured with preventScroll, the frame stayed at 1076 px and the heading was off screen), and after a reload or
 * back/forward the browser may have restored an old scroll (the owner's choice: the heading is scrolled into view).
 */

/** Records, for every focus() on the question's heading, whether it was asked not to scroll. */
async function recordHeadingFocus(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: boolean[] = [];
    (window as unknown as { headingFocus: boolean[] }).headingFocus = calls;
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (options?: FocusOptions) {
      if (this.id === 'question-heading') calls.push(options?.preventScroll === true);
      focus.call(this, options);
    };
  });
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { headingFocus: boolean[] }).headingFocus);

/** The frame scrolls from 1024 px (shell.css); below, the window does. */
async function scrollToFoot(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frame = document.querySelector('.page-frame') as HTMLElement;
    if (getComputedStyle(frame).overflowY === 'auto') frame.scrollTop = frame.scrollHeight;
    else window.scrollTo(0, document.documentElement.scrollHeight);
  });
}

async function headingInView(page: Page): Promise<boolean> {
  return page.locator('#question-heading').evaluate((h) => {
    const r = h.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  });
}

for (const size of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
  test(`UX-42: at ${size.width} px, on a fresh load the question's heading takes focus without scrolling the page`, async ({ page }) => {
  await recordHeadingFocus(page);
  await page.setViewportSize(size);
  await page.goto('/login');
  await actAsSeat(page, 'admin');
  await openQuestionIn(page, 'Q-PP-01');
  await expect(page.locator('#question-heading')).toBeFocused();
  // React Strict Mode runs the effect twice in development, so there may be two calls; each asks not to scroll.
  const made = await calls(page);
  expect(made.length, 'the heading was focused').toBeGreaterThan(0);
  expect(made.every(Boolean), 'every first-load focus asks not to scroll').toBe(true);
  expect(await headingInView(page), 'the page starts at its top, so the heading is in view').toBe(true);
  });
}

test('UX-42: on a reload the heading takes focus and is scrolled into view', async ({ page }) => {
  await recordHeadingFocus(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/login');
  await actAsSeat(page, 'admin');
  await openQuestionIn(page, 'Q-PP-01');
  await expect(page.locator('#question-heading')).toBeFocused();
  await scrollToFoot(page);
  await page.reload();
  await expect(page.locator('#question-heading')).toBeFocused();
  const made = await calls(page);
  expect(made.length, 'the heading was focused').toBeGreaterThan(0);
  expect(made.some(Boolean), 'a reload may restore an old scroll, so the focus scrolls (owner, 22 Nov 2026)').toBe(false);
  await expect.poll(() => headingInView(page), 'the heading is in view').toBe(true);
});

for (const size of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
  test(`UX-42: at ${size.width} px, after Next and after going back the heading takes focus and is in view`, async ({ page }) => {
    await recordHeadingFocus(page);
    await page.setViewportSize(size);
    await page.goto('/login');
    await actAsSeat(page, 'admin');
    await openQuestionIn(page, 'Q-PP-01');
    await expect(page.locator('#question-heading')).toBeFocused();
    const firstLoad = (await calls(page)).length;

    // Next (from 1160 px the top strip's link reads "Next: …", below it the strip's "Next question: …"), then back to
    // question 1 by its link in the stage's list of questions, which is there at every width.
    const steps = [
      { name: 'Next', link: page.getByRole('link', { name: /^Next\b/ }) },
      { name: 'back to question 1', link: page.locator('main a[href$="/questions/Q-PP-01"]') },
    ];
    for (const { name, link } of steps) {
      await scrollToFoot(page);
      const from = page.url();
      await link.filter({ visible: true }).first().click();
      await page.waitForURL((u) => u.toString() !== from);
      await expect(page.locator('#question-heading')).toBeFocused();
      const made = await calls(page);
      expect(made.at(-1), `${name}: this focus may scroll`).toBe(false);
      await expect.poll(() => headingInView(page), `${name}: the new question's heading is in view`).toBe(true);
    }
    const made = await calls(page);
    expect(made.slice(0, firstLoad).every(Boolean), 'the first load asked not to scroll').toBe(true);
    expect(made.slice(firstLoad).some(Boolean), 'no later arrival asked not to scroll, back on question 1 included').toBe(false);
  });
}

test('UX-42: arriving from the stage page by a link, the heading takes focus and is in view', async ({ page }) => {
  await recordHeadingFocus(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/login');
  await actAsSeat(page, 'admin');
  await openQuestionIn(page, 'Q-PP-01');
  // The stage page, loaded as the document, then a question reached from it by a client-side link.
  await page.goto(new URL(page.url()).pathname.replace(/\/questions\/[^/]+$/, ''));
  const links = page.locator('main a[href*="/questions/"]').filter({ visible: true });
  await expect(links.first()).toBeVisible();
  await scrollToFoot(page);
  const from = page.url();
  await links.last().click();
  await page.waitForURL((u) => u.toString() !== from);
  await expect(page.locator('#question-heading')).toBeFocused();
  const made = await calls(page);
  expect(made.length, 'the heading was focused').toBeGreaterThan(0);
  expect(made.some(Boolean), 'reached by a link, the focus may scroll').toBe(false);
  await expect.poll(() => headingInView(page), 'the heading is in view').toBe(true);
});
