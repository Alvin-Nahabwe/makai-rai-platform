import { expect, type Page } from '@playwright/test';

/**
 * UX-35, NFR-A11Y-05 (SC 1.4.10 reflow): the page needs no horizontal scrolling
 * at the viewport it is in. Set the viewport first, for the specified check
 * 320 by 640: `await page.setViewportSize({ width: 320, height: 640 })`.
 *
 * `scrollWidth` counts content that overflows to the right even when
 * `overflow-x: hidden` stops the scroll bar from showing (app/globals.css sets it
 * on html), so a hidden overflow is still reported: hiding it would lose content,
 * which is what the criterion is about. A full fingerprint wraps instead of
 * scrolling (UX-35), so the page itself has no exception here.
 */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, clientWidth, widest } = await page.evaluate(() => {
    const root = document.documentElement;
    let widest = '';
    let widestRight = 0;
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const right = el.getBoundingClientRect().right;
      if (right > widestRight) {
        widestRight = right;
        widest = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
      }
    }
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, widest };
  });
  expect(
    scrollWidth,
    `${page.url()}: scrollWidth ${scrollWidth} is wider than clientWidth ${clientWidth}; the element reaching furthest right is ${widest}`,
  ).toBeLessThanOrEqual(clientWidth);
}
