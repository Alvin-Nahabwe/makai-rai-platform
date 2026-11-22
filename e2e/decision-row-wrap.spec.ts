import { expect, test } from '@playwright/test';
import { actAsSeat, openQuestionIn } from './helpers/session';

/**
 * Design finish review M2 (DecisionFields.css): Decided by sits beside Decided on only when the decision fields are 42rem
 * or wider, and the two stack below that; the row never overflows. The row wraps by its own width (D-419), so this holds
 * at every window width, not at measured ones: the case walks the widths every 8 px from 320 to 1600.
 */
test('M2 D-419: Decided by sits beside Decided on exactly when the fields are 42rem or wider, and never overflows', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/login');
  await actAsSeat(page, 'admin');
  await openQuestionIn(page, 'Q-PP-01');
  await expect(page.locator('.decision-fields__row > .ui-date')).toBeVisible();
  const wrong: string[] = [];
  let beside = 0;
  for (let width = 320; width <= 1600; width += 8) {
    await page.setViewportSize({ width, height: 900 });
    const m = await page.evaluate(() => new Promise<{ fields: number; rem: number; beside: boolean; overflow: boolean }>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const row = document.querySelector('.decision-fields__row') as HTMLElement;
        const by = row.querySelector(':scope > .ui-field')!.getBoundingClientRect();
        const on = row.querySelector(':scope > .ui-date')!.getBoundingClientRect();
        resolve({
          fields: document.querySelector('.decision-fields')!.getBoundingClientRect().width,
          rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
          beside: Math.abs(by.top - on.top) < 1,
          overflow: row.scrollWidth > row.clientWidth + 1,
        });
      }));
    }));
    if (m.beside) beside++;
    // A width within half a pixel of 42rem could round either way, so it proves nothing; every other width must agree.
    if (Math.abs(m.fields - 42 * m.rem) < 0.5 && !m.overflow) continue;
    if (m.beside !== m.fields >= 42 * m.rem || m.overflow) wrong.push(`${width}px: fields ${m.fields.toFixed(1)}px, beside ${m.beside}, overflow ${m.overflow}`);
  }
  expect(wrong).toEqual([]);
  // Both layouts were reached, so the walk tested the switch and not one side of it.
  expect(beside).toBeGreaterThan(0);
  expect(beside).toBeLessThan((1600 - 320) / 8 + 1);
});
