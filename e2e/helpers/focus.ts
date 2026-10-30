import type { Page } from '@playwright/test';

/**
 * NFR-A11Y-02, WCAG 2.2 SC 2.4.7 (Focus Visible) and SC 2.4.11 (Focus Not Obscured): the element that
 * has focus now
 *   - shows a focus indicator: a computed outline whose style is not `none` and whose width is at
 *     least 2 px, or a box shadow that is not `none`;
 *   - lies inside the viewport; and
 *   - is not covered: `document.elementFromPoint` at the centre of its box returns the element or
 *     something inside it, so a sticky header or a save bar over it is caught.
 * The caller moves focus first (a `Tab` press, or `locator.focus()`); this only inspects. The failure
 * says which of the three failed and describes the element by tag, id and name, never by its text.
 */
export async function expectFocusVisibleAndUncovered(page: Page): Promise<void> {
  const problem = await page.evaluate((): string | null => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return 'nothing is focused';
    const name = el.getAttribute('name');
    const what = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${name ? `[name=${name}]` : ''}`;

    const cs = getComputedStyle(el);
    const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2;
    const shadow = cs.boxShadow !== 'none';
    if (!outline && !shadow) {
      return `${what} has no focus indicator (outline ${cs.outlineStyle} ${cs.outlineWidth}, box-shadow ${cs.boxShadow})`;
    }

    const r = el.getBoundingClientRect();
    const slack = 0.5;
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    if (r.left < -slack || r.top < -slack || r.right > width + slack || r.bottom > height + slack) {
      return `${what} is not inside the viewport (box ${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)} in ${width}x${height})`;
    }

    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !(hit === el || el.contains(hit))) {
      const over = hit ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ''}` : 'nothing';
      return `${what} is covered by ${over} at the centre of its box`;
    }
    return null;
  });
  if (problem) throw new Error(`focus check on ${page.url()}: ${problem}`);
}
