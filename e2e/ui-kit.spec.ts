import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, settleHover } from './helpers/a11y';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { expectTargetsAtLeast24px } from './helpers/targetSize';

/**
 * The development gallery /dev/ui-kit (plan 1A Task 3): every components/ui component in every state, driven in a
 * real browser. The page is served because Playwright's server sets MAKRAI_TEST_SEAMS=1 (lib/ui/devGallery.ts);
 * its 404 in production is unit-tested in __tests__/unit/ui/dev-gallery.test.tsx.
 *
 * Page-level helpers come first, for every component's cases: a later task adds one `test.describe` per component.
 */

const KIT = '/dev/ui-kit';
const THEMES = ['light', 'dark'] as const;
const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 375, height: 812 },
  { width: 320, height: 640 },
] as const;

/** Opens the gallery and waits until it has hydrated (the saved demo's button reacts only then). */
async function openKit(page: Page): Promise<void> {
  const response = await page.goto(KIT);
  expect(response?.status(), `${KIT} status`).toBe(200);
  await page.waitForLoadState('networkidle');
}

/** Runs `check` in each theme, by the operating system's preference the tokens follow (app/globals.css). */
async function inEachTheme(page: Page, check: (theme: (typeof THEMES)[number]) => Promise<void>): Promise<void> {
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    await check(theme);
  }
}

/** Runs `check` with forced colours on (Windows high contrast), then turns them off again. */
async function withForcedColors(page: Page, check: () => Promise<void>): Promise<void> {
  await page.emulateMedia({ forcedColors: 'active' });
  try {
    await check();
  } finally {
    await page.emulateMedia({ forcedColors: 'none' });
  }
}

/** A kit section by its id (`data-kit-section`). */
const section = (page: Page, id: string) => page.locator(`[data-kit-section="${id}"]`);

/**
 * The drawn shapes inside `selector` whose paint is missing or equals the page background: each shape's computed stroke
 * when it has one, else its fill (a <line> has a default black fill it never paints), against the body's background.
 */
async function shapesVisible(page: Page, selector: string): Promise<{ count: number; invisible: string[] }> {
  return page.evaluate((sel) => {
    const ground = getComputedStyle(document.body).backgroundColor;
    const invisible: string[] = [];
    const shapes = Array.from(document.querySelectorAll(`${sel} svg *`));
    for (const shape of shapes) {
      const style = getComputedStyle(shape);
      const paint = style.stroke !== 'none' ? style.stroke : style.fill;
      if (paint === 'none' || paint === ground || paint === 'rgba(0, 0, 0, 0)') invisible.push(`${shape.tagName} ${paint}`);
    }
    return { count: shapes.length, invisible };
  }, selector);
}

test.describe('the gallery page', () => {
  test('answers 200 and shows its heading', async ({ page }) => {
    await openKit(page);
    await expect(page.getByRole('heading', { level: 1, name: 'UI kit' })).toBeVisible();
    await expect(page.getByRole('main')).toHaveCount(1);
  });

  test('has no serious accessibility violation in either theme, at each width, and never scrolls sideways', async ({ page }) => {
    await openKit(page);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await inEachTheme(page, async (theme) => {
        await expectNoSeriousA11yViolations(page, `${KIT}, ${theme}, ${viewport.width} px`);
        await expectNoHorizontalScroll(page);
      });
    }
  });

  test('every pointer target is at least 24 by 24', async ({ page }) => {
    await openKit(page);
    await expectTargetsAtLeast24px(page);
  });
});

test.describe('Icon', () => {
  test('all 28 icons draw, hidden from assistive technology, beside their names', async ({ page }) => {
    await openKit(page);
    const icons = section(page, 'icons').locator('[data-icon] svg.ui-icon');
    await expect(icons).toHaveCount(28);
    for (const svg of await icons.all()) {
      await expect(svg).toHaveAttribute('aria-hidden', 'true');
      const box = await svg.boundingBox();
      expect(box?.width).toBe(20);
    }
  });
});

