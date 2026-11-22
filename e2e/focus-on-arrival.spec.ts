import { expect, test, type Page } from '@playwright/test';
import { actAsSeat, openQuestionIn } from './helpers/session';

/**
 * UX-42 (FocusOnArrival): on arriving at a question its heading takes focus. On the document's first load the page is
 * already at its top, so the focus does not scroll, and a person who scrolled before the page's effects ran stays where
 * they are (the D23 race). After Next or Previous the page frame keeps its scroll (it lives in the root layout), so there
 * the focus does scroll, and that is what brings the new question's heading into view (measured: with preventScroll the
 * frame stayed at 1076 px and the heading was off screen).
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

test('UX-42: on first load the question\'s heading takes focus without scrolling the page', async ({ page }) => {
  await recordHeadingFocus(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/login');
  await actAsSeat(page, 'admin');
  await openQuestionIn(page, 'Q-PP-01');
  await expect(page.locator('#question-heading')).toBeFocused();
  expect(await calls(page), 'the first focus asks not to scroll').toEqual([true]);
});

for (const size of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
  test(`UX-42: at ${size.width} px, after Next and after going back the heading takes focus and is in view`, async ({ page }) => {
    await recordHeadingFocus(page);
    await page.setViewportSize(size);
    await page.goto('/login');
    await actAsSeat(page, 'admin');
    await openQuestionIn(page, 'Q-PP-01');
    await expect(page.locator('#question-heading')).toBeFocused();

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
    expect(await calls(page), 'one focus per arrival: the first load, Next, back to question 1').toEqual([true, false, false]);
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
  expect(await calls(page), 'reached by a link, the focus may scroll').toEqual([false]);
  await expect.poll(() => headingInView(page), 'the heading is in view').toBe(true);
});