test.describe('StatusMark', () => {
  test('marks draw at 16, 20 and 24 px, every kind', async ({ page }) => {
    await openKit(page);
    for (const size of [16, 20, 24]) {
      const shapes = section(page, 'status-marks').locator(`table:has(caption:text-is("Every kind at ${size} px")) .ui-mark__shape`);
      await expect(shapes).toHaveCount(7);
      for (const shape of await shapes.all()) {
        const box = await shape.boundingBox();
        expect(box?.width, `mark at ${size} px`).toBe(size);
        expect(box?.height, `mark at ${size} px`).toBe(size);
      }
    }
  });

  test('marks are painted in ink in both themes and stay visible in forced colours', async ({ page }) => {
    await openKit(page);
    await inEachTheme(page, async (theme) => {
      const painted = await shapesVisible(page, '[data-kit-section="status-marks"] .ui-mark');
      expect(painted.count, theme).toBeGreaterThan(20);
      expect(painted.invisible, theme).toEqual([]);
    });
    await withForcedColors(page, async () => {
      const painted = await shapesVisible(page, '[data-kit-section="status-marks"] .ui-mark');
      expect(painted.invisible, 'forced colours').toEqual([]);
      await expect(section(page, 'status-marks').getByText('Done, no evidence attached')).toBeVisible();
    });
  });
});

test.describe('RouteRow', () => {
  test('22 stops wrap at 320 px with no horizontal scroll, one current, then the tally', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openKit(page);
    const row = page.getByRole('list', { name: 'Sample stage', exact: true });
    const stops = row.locator('.ui-route-row__stop');
    await expect(stops).toHaveCount(22);
    const tops = new Set(await stops.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top))));
    expect(tops.size, 'rows the 22 stops wrap onto').toBeGreaterThan(1);
    await expectNoHorizontalScroll(page);
    await expect(row.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(row.getByRole('link', { name: 'Sample question 4: Not yet' })).toHaveAttribute('aria-current', 'step');
    await expect(section(page, 'route-row').locator('.ui-route-row__tally').first()).toHaveText(/^\d+ done \(2 with no evidence attached\), /);
  });

  test('the row shows no progress bar, meter or percentage', async ({ page }) => {
    await openKit(page);
    const routeRow = section(page, 'route-row');
    await expect(routeRow.locator('progress, [role="progressbar"], [role="meter"]')).toHaveCount(0);
    expect(await routeRow.innerText()).not.toMatch(/%/);
  });
});

test.describe('SavedMark', () => {
  test.use({ timezoneId: 'Africa/Nairobi' });

  test('the saved region announces: its text changes after "Simulate save", in the reader\'s time zone', async ({ page }) => {
    await openKit(page);
    const region = section(page, 'saved-mark').getByRole('status');
    await expect(region).toHaveCount(1);
    await expect(region).toHaveAttribute('aria-live', 'polite');
    await expect(region).toHaveText('');
    await page.getByRole('button', { name: 'Simulate save' }).click();
    await expect(region).toContainText('Saved as version 1');
    await expect(region).toContainText('Decided on 11 Feb 2026 · Saved 11 Nov 2026, 11:23');
    await expect(region).not.toContainText('kept in the history');
    await page.getByRole('button', { name: 'Simulate save' }).click();
    await expect(region).toContainText('Saved as version 2');
    await expect(region).toContainText('This decision is saved on the platform. Version 1 is kept in the history.');
    await settleHover(page);
    await inEachTheme(page, (theme) => expectNoSeriousA11yViolations(page, `${KIT} saved mark after a save, ${theme}`));
  });

  test('the saved mark stays visible in forced colours', async ({ page }) => {
    await openKit(page);
    await page.getByRole('button', { name: 'Simulate save' }).click();
    await withForcedColors(page, async () => {
      const region = section(page, 'saved-mark').getByRole('status');
      await expect(region.getByText('Saved as version 1')).toBeVisible();
      const painted = await shapesVisible(page, '[data-kit-section="saved-mark"] .ui-saved__shape');
      expect(painted.count).toBeGreaterThan(0);
      expect(painted.invisible).toEqual([]);
    });
  });
});
